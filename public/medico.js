const usuario = exigirRol('medico');
const msg = document.getElementById('msg');
const $ = (id) => document.getElementById(id);

// ---------- navegación ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('activo', x === b));
    $('vista-citas').classList.toggle('oculto', b.dataset.vista !== 'citas');
    $('vista-horario').classList.toggle('oculto', b.dataset.vista !== 'horario');
    $('vista-indicadores').classList.toggle('oculto', b.dataset.vista !== 'indicadores');
    if (b.dataset.vista === 'citas') cargarCitas();
    if (b.dataset.vista === 'indicadores') cargarMetricas();
  });
});

// ---------- citas ----------
async function cargarResumen() {
  const todas = await Api.get('/api/citas');
  const hoy = hoyISO();
  $('n-hoy').textContent = todas.filter((c) => c.estado === 'pendiente' && c.fecha === hoy).length;
  $('n-pend').textContent = todas.filter((c) => c.estado === 'pendiente').length;
  $('n-atend').textContent = todas.filter((c) => c.estado === 'atendida').length;
  $('n-canc').textContent = todas.filter((c) => c.estado === 'cancelada').length;
}

async function cargarCitas() {
  const params = new URLSearchParams();
  if ($('f-estado').value) params.set('estado', $('f-estado').value);
  if ($('f-fecha').value) params.set('fecha', $('f-fecha').value);
  try {
    const [citas] = await Promise.all([Api.get(`/api/citas?${params}`), cargarResumen()]);
    const tbody = $('tabla-citas');
    if (!citas.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="vacio">No hay citas con estos filtros.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const c of citas) {
      const p = c.paciente || {};
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapar(formatoFecha(c.fecha))}</td>
        <td>${escapar(c.hora)}</td>
        <td>${escapar(p.nombre)}${p.cedula ? `<br><small>C.I. ${escapar(p.cedula)}</small>` : ''}</td>
        <td><small>${escapar(p.email)}${p.telefono ? `<br>${escapar(p.telefono)}` : ''}</small></td>
        <td>${escapar(c.motivo) || '—'}${c.nota ? `<br><small><em>Nota: ${escapar(c.nota)}</em></small>` : ''}</td>
        <td><span class="estado ${c.estado}">${c.estado}</span></td>
        <td><div class="acciones"></div></td>`;
      if (c.estado === 'pendiente') {
        tr.querySelector('.acciones').append(
          boton('Atendida', 'exito', () => cambiarEstado(c, 'atendida')),
          boton('Cancelar', 'peligro', () => cambiarEstado(c, 'cancelada'))
        );
      }
      tbody.appendChild(tr);
    }
  } catch (err) {
    mostrarMensaje(msg, err.message, 'error');
  }
}

function boton(texto, clase, accion) {
  const b = document.createElement('button');
  b.className = `pequeno ${clase}`;
  b.textContent = texto;
  b.addEventListener('click', accion);
  return b;
}

async function cambiarEstado(c, nuevo) {
  const pregunta = nuevo === 'atendida'
    ? 'Nota de la consulta (opcional):'
    : 'Motivo de la cancelación (opcional, lo verá el paciente):';
  const nota = prompt(`${c.paciente?.nombre} · ${formatoFecha(c.fecha)} ${c.hora}\n\n${pregunta}`, '');
  if (nota === null) return;
  try {
    await Api.patch(`/api/citas/${c.id}/estado`, { estado: nuevo, nota });
    mostrarMensaje(msg, nuevo === 'atendida' ? 'Cita marcada como atendida.' : 'Cita cancelada.');
    cargarCitas();
  } catch (err) { mostrarMensaje(msg, err.message, 'error'); }
}

$('f-estado').addEventListener('change', cargarCitas);
$('f-fecha').addEventListener('change', cargarCitas);
$('btn-limpiar').addEventListener('click', () => { $('f-fecha').value = ''; cargarCitas(); });

// ---------- horario ----------
function pintarHorario(h) {
  $('dias').innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `<label><input type="checkbox" value="${d}" ${h.dias.includes(d) ? 'checked' : ''}> ${DIAS[d]}</label>`)
    .join('');
  $('h-inicio').value = h.inicio;
  $('h-fin').value = h.fin;
  $('h-duracion').value = String(h.duracion);
}

$('form-horario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dias = [...document.querySelectorAll('#dias input:checked')].map((i) => Number(i.value));
  try {
    const medico = await Api.put('/api/medico/horario', {
      dias,
      inicio: $('h-inicio').value,
      fin: $('h-fin').value,
      duracion: Number($('h-duracion').value),
    });
    pintarHorario(medico.horario);
    mostrarMensaje(msg, 'Horario actualizado.');
  } catch (err) { mostrarMensaje(msg, err.message, 'error'); }
});

// ---------- indicadores ----------
async function cargarMetricas() {
  try {
    const m = await Api.get('/api/metricas');
    $('m-tiempo').textContent = m.tiempoPromedioMs;
    $('m-max').textContent = m.tiempoMaxMs;
    $('m-tasa').textContent = m.tasaErrorPct;
    $('m-total').textContent = m.solicitudes;
    $('m-500').textContent = m.erroresServidor;
    $('r-cpu').textContent = m.recursos.cpuPct;
    $('r-ram').textContent = m.recursos.memoriaMB;
    $('r-disco').textContent = m.recursos.discoKB;
    $('r-red').textContent = m.recursos.redKB;
  } catch (err) { mostrarMensaje(msg, err.message, 'error'); }
}

$('btn-metricas').addEventListener('click', cargarMetricas);

// ---------- inicio ----------
if (usuario) {
  Api.get('/api/me').then((me) => pintarHorario(me.horario || { dias: [], inicio: '08:00', fin: '16:00', duracion: 30 }));
  cargarCitas();
}
