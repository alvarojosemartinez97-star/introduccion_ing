// Almacenamiento simple en un archivo JSON (sin dependencias externas).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

const MEDICOS_INICIALES = [
  { nombre: 'Dra. María Fernanda León', email: 'mleon@portoazul.com', especialidad: 'Medicina General', dias: [1, 2, 3, 4, 5], inicio: '08:00', fin: '13:00' },
  { nombre: 'Dr. Carlos Andrade', email: 'candrade@portoazul.com', especialidad: 'Cardiología', dias: [1, 3, 5], inicio: '09:00', fin: '15:00' },
  { nombre: 'Dra. Gabriela Torres', email: 'gtorres@portoazul.com', especialidad: 'Pediatría', dias: [1, 2, 3, 4, 5], inicio: '14:00', fin: '18:00' },
  { nombre: 'Dr. José Villacís', email: 'jvillacis@portoazul.com', especialidad: 'Traumatología', dias: [2, 4, 6], inicio: '08:00', fin: '12:00' },
  { nombre: 'Dra. Andrea Mendoza', email: 'amendoza@portoazul.com', especialidad: 'Ginecología', dias: [1, 2, 4], inicio: '10:00', fin: '16:00' },
  { nombre: 'Dr. Luis Paredes', email: 'lparedes@portoazul.com', especialidad: 'Dermatología', dias: [3, 5], inicio: '08:00', fin: '14:00' },
];

function datosIniciales() {
  const data = { seq: 0, usuarios: [], citas: [] };
  const nuevoId = () => ++data.seq;

  for (const m of MEDICOS_INICIALES) {
    const { salt, hash } = hashPassword('medico123');
    data.usuarios.push({
      id: nuevoId(),
      rol: 'medico',
      nombre: m.nombre,
      email: m.email,
      salt,
      hash,
      especialidad: m.especialidad,
      horario: { dias: m.dias, inicio: m.inicio, fin: m.fin, duracion: 30 },
    });
  }

  const { salt, hash } = hashPassword('paciente123');
  data.usuarios.push({
    id: nuevoId(),
    rol: 'paciente',
    nombre: 'Paciente Demo',
    email: 'paciente@demo.com',
    cedula: '0900000000',
    telefono: '0990000000',
    salt,
    hash,
  });
  return data;
}

class Database {
  constructor(file) {
    this.file = file;
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = datosIniciales();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId() {
    return ++this.data.seq;
  }

  get usuarios() {
    return this.data.usuarios;
  }

  get citas() {
    return this.data.citas;
  }
}

module.exports = { Database, hashPassword, verifyPassword };
