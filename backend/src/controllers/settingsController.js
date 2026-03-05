const supabase = require('../config/supabase');
const logger = require('../config/logger');
const { MercadoPagoConfig, Preference } = require('mercadopago');

// ============================================================
// GET /admin/settings — Obtener configuración del gimnasio
// ============================================================
async function getSettings(req, res) {
  try {
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('tenants')
      .select(`
        id, name, email, phone, address,
        instagram, whatsapp, logo_url,
        mp_configured, mp_public_key,
        subscription_price, subscription_currency,
        status, plan, created_at
      `)
      .eq('id', tenantId)
      .single();

    if (error) throw error;

    // NUNCA devolver el access_token al frontend
    res.json({ settings: data });
  } catch (err) {
    logger.error('getSettings error:', err);
    res.status(500).json({ error: 'Error obteniendo configuración' });
  }
}

// ============================================================
// PUT /admin/settings — Guardar configuración general
// ============================================================
async function updateSettings(req, res) {
  try {
    const tenantId = req.tenantId;
    const {
      name, phone, address,
      instagram, whatsapp,
      subscription_price, subscription_currency,
    } = req.body;

    const updates = {};
    if (name?.trim()) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (instagram !== undefined) updates.instagram = instagram;
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    if (subscription_price !== undefined) updates.subscription_price = parseFloat(subscription_price);
    if (subscription_currency !== undefined) updates.subscription_currency = subscription_currency;

    const { data, error } = await supabase
      .from('tenants')
      .update(updates)
      .eq('id', tenantId)
      .select('id, name, phone, address, instagram, whatsapp, subscription_price, subscription_currency')
      .single();

    if (error) throw error;
    res.json({ message: 'Configuración guardada', settings: data });
  } catch (err) {
    logger.error('updateSettings error:', err);
    res.status(500).json({ error: 'Error guardando configuración' });
  }
}

// ============================================================
// POST /admin/settings/mercadopago — Guardar y validar credenciales MP
// ============================================================
async function saveMercadoPagoCredentials(req, res) {
  try {
    const tenantId = req.tenantId;
    const { mp_access_token, mp_public_key } = req.body;

    if (!mp_access_token?.trim()) {
      return res.status(400).json({ error: 'El Access Token es requerido' });
    }

    // Validar que el access token funciona creando una preferencia de prueba
    try {
      const testClient = new MercadoPagoConfig({
        accessToken: mp_access_token.trim(),
      });
      const testPreference = new Preference(testClient);
      await testPreference.create({
        body: {
          items: [{
            title: 'Test',
            quantity: 1,
            unit_price: 1,
            currency_id: 'ARS',
          }],
        },
      });
    } catch (mpErr) {
      logger.warn('MP credential validation failed:', mpErr.message);
      return res.status(400).json({
        error: 'Credenciales de MercadoPago inválidas. Verificá tu Access Token.',
      });
    }

    // Guardar credenciales
    const { error } = await supabase
      .from('tenants')
      .update({
        mp_access_token: mp_access_token.trim(),
        mp_public_key: mp_public_key?.trim() || null,
        mp_configured: true,
      })
      .eq('id', tenantId);

    if (error) throw error;

    logger.info(`MP credentials saved for tenant ${tenantId}`);
    res.json({ message: '¡MercadoPago configurado correctamente! ✅' });
  } catch (err) {
    logger.error('saveMercadoPagoCredentials error:', err);
    res.status(500).json({ error: 'Error guardando credenciales' });
  }
}

// ============================================================
// DELETE /admin/settings/mercadopago — Desconectar MP
// ============================================================
async function removeMercadoPagoCredentials(req, res) {
  try {
    const tenantId = req.tenantId;

    await supabase
      .from('tenants')
      .update({
        mp_access_token: null,
        mp_public_key: null,
        mp_configured: false,
      })
      .eq('id', tenantId);

    res.json({ message: 'MercadoPago desconectado' });
  } catch (err) {
    logger.error('removeMercadoPagoCredentials error:', err);
    res.status(500).json({ error: 'Error desconectando MP' });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  saveMercadoPagoCredentials,
  removeMercadoPagoCredentials,
};
