// inviteStore.js
// Guarda links de Supabase server-side para que WhatsApp no los pre-fetchee.
// WhatsApp hace GET a las URLs de los mensajes para generar previews,
// lo que consume el OTP token de un solo uso antes de que llegue al usuario.
// Solución: mandamos /invite/:id (que devuelve HTML) en vez del link directo.

const { randomBytes } = require('crypto');
const logger = require('../config/logger');

const store = new Map(); // id -> { url, expires_at }

// Limpiar entradas expiradas cada 10 minutos
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, val] of store.entries()) {
    if (val.expires_at < now) { store.delete(id); removed++; }
  }
  if (removed > 0) logger.info('inviteStore: removed ' + removed + ' expired invites');
}, 10 * 60 * 1000);

/**
 * Guarda un URL y devuelve un ID de un solo uso.
 * @param {string} url  - El action_link de Supabase
 * @returns {string}    - El ID (no la URL completa)
 */
function createInvite(url) {
  const id = randomBytes(16).toString('hex');
  store.set(id, { url, expires_at: Date.now() + 23 * 60 * 60 * 1000 }); // 23hs
  return id;
}

/**
 * Lee y devuelve el registro. NO lo elimina — Supabase invalida el token al usarlo.
 * @param {string} id
 * @returns {{ url: string, expires_at: number } | null}
 */
function getInvite(id) {
  const record = store.get(id);
  if (!record) return null;
  if (record.expires_at < Date.now()) { store.delete(id); return null; }
  return record;
}

module.exports = { createInvite, getInvite };
