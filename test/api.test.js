const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { crearApp, bloquesDelDia } = require('../server');

const dbFile = path.join(__dirname, '..', 'data', `test-${process.pid}.json`);
let server;
let base;

// Próxima fecha (a partir de mañana) que cae en el día de la semana indicado.
function proximo(dia) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== dia) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function api(metodo, ruta, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + ruta, { method: metodo, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

async function login(email, password) {
  return (await api('POST', '/api/login', { body: { email, password } })).data.token;
}

test.before(async () => {
  fs.rmSync(dbFile, { force: true });
  server = crearApp({ dbFile });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dbFile, { force: true });
});

test('genera bloques según el horario del médico', () => {
  const medico = { horario: { dias: [1], inicio: '08:00', fin: '10:00', duracion: 30 } };
  assert.deepStrictEqual(bloquesDelDia(medico, proximo(1)), ['08:00', '08:30', '09:00', '09:30']);
  assert.deepStrictEqual(bloquesDelDia(medico, proximo(2)), []);
});

test('flujo completo: registro, agendar, ver, reprogramar, atender y eliminar', async () => {
  const reg = await api('POST', '/api/registro', {
    body: { nombre: 'Ana Pérez', email: 'ana@correo.com', password: 'secreta1', cedula: '0912345678' },
  });
  assert.strictEqual(reg.status, 201);
  const tPac = reg.data.token;

  const lunes = proximo(1);
  const medicos = await api('GET', `/api/medicos?especialidad=Cardiología&fecha=${lunes}`, { token: tPac });
  assert.strictEqual(medicos.status, 200);
  const cardio = medicos.data[0];
  assert.ok(cardio.atiende && cardio.libres > 0);

  const cita = await api('POST', '/api/citas', {
    token: tPac,
    body: { medicoId: cardio.id, fecha: lunes, hora: '09:00', motivo: 'Control' },
  });
  assert.strictEqual(cita.status, 201);
  assert.strictEqual(cita.data.estado, 'pendiente');

  // El mismo horario ya no está libre para otro paciente
  const tDemo = await login('paciente@demo.com', 'paciente123');
  const dup = await api('POST', '/api/citas', { token: tDemo, body: { medicoId: cardio.id, fecha: lunes, hora: '09:00' } });
  assert.strictEqual(dup.status, 409);
  const disp = await api('GET', `/api/medicos/${cardio.id}/disponibilidad?fecha=${lunes}`, { token: tDemo });
  assert.strictEqual(disp.data.horas.find((h) => h.hora === '09:00').libre, false);

  // Día en que el médico no atiende
  const martes = await api('POST', '/api/citas', { token: tDemo, body: { medicoId: cardio.id, fecha: proximo(2), hora: '09:00' } });
  assert.strictEqual(martes.status, 400);

  // El médico ve la cita pendiente
  const tMed = await login('candrade@portoazul.com', 'medico123');
  const pend = await api('GET', '/api/citas?estado=pendiente', { token: tMed });
  assert.strictEqual(pend.data.length, 1);
  assert.strictEqual(pend.data[0].paciente.nombre, 'Ana Pérez');

  // Un médico no puede agendar; un paciente no puede marcar atendida
  assert.strictEqual((await api('POST', '/api/citas', { token: tMed, body: {} })).status, 403);
  const id = cita.data.id;
  assert.strictEqual((await api('PATCH', `/api/citas/${id}/estado`, { token: tPac, body: { estado: 'atendida' } })).status, 403);
  // Otro paciente no ve ni toca la cita ajena
  assert.strictEqual((await api('DELETE', `/api/citas/${id}`, { token: tDemo })).status, 404);

  // Reprogramar
  const rep = await api('PUT', `/api/citas/${id}`, { token: tPac, body: { fecha: lunes, hora: '10:30' } });
  assert.strictEqual(rep.status, 200);
  assert.strictEqual(rep.data.hora, '10:30');

  // Médico la marca atendida
  const at = await api('PATCH', `/api/citas/${id}/estado`, { token: tMed, body: { estado: 'atendida', nota: 'Todo bien' } });
  assert.strictEqual(at.data.estado, 'atendida');
  assert.strictEqual((await api('GET', '/api/citas?estado=pendiente', { token: tMed })).data.length, 0);

  // Paciente la elimina de su historial
  assert.strictEqual((await api('DELETE', `/api/citas/${id}`, { token: tPac })).status, 200);
  assert.strictEqual((await api('GET', '/api/citas', { token: tPac })).data.length, 0);
});

test('paciente cancela y el horario vuelve a quedar libre', async () => {
  const tPac = await login('paciente@demo.com', 'paciente123');
  const lunes = proximo(1);
  const medicos = await api('GET', `/api/medicos?especialidad=Medicina General&fecha=${lunes}`, { token: tPac });
  const m = medicos.data[0];
  const cita = await api('POST', '/api/citas', { token: tPac, body: { medicoId: m.id, fecha: lunes, hora: '08:00' } });
  assert.strictEqual(cita.status, 201);
  const canc = await api('PATCH', `/api/citas/${cita.data.id}/estado`, { token: tPac, body: { estado: 'cancelada' } });
  assert.strictEqual(canc.data.estado, 'cancelada');
  const disp = await api('GET', `/api/medicos/${m.id}/disponibilidad?fecha=${lunes}`, { token: tPac });
  assert.strictEqual(disp.data.horas.find((h) => h.hora === '08:00').libre, true);
});

test('el médico cambia su horario', async () => {
  const tMed = await login('mleon@portoazul.com', 'medico123');
  const r = await api('PUT', '/api/medico/horario', { token: tMed, body: { dias: [6], inicio: '09:00', fin: '11:00', duracion: 60 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.horario, { dias: [6], inicio: '09:00', fin: '11:00', duracion: 60 });
  const tPac = await login('paciente@demo.com', 'paciente123');
  const disp = await api('GET', `/api/medicos/${r.data.id}/disponibilidad?fecha=${proximo(6)}`, { token: tPac });
  assert.deepStrictEqual(disp.data.horas.map((h) => h.hora), ['09:00', '10:00']);
});

test('requiere sesión y rechaza credenciales incorrectas', async () => {
  assert.strictEqual((await api('GET', '/api/citas')).status, 401);
  assert.strictEqual((await api('POST', '/api/login', { body: { email: 'paciente@demo.com', password: 'mal' } })).status, 401);
});
