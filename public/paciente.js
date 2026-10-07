const usuario = exigirRol('paciente');
const msg = document.getElementById('msg');
const $ = (id) => document.getElementById(id);

const estado = { medico: null, hora: null };

// ---------- navegación ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => verVista(b.dataset.vista));
});

function verVista(vista) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === vista));
  $('vista-agendar').classList.toggle('oculto', vista !== 'agendar');
  $('vista-mis-citas').classList.toggle('oculto', vista !== 'mis-citas');
  if (vista === 'mis-citas') cargarCitas();
  else cargarMedicos();
}

// ---------- pintar bloques horarios ----------
function pintarHoras(contenedor, horas, alElegir) {
  contenedor.innerHTML = '';
  if (!horas.length) {
    contenedor.innerHTML = '<p class="vacio">El médico no atiende en esta fecha.</p>';
    return;
  }
  for (const h of horas) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hora';
    b.textContent = h.hora;
    b.disabled = !h.libre;
    b.title = h.libre ? 'Disponible' : 'No disponible';
    b.addEventListener('click', () => {
      contenedor.querySelectorAll('.hora').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      alElegir(h.hora);
    });
    contenedor.appendChild(b);
  }
}

// ---------- agendar ----------
async function cargarEspecialidades() {
  const lista = await Api.get('/api/especialidades');
  $('f-esp').innerHTML += lista.map((e) => `<option>${escapar(e)}</option>`).join('');
}

async function cargarMedicos() {
  const fecha = $('f-fecha').value;
  const params = new URLSearchParams({ fecha });
  if ($('f-esp').value) params.set('especialidad', $('f-esp').value);
  const cont = $('lista-medicos');
  try {
    const medicos = await Api.get(`/api/medicos?${params}`);
    medicos.sort((a, b) => (b.libres > 0) - (a.libres > 0) || a.nombre.localeCompare(b.nombre));
    if (!medicos.length) {
      cont.innerHTML = '<p class="vacio">No hay médicos para esta especialidad.</p>';
      return;
    }
    cont.innerHTML = '';
    for (const m of medicos) {
      const disponible = m.libres > 0;
      const div = document.createElement('div');
      div.className = `medico${disponible ? '' : ' no-disponible'}`;
      div.innerHTML = `
        <strong>${escapar(m.nombre)}</strong>
        <span class="esp">${escapar(m.especialidad)}</span>
        <span class="horario">${escapar(textoHorario(m.horario))}</span>
        <span>${!m.atiende ? 'No atiende este día' : disponible ? `${m.libres} horario(s) libre(s)` : 'Sin horarios libres'}</span>`;
      const b = document.createElement('button');
      b.className = 'pequeno';
      b.textContent = 'Ver horarios';
      b.disabled = !disponible;
      b.addEventListener('click', () => elegirMedico(m));
      div.appendChild(b);
      cont.appendChild(div);
    }
    if (estado.medico) {
      const sigue = medicos.find((m) => m.id === estado.medico.id && m.libres > 0);
      if (sigue) elegirMedico(sigue);
      else ocultarPasoHorario();
    }
  } catch (err) {
    mostrarMensaje(msg, err.message, 'error');
  }
}

function ocultarPasoHorario() {
  estado.medico = null;
  estado.hora = null;
  $('paso-horario').classList.add('oculto');
}

async function elegirMedico(m) {
  estado.medico = m;
  estado.hora = null;
  $('btn-agendar').disabled = true;
  const fecha = $('f-fecha').value;
  $('resumen-medico').innerHTML = `<strong>${escapar(m.nombre)}</strong> · ${escapar(m.especialidad)} · ${escapar(formatoFecha(fecha))}`;
  const { horas } = await Api.get(`/api/medicos/${m.id}/disponibilidad?fecha=${fecha}`);
  pintarHoras($('horas'), horas, (hora) => {
    estado.hora = hora;
    $('btn-agendar').disabled = false;
  });
  $('paso-horario').classList.remove('oculto');
  $('paso-horario').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('btn-agendar').addEventListener('click', async () => {
  if (!estado.medico || !estado.hora) return;
  try {
    const cita = await Api.post('/api/citas', {
      medicoId: estado.medico.id,
      fecha: $('f-fecha').value,
      hora: estado.hora,
      motivo: $('motivo').value,
    });
    mostrarMensaje(msg, `Cita agendada con ${cita.medico.nombre} el ${formatoFecha(cita.fecha)} a las ${cita.hora}.`);
    $('motivo').value = '';
    ocultarPasoHorario();
    cargarMedicos();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    mostrarMensaje(msg, err.message, 'error');
    if (estado.medico) elegirMedico(estado.medico);
  }
});

$('f-esp').addEventListener('change', () => { ocultarPasoHorario(); cargarMedicos(); });
$('f-fecha').addEventListener('change', cargarMedicos);

// ---------- mis citas ----------
async function cargarCitas() {
  const est = $('f-estado').value;
  const citas = await Api.get(`/api/citas${est ? `?estado=${est}` : ''}`);
  const tbody = $('tabla-citas');
  if (!citas.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="vacio">No tiene citas en esta categoría.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const c of citas) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(formatoFecha(c.fecha))}</td>
      <td>${escapar(c.hora)}</td>
      <td>${escapar(c.medico?.nombre)}<br><small>${escapar(c.medico?.especialidad)}</small></td>
      <td>${escapar(c.motivo) || '—'}${c.nota ? `<br><small><em>Nota del médico: ${escapar(c.nota)}</em></small>` : ''}</td>
      <td><span class="estado ${c.estado}">${c.estado}</span></td>
      <td><div class="acciones"></div></td>`;
    const acciones = tr.querySelector('.acciones');
    if (c.estado === 'pendiente') {
      acciones.append(
        boton('Reprogramar', 'secundario', () => abrirReprogramar(c)),
        boton('Cancelar', 'peligro', () => cancelar(c))
      );
    }
    acciones.append(boton('Eliminar', 'secundario', () => eliminar(c)));
    tbody.appendChild(tr);
  }
}

function boton(texto, clase, accion) {
  const b = document.createElement('button');
  b.className = `pequeno ${clase}`;
  b.textContent = texto;
  b.addEventListener('click', accion);
  return b;
}

async function cancelar(c) {
  if (!confirm(`¿Cancelar la cita del ${formatoFecha(c.fecha)} a las ${c.hora}?`)) return;
  try {
    await Api.patch(`/api/citas/${c.id}/estado`, { estado: 'cancelada' });
    mostrarMensaje(msg, 'Cita cancelada.');
    cargarCitas();
  } catch (err) { mostrarMensaje(msg, err.message, 'error'); }
}

async function eliminar(c) {
  const aviso = c.estado === 'pendiente'
    ? '¿Eliminar esta cita? Se liberará el horario y se borrará de su historial.'
    : '¿Eliminar esta cita de su historial?';
  if (!confirm(aviso)) return;
  try {
    await Api.del(`/api/citas/${c.id}`);
    mostrarMensaje(msg, 'Cita eliminada.');
    cargarCitas();
  } catch (err) { mostrarMensaje(msg, err.message, 'error'); }
}

$('f-estado').addEventListener('change', cargarCitas);

// ---------- reprogramar ----------
const dlg = $('dlg-reprogramar');
let citaEditando = null;
let nuevaHora = null;

function abrirReprogramar(c) {
  citaEditando = c;
  nuevaHora = null;
  $('rp-medico').textContent = `${c.medico.nombre} · ${c.medico.especialidad}. Actual: ${formatoFecha(c.fecha)} a las ${c.hora}.`;
  $('rp-fecha').min = hoyISO();
  $('rp-fecha').value = c.fecha;
  cargarHorasReprogramar();
  dlg.showModal();
}

async function cargarHorasReprogramar() {
  nuevaHora = null;
  $('rp-guardar').disabled = true;
  const fecha = $('rp-fecha').value;
  if (!fecha) return;
  try {
    const { horas } = await Api.get(`/api/medicos/${citaEditando.medicoId}/disponibilidad?fecha=${fecha}&ignorar=${citaEditando.id}`);
    pintarHoras($('rp-horas'), horas, (h) => { nuevaHora = h; $('rp-guardar').disabled = false; });
  } catch (err) {
    $('rp-horas').innerHTML = `<p class="mensaje error">${escapar(err.message)}</p>`;
  }
}

$('rp-fecha').addEventListener('change', cargarHorasReprogramar);
$('rp-cerrar').addEventListener('click', () => dlg.close());
$('rp-guardar').addEventListener('click', async () => {
  try {
    await Api.put(`/api/citas/${citaEditando.id}`, { fecha: $('rp-fecha').value, hora: nuevaHora });
    dlg.close();
    mostrarMensaje(msg, 'Cita reprogramada correctamente.');
    cargarCitas();
  } catch (err) {
    mostrarMensaje(msg, err.message, 'error');
    cargarHorasReprogramar();
  }
});

// ---------- inicio ----------
if (usuario) {
  $('f-fecha').min = hoyISO();
  $('f-fecha').value = hoyISO(1);
  cargarEspecialidades().then(cargarMedicos);
}
