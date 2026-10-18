// Utilidades compartidas por todas las páginas.
const Api = {
  token() {
    return localStorage.getItem('token');
  },
  usuario() {
    try {
      return JSON.parse(localStorage.getItem('usuario'));
    } catch {
      return null;
    }
  },
  guardarSesion({ token, usuario }) {
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
  },
  limpiarSesion() {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
  },
  async pedir(metodo, ruta, body) {
    const opciones = { method: metodo, headers: {} };
    if (this.token()) opciones.headers.Authorization = `Bearer ${this.token()}`;
    if (body !== undefined) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(body);
    }
    const res = await fetch(ruta, opciones);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && ruta !== '/api/login') {
      this.limpiarSesion();
      location.href = '/';
    }
    if (!res.ok) throw new Error(data.error || 'Ocurrió un error.');
    return data;
  },
  get(ruta) { return this.pedir('GET', ruta); },
  post(ruta, body) { return this.pedir('POST', ruta, body); },
  put(ruta, body) { return this.pedir('PUT', ruta, body); },
  patch(ruta, body) { return this.pedir('PATCH', ruta, body); },
  del(ruta) { return this.pedir('DELETE', ruta); },
};

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function hoyISO(desplazamientoDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + desplazamientoDias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatoFecha(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function textoHorario(h) {
  if (!h || !h.dias.length) return 'Sin horario de atención';
  return `${h.dias.map((d) => DIAS_CORTOS[d]).join(', ')} · ${h.inicio}–${h.fin}`;
}

function mostrarMensaje(el, texto, tipo = 'ok') {
  el.textContent = texto;
  el.className = `mensaje ${tipo}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('oculto'), 5000);
}

// Protege páginas internas: redirige si no hay sesión o el rol no coincide.
function exigirRol(rol) {
  const u = Api.usuario();
  if (!Api.token() || !u) {
    location.href = '/';
    return null;
  }
  if (u.rol !== rol) {
    location.href = u.rol === 'medico' ? '/medico.html' : '/paciente.html';
    return null;
  }
  document.getElementById('nombre-usuario').textContent = u.nombre;
  document.getElementById('btn-salir').addEventListener('click', async () => {
    await Api.post('/api/logout').catch(() => {});
    Api.limpiarSesion();
    location.href = '/';
  });
  return u;
}
