# Clínica Porto Azul · Plataforma de citas médicas

Aplicación web para agendar citas médicas en la Clínica Porto Azul, con dos vistas:

- **Paciente**: se registra, busca **médicos disponibles** por especialidad y fecha, ve los horarios libres de cada médico, **agenda**, **reprograma**, **cancela** o **elimina** sus citas.
- **Médico**: ve sus **citas pendientes** (con resumen de hoy / total / atendidas / canceladas), filtra por fecha y estado, marca citas como **atendidas** o las **cancela** (con nota opcional que ve el paciente) y configura su **horario de atención** (días, horas y duración de cada cita).

## Requisitos

- Node.js 18 o superior. No usa dependencias externas (no hace falta `npm install`).

## Cómo ejecutar

```bash
npm start
```

Abrir <http://localhost:3000>. Para usar otro puerto: `PORT=8080 npm start`.

### Cuentas de prueba

| Rol      | Correo                                    | Contraseña    |
|----------|-------------------------------------------|---------------|
| Paciente | `paciente@demo.com`                       | `paciente123` |
| Médico   | `mleon@portoazul.com` (Medicina General)  | `medico123`   |
| Médico   | `candrade@portoazul.com` (Cardiología)    | `medico123`   |
| Médico   | `gtorres@portoazul.com` (Pediatría)       | `medico123`   |
| Médico   | `jvillacis@portoazul.com` (Traumatología) | `medico123`   |
| Médico   | `amendoza@portoazul.com` (Ginecología)    | `medico123`   |
| Médico   | `lparedes@portoazul.com` (Dermatología)   | `medico123`   |

Los pacientes nuevos se registran desde la pantalla de inicio. Los datos se guardan en `data/db.json`
(se crea automáticamente con los médicos de ejemplo; bórrelo para reiniciar la base).

## Pruebas

```bash
npm test
```

## Estructura

```
server.js           Servidor HTTP + API REST (módulos nativos de Node)
lib/db.js           Almacenamiento en JSON, datos iniciales y contraseñas (scrypt)
public/             Interfaz web
  index.html        Inicio de sesión y registro
  paciente.html/js  Portal del paciente
  medico.html/js    Panel del médico
  comun.js          Utilidades compartidas
  styles.css        Estilos
test/api.test.js    Pruebas de la API
```

## API

Todas las rutas (salvo registro/login) requieren el encabezado `Authorization: Bearer <token>`.

| Método | Ruta | Quién | Descripción |
|--------|------|-------|-------------|
| POST | `/api/registro` | — | Crear cuenta de paciente |
| POST | `/api/login` · `/api/logout` | — | Iniciar / cerrar sesión |
| GET | `/api/me` | todos | Usuario actual |
| GET | `/api/especialidades` | todos | Lista de especialidades |
| GET | `/api/medicos?especialidad=&fecha=` | todos | Médicos y cuántos horarios libres tienen ese día |
| GET | `/api/medicos/:id/disponibilidad?fecha=` | todos | Bloques horarios del día (libre / ocupado) |
| PUT | `/api/medico/horario` | médico | Cambiar horario de atención |
| GET | `/api/citas?estado=&fecha=` | todos | Citas del paciente o del médico |
| POST | `/api/citas` | paciente | Agendar cita |
| PUT | `/api/citas/:id` | paciente | Reprogramar cita pendiente |
| PATCH | `/api/citas/:id/estado` | ambos | Paciente: cancelar · Médico: atendida / cancelada |
| DELETE | `/api/citas/:id` | paciente | Eliminar cita (libera el horario) |

Reglas: solo se agenda en días y horas de atención del médico, en fechas futuras y sin choques
(un horario ocupado no puede tomarse dos veces; un paciente no puede tener dos citas a la misma hora).
