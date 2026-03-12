// inviteStore.js — tokens firmados con HMAC, sin estado en memoria.
// Funciona con múltiples instancias de Render sin base de datos.
// Formato del token: base64(payload_json).base64(hmac_sha256)
// El payload contiene auth_id, email y expiración.

const crypto = require('crypto');

const SECRET = process.env.INVITE_SECRET || process.env.SUPABASE_JWT_SECRET || 'fallback-dev-secret-change-in-prod';

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}

function verify(token) {
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    // Comparación en tiempo constante para evitar timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null; // expirado
    return payload;
  } catch {
    return null;
  }
}

/**
 * Crea un token firmado con email y auth_id.
 * @returns {string} token opaco para usar en la URL
 */
function createInvite(email, authId) {
  return sign({
    email,
    auth_id: authId,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24hs
  });
}

/**
 * Verifica y devuelve el payload, o null si expiró/inválido.
 */
function getInvite(token) {
  return verify(token);
}

// markUsed ya no es necesario — los tokens de contraseña no son de un solo uso
// porque el usuario puede necesitar reintentar si escribe mal.
// La contraseña se sobreescribe si se usa dos veces (idempotente).
function markUsed() {}

module.exports = { createInvite, getInvite, markUsed };
