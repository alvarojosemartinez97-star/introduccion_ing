// Servidor de la plataforma de citas médicas - Clínica Porto Azul.
// Solo usa módulos nativos de Node.js: ejecutar con `npm start`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database, hashPassword, verifyPassword } = require('./lib/db');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const ESTADOS = ['pendiente', 'atendida', 'cancelada'];
const SESION_MS = 8 * 60 * 60 * 1000; // la sesión vence a las 8 horas
const MAX_INTENTOS = 5; // intentos fallidos de inicio de sesión antes de bloquear
const BLOQUEO_MS = 15 * 60 * 1000; // tiempo de bloqueo tras superar los intentos

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- utilidades de fechas y horarios ----------

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function aMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

function aHora(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function fechaValida(fecha) {
  if (!FECHA_RE.test(fecha || '')) return false;
  const d = new Date(`${fecha}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha;
}

function diaSemana(fecha) {
  return new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo
}

function esFuturo(fecha, hora, ahora = new Date()) {
  return new Date(`${fecha}T${hora}:00`) > ahora;
}

function bloquesDelDia(medico, fecha) {
  const h = medico.horario;
  if (!h || !h.dias.includes(diaSemana(fecha))) return [];
  const bloques = [];
  for (let t = aMinutos(h.inicio); t + h.duracion <= aMinutos(h.fin); t += h.duracion) {
    bloques.push(aHora(t));
  }
  return bloques;
}

// ---------- aplicación ----------

function crearApp({ dbFile = path.join(__dirname, 'data', 'db.json'), reloj = () => Date.now() } = {}) {
  const db = new Database(dbFile);
  const sesiones = new Map(); // token -> { id, expira }
  const intentos = new Map(); // correo -> { fallos, bloqueadoHasta }
  // Métricas de eficiencia: tiempo de respuesta y tasa de errores de la API
  const metricas = { solicitudes: 0, fallidas: 0, erroresServidor: 0, tiempoTotalMs: 0, tiempoMaxMs: 0, bytesEnviados: 0 };
  const inicioServidor = { cpu: process.cpuUsage(), tiempo: process.hrtime.bigint() };

  function crearSesion(usuario) {
    const token = crypto.randomBytes(24).toString('hex');
    sesiones.set(token, { id: usuario.id, expira: reloj() + SESION_MS });
    return token;
  }

  function usuarioDeToken(token) {
    const sesion = sesiones.get(token);
    if (!sesion) return null;
    if (sesion.expira <= reloj()) {
      sesiones.delete(token);
      return null;
    }
    return buscarUsuario(sesion.id);
  }

  const buscarUsuario = (id) => db.usuarios.find((u) => u.id === id);

  function publico(u) {
    const { salt, hash, ...resto } = u;
    return resto;
  }

  function ocupadas(medicoId, fecha, ignorarCitaId) {
    return new Set(
      db.citas
        .filter((c) => c.medicoId === medicoId && c.fecha === fecha && c.estado === 'pendiente' && c.id !== ignorarCitaId)
        .map((c) => c.hora)
    );
  }

  function disponibilidad(medico, fecha, ignorarCitaId) {
    const tomadas = ocupadas(medico.id, fecha, ignorarCitaId);
    return bloquesDelDia(medico, fecha).map((hora) => ({
      hora,
      libre: !tomadas.has(hora) && esFuturo(fecha, hora),
    }));
  }

  function validarHorarioCita(medico, fecha, hora, ignorarCitaId) {
    if (!fechaValida(fecha)) throw new HttpError(400, 'Fecha inválida (formato AAAA-MM-DD).');
    if (!HORA_RE.test(hora || '')) throw new HttpError(400, 'Hora inválida (formato HH:MM).');
    if (!esFuturo(fecha, hora)) throw new HttpError(400, 'La cita debe ser en una fecha y hora futura.');
    if (!bloquesDelDia(medico, fecha).includes(hora)) {
      throw new HttpError(400, 'El médico no atiende en ese día u horario.');
    }
    if (ocupadas(medico.id, fecha, ignorarCitaId).has(hora)) {
      throw new HttpError(409, 'Ese horario ya está reservado. Elija otro.');
    }
  }

  function detalleCita(c) {
    const medico = buscarUsuario(c.medicoId);
    const paciente = buscarUsuario(c.pacienteId);
    return {
      ...c,
      medico: medico && { id: medico.id, nombre: medico.nombre, especialidad: medico.especialidad },
      paciente: paciente && {
        id: paciente.id,
        nombre: paciente.nombre,
        email: paciente.email,
        cedula: paciente.cedula,
        telefono: paciente.telefono,
      },
    };
  }

  function ordenarCitas(a, b) {
    return `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`);
  }

  function requerir(usuario, rol) {
    if (!usuario) throw new HttpError(401, 'Debe iniciar sesión.');
    if (rol && usuario.rol !== rol) throw new HttpError(403, 'No tiene permiso para esta acción.');
    return usuario;
  }

  function citaPropia(usuario, id) {
    const cita = db.citas.find((c) => c.id === Number(id));
    const propia = cita && (usuario.rol === 'paciente' ? cita.pacienteId === usuario.id : cita.medicoId === usuario.id);
    if (!propia) throw new HttpError(404, 'Cita no encontrada.');
    return cita;
  }

  // Tabla de rutas: [método, patrón, manejador]
  const rutas = [
    ['POST', /^\/api\/registro$/, ({ body }) => {
      const nombre = (body.nombre || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const { password, cedula = '', telefono = '' } = body;
      if (!nombre || !email || !password) throw new HttpError(400, 'Nombre, correo y contraseña son obligatorios.');
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Correo electrónico inválido.');
      if (String(password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres.');
      if (db.usuarios.some((u) => u.email === email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
      const { salt, hash } = hashPassword(String(password));
      const usuario = { id: db.nextId(), rol: 'paciente', nombre, email, cedula: String(cedula).trim(), telefono: String(telefono).trim(), salt, hash };
      db.usuarios.push(usuario);
      db.save();
      return [201, { token: crearSesion(usuario), usuario: publico(usuario) }];
    }],

    ['POST', /^\/api\/login$/, ({ body }) => {
      const email = (body.email || '').trim().toLowerCase();
      const registro = intentos.get(email) || { fallos: 0, bloqueadoHasta: 0 };
      if (registro.bloqueadoHasta > reloj()) {
        const minutos = Math.ceil((registro.bloqueadoHasta - reloj()) / 60000);
        throw new HttpError(429, `Demasiados intentos fallidos. Intente de nuevo en ${minutos} minuto(s).`);
      }
      const usuario = db.usuarios.find((u) => u.email === email);
      if (!usuario || !verifyPassword(String(body.password || ''), usuario.salt, usuario.hash)) {
        registro.fallos += 1;
        if (registro.fallos >= MAX_INTENTOS) {
          registro.fallos = 0;
          registro.bloqueadoHasta = reloj() + BLOQUEO_MS;
        }
        intentos.set(email, registro);
        throw new HttpError(401, 'Correo o contraseña incorrectos.');
      }
      intentos.delete(email);
      return [200, { token: crearSesion(usuario), usuario: publico(usuario) }];
    }],

    ['POST', /^\/api\/logout$/, ({ token }) => {
      sesiones.delete(token);
      return [200, { ok: true }];
    }],

    ['GET', /^\/api\/me$/, ({ usuario }) => [200, publico(requerir(usuario))]],

    // Indicadores de eficiencia (personal médico)
    ['GET', /^\/api\/metricas$/, ({ usuario }) => {
      requerir(usuario, 'medico');
      const { solicitudes, fallidas, erroresServidor, tiempoTotalMs, tiempoMaxMs } = metricas;
      const redondear = (n) => Math.round(n * 100) / 100;
      return [200, {
        solicitudes,
        fallidas,
        erroresServidor,
        tasaErrorPct: solicitudes ? redondear((fallidas / solicitudes) * 100) : 0,
        tiempoPromedioMs: solicitudes ? redondear(tiempoTotalMs / solicitudes) : 0,
        tiempoMaxMs: redondear(tiempoMaxMs),
        recursos: usoDeRecursos(),
      }];
    }],

    ['GET', /^\/api\/especialidades$/, () => {
      const lista = [...new Set(db.usuarios.filter((u) => u.rol === 'medico').map((u) => u.especialidad))].sort();
      return [200, lista];
    }],

    // Médicos disponibles (opcionalmente por especialidad y fecha)
    ['GET', /^\/api\/medicos$/, ({ usuario, query }) => {
      requerir(usuario);
      const { especialidad, fecha } = query;
      if (fecha && !fechaValida(fecha)) throw new HttpError(400, 'Fecha inválida.');
      let medicos = db.usuarios.filter((u) => u.rol === 'medico');
      if (especialidad) medicos = medicos.filter((m) => m.especialidad === especialidad);
      const lista = medicos.map((m) => {
        const item = { id: m.id, nombre: m.nombre, especialidad: m.especialidad, horario: m.horario };
        if (fecha) {
          const horas = disponibilidad(m, fecha);
          item.atiende = horas.length > 0;
          item.libres = horas.filter((h) => h.libre).length;
        }
        return item;
      });
      return [200, lista];
    }],

    ['GET', /^\/api\/medicos\/(\d+)\/disponibilidad$/, ({ usuario, params, query }) => {
      requerir(usuario);
      const medico = db.usuarios.find((u) => u.id === Number(params[0]) && u.rol === 'medico');
      if (!medico) throw new HttpError(404, 'Médico no encontrado.');
      if (!fechaValida(query.fecha)) throw new HttpError(400, 'Fecha inválida.');
      const ignorar = query.ignorar ? Number(query.ignorar) : undefined;
      return [200, { fecha: query.fecha, horas: disponibilidad(medico, query.fecha, ignorar) }];
    }],

    // El médico actualiza su horario de atención
    ['PUT', /^\/api\/medico\/horario$/, ({ usuario, body }) => {
      const medico = requerir(usuario, 'medico');
      const dias = Array.isArray(body.dias) ? [...new Set(body.dias.map(Number))].filter((d) => d >= 0 && d <= 6).sort() : [];
      const { inicio, fin } = body;
      const duracion = Number(body.duracion);
      if (!HORA_RE.test(inicio || '') || !HORA_RE.test(fin || '')) throw new HttpError(400, 'Horas inválidas.');
      if (aMinutos(fin) <= aMinutos(inicio)) throw new HttpError(400, 'La hora de fin debe ser posterior a la de inicio.');
      if (![15, 20, 30, 45, 60].includes(duracion)) throw new HttpError(400, 'Duración de cita inválida.');
      medico.horario = { dias, inicio, fin, duracion };
      db.save();
      return [200, publico(medico)];
    }],

    // Citas del usuario (paciente: las suyas; médico: las que tiene asignadas)
    ['GET', /^\/api\/citas$/, ({ usuario, query }) => {
      requerir(usuario);
      const campo = usuario.rol === 'paciente' ? 'pacienteId' : 'medicoId';
      let citas = db.citas.filter((c) => c[campo] === usuario.id);
      if (query.estado) citas = citas.filter((c) => c.estado === query.estado);
      if (query.fecha) citas = citas.filter((c) => c.fecha === query.fecha);
      return [200, citas.sort(ordenarCitas).map(detalleCita)];
    }],

    // Agendar cita (paciente)
    ['POST', /^\/api\/citas$/, ({ usuario, body }) => {
      const paciente = requerir(usuario, 'paciente');
      const medico = db.usuarios.find((u) => u.id === Number(body.medicoId) && u.rol === 'medico');
      if (!medico) throw new HttpError(404, 'Médico no encontrado.');
      validarHorarioCita(medico, body.fecha, body.hora);
      const choque = db.citas.some(
        (c) => c.pacienteId === paciente.id && c.estado === 'pendiente' && c.fecha === body.fecha && c.hora === body.hora
      );
      if (choque) throw new HttpError(409, 'Ya tiene otra cita a esa misma hora.');
      const cita = {
        id: db.nextId(),
        pacienteId: paciente.id,
        medicoId: medico.id,
        fecha: body.fecha,
        hora: body.hora,
        motivo: String(body.motivo || '').trim().slice(0, 500),
        estado: 'pendiente',
        creada: new Date().toISOString(),
      };
      db.citas.push(cita);
      db.save();
      return [201, detalleCita(cita)];
    }],

    // Reprogramar cita (paciente)
    ['PUT', /^\/api\/citas\/(\d+)$/, ({ usuario, params, body }) => {
      requerir(usuario, 'paciente');
      const cita = citaPropia(usuario, params[0]);
      if (cita.estado !== 'pendiente') throw new HttpError(400, 'Solo se pueden reprogramar citas pendientes.');
      const medico = buscarUsuario(cita.medicoId);
      validarHorarioCita(medico, body.fecha, body.hora, cita.id);
      cita.fecha = body.fecha;
      cita.hora = body.hora;
      if (body.motivo !== undefined) cita.motivo = String(body.motivo).trim().slice(0, 500);
      db.save();
      return [200, detalleCita(cita)];
    }],

    // Cambiar estado: el paciente puede cancelar; el médico puede marcar atendida o cancelar
    ['PATCH', /^\/api\/citas\/(\d+)\/estado$/, ({ usuario, params, body }) => {
      requerir(usuario);
      const cita = citaPropia(usuario, params[0]);
      const { estado } = body;
      if (!ESTADOS.includes(estado) || estado === 'pendiente') throw new HttpError(400, 'Estado inválido.');
      if (usuario.rol === 'paciente' && estado !== 'cancelada') throw new HttpError(403, 'Solo puede cancelar sus citas.');
      if (cita.estado !== 'pendiente') throw new HttpError(400, 'La cita ya no está pendiente.');
      cita.estado = estado;
      if (body.nota !== undefined) cita.nota = String(body.nota).trim().slice(0, 500);
      cita.actualizada = new Date().toISOString();
      db.save();
      return [200, detalleCita(cita)];
    }],

    // Eliminar cita del historial (paciente)
    ['DELETE', /^\/api\/citas\/(\d+)$/, ({ usuario, params }) => {
      requerir(usuario, 'paciente');
      const cita = citaPropia(usuario, params[0]);
      db.data.citas = db.citas.filter((c) => c.id !== cita.id);
      db.save();
      return [200, { ok: true }];
    }],
  ];

  async function leerBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 1e6) throw new HttpError(413, 'Solicitud demasiado grande.');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON inválido.');
    }
  }

  // Uso de recursos: CPU · RAM · disco · red
  function usoDeRecursos() {
    const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
    const cpu = process.cpuUsage(inicioServidor.cpu);
    const transcurridoUs = Number(process.hrtime.bigint() - inicioServidor.tiempo) / 1000;
    let discoKB = 0;
    try {
      discoKB = Math.round((fs.statSync(dbFile).size / 1024) * 10) / 10;
    } catch {
      discoKB = 0;
    }
    return {
      cpuPct: transcurridoUs ? Math.round(((cpu.user + cpu.system) / transcurridoUs) * 10000) / 100 : 0,
      memoriaMB: mb(process.memoryUsage().rss),
      discoKB,
      redKB: Math.round((metricas.bytesEnviados / 1024) * 10) / 10,
    };
  }

  function enviarJson(res, status, data) {
    const cabeceras = { 'Content-Type': 'application/json; charset=utf-8' };
    if (res.inicio) cabeceras['X-Response-Time'] = `${(Number(process.hrtime.bigint() - res.inicio) / 1e6).toFixed(2)}ms`;
    const cuerpo = JSON.stringify(data);
    metricas.bytesEnviados += Buffer.byteLength(cuerpo);
    res.writeHead(status, cabeceras);
    res.end(cuerpo);
  }

  function servirEstatico(res, pathname) {
    const relativo = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const archivo = path.normalize(path.join(PUBLIC_DIR, relativo));
    if (!archivo.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(archivo, (err, contenido) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(archivo)] || 'application/octet-stream' });
      res.end(contenido);
    });
  }

  async function manejar(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return enviarJson(res, 405, { error: 'Método no permitido.' });
      return servirEstatico(res, url.pathname);
    }
    // Tiempo de respuesta: T = t final − t inicial; tasa de errores: E = fallidas ÷ totales × 100
    res.inicio = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - res.inicio) / 1e6;
      metricas.solicitudes += 1;
      metricas.tiempoTotalMs += ms;
      metricas.tiempoMaxMs = Math.max(metricas.tiempoMaxMs, ms);
      if (res.statusCode >= 400) metricas.fallidas += 1;
      if (res.statusCode >= 500) metricas.erroresServidor += 1;
    });
    try {
      const ruta = rutas.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!ruta) throw new HttpError(404, 'Ruta no encontrada.');
      const params = url.pathname.match(ruta[1]).slice(1);
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const usuario = usuarioDeToken(token);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await leerBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const [status, data] = await ruta[2]({ req, usuario, token, params, query, body: body || {} });
      enviarJson(res, status, data);
    } catch (err) {
      if (err instanceof HttpError) return enviarJson(res, err.status, { error: err.message });
      console.error(err);
      enviarJson(res, 500, { error: 'Error interno del servidor.' });
    }
  }

  return http.createServer(manejar);
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  crearApp().listen(PORT, () => {
    console.log(`Clínica Porto Azul - citas médicas en http://localhost:${PORT}`);
  });
}

module.exports = { crearApp, bloquesDelDia, fechaValida };
