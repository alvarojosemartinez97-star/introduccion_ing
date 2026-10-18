// Pruebas de los criterios de calidad: seguridad, rendimiento y eficiencia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { crearApp } = require('../server');

const dbFile = path.join(__dirname, '..', 'data', `test-calidad-${process.pid}.json`);
let server;
let base;
let ahora = Date.now();

async function api(metodo, ruta, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + ruta, { method: metodo, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

const login = (email, password) => api('POST', '/api/login', { body: { email, password } });

test.before(async () => {
  fs.rmSync(dbFile, { force: true });
  server = crearApp({ dbFile, reloj: () => ahora });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dbFile, { force: true });
});

test('seguridad: las contraseñas nunca se guardan en texto plano', () => {
  const contenido = fs.readFileSync(dbFile, 'utf8');
  assert.ok(!contenido.includes('paciente123'));
  assert.ok(!contenido.includes('medico123'));
});

test('seguridad: bloquea el inicio de sesión tras 5 intentos fallidos', async () => {
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await login('gtorres@portoazul.com', 'incorrecta')).status, 401);
  }
  const bloqueado = await login('gtorres@portoazul.com', 'medico123');
  assert.strictEqual(bloqueado.status, 429);
  assert.match(bloqueado.data.error, /Demasiados intentos/);

  ahora += 16 * 60 * 1000; // pasan 16 minutos
  assert.strictEqual((await login('gtorres@portoazul.com', 'medico123')).status, 200);
});

test('seguridad: la sesión vence a las 8 horas', async () => {
  const { data } = await login('paciente@demo.com', 'paciente123');
  assert.strictEqual((await api('GET', '/api/me', { token: data.token })).status, 200);
  ahora += 8 * 60 * 60 * 1000 + 1;
  assert.strictEqual((await api('GET', '/api/me', { token: data.token })).status, 401);
});

test('rendimiento: la consulta de médicos responde en menos de 2 s', async () => {
  const { data } = await login('paciente@demo.com', 'paciente123');
  const inicio = performance.now();
  const r = await api('GET', '/api/medicos?fecha=2030-01-07', { token: data.token });
  const t = performance.now() - inicio;
  assert.strictEqual(r.status, 200);
  assert.ok(t < 2000, `tardó ${t} ms`);
  assert.match(r.headers.get('x-response-time'), /^\d+\.\d{2}ms$/);
});

test('eficiencia: el médico consulta tiempo de respuesta y tasa de errores', async () => {
  const tPac = (await login('paciente@demo.com', 'paciente123')).data.token;
  assert.strictEqual((await api('GET', '/api/metricas', { token: tPac })).status, 403);

  const tMed = (await login('mleon@portoazul.com', 'medico123')).data.token;
  const { status, data } = await api('GET', '/api/metricas', { token: tMed });
  assert.strictEqual(status, 200);
  assert.ok(data.solicitudes > 0);
  assert.ok(data.fallidas > 0);
  assert.strictEqual(data.erroresServidor, 0);
  assert.strictEqual(data.tasaErrorPct, Math.round((data.fallidas / data.solicitudes) * 10000) / 100);
  assert.ok(data.tiempoPromedioMs < 2000);
});

test('eficiencia: reporta el uso de recursos (CPU, RAM, disco y red)', async () => {
  const tMed = (await login('mleon@portoazul.com', 'medico123')).data.token;
  const { recursos } = (await api('GET', '/api/metricas', { token: tMed })).data;
  assert.ok(recursos.cpuPct >= 0);
  assert.ok(recursos.memoriaMB > 0);
  assert.ok(recursos.discoKB > 0);
  assert.ok(recursos.redKB > 0);
});
