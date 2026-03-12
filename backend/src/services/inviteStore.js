// inviteStore.js — guarda invitaciones de un solo uso para el flujo de bienvenida
// Clave de seguridad: ID de 32 bytes aleatorios (256 bits)
// No usamos el link de Supabase directamente por WhatsApp: el bot de WA
// pre-fetchea URLs para generar previews y quema el OTP de un solo uso.

const { randomBytes } = require('crypto');
const logger = require('../config/logger');

const store = new Map(); // id -> { email, auth_id, expires_at, used }

setInterval(() => {
  const now = Date.now();
  for (const [id, val] of store.entries()) {
    if (val.expires_at < now) store.delete(id);
  }
}, 10 * 60 * 1000);

function createInvite(email, authId) {
  const id = randomBytes(32).toString('hex');
  store.set(id, {
    email,
    auth_id: authId,
    expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24hs
    used: false,
  });
  return id;
}

function getInvite(id) {
  const record = store.get(id);
  if (!record) return null;
  if (record.expires_at < Date.now()) { store.delete(id); return null; }
  if (record.used) return null;
  return record;
}

function markUsed(id) {
  const record = store.get(id);
  if (record) store.set(id, { ...record, used: true });
}

module.exports = { createInvite, getInvite, markUsed };
