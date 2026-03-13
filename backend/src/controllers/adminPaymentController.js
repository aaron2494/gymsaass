const supabase = require('../config/supabase');
const logger   = require('../config/logger');
const mpService    = require('../services/mercadopago');
const emailService = require('../services/emailService');
const inviteStore  = require('../services/inviteStore');

async function generateClientPaymentLink(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, description } = req.body;

    // Obtener cliente y datos del tenant (incluyendo credenciales MP)
    const [clientRes, tenantRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', user_id).eq('tenant_id', tenantId).eq('role', 'client').single(),
      supabase.from('tenants').select('name, mp_access_token, mp_configured, subscription_price').eq('id', tenantId).single(),
    ]);

    const client = clientRes.data;
    const tenant = tenantRes.data;

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Verificar que el gym tiene MP configurado
    if (!tenant?.mp_access_token || !tenant?.mp_configured) {
      return res.status(400).json({
        error: 'Tenés que configurar tu MercadoPago antes de generar links de pago.',
        needs_mp_setup: true,
      });
    }

    // Monto: usar el del request o el precio default del gym
    const finalAmount = parseFloat(amount) || parseFloat(tenant.subscription_price) || 5000;
    const externalRef = `gym-${tenantId}-${user_id}-${Date.now()}`;

    // Registrar pago pendiente
    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        user_id,
        type: 'gym_client',
        amount: finalAmount,
        currency: 'ARS',
        status: 'pending',
        mp_external_reference: externalRef,
      })
      .select()
      .single();

    // Crear preferencia con las credenciales del GIMNASIO (no del SaaS)
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const gymMpClient = new MercadoPagoConfig({ accessToken: tenant.mp_access_token });
    const gymPreference = new Preference(gymMpClient);

    const backendBaseGen = (process.env.BACKEND_URL || '').trim().replace(/\/$/, '');
    const preference = await gymPreference.create({
      body: {
        items: [{
          title: description || `Suscripción mensual — ${tenant.name}`,
          quantity: 1,
          unit_price: finalAmount,
          currency_id: 'ARS',
        }],
        payer: { name: client.full_name, email: client.email },
        external_reference: externalRef,
        payment_methods: { installments: 1, excluded_payment_types: [] },
        expires: true,
        expiration_date_to: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        ...(backendBaseGen.startsWith('https://') && {
          back_urls: {
            success: `${backendBaseGen}/payments/callback?status=success`,
            failure: `${backendBaseGen}/payments/callback?status=failure`,
            pending: `${backendBaseGen}/payments/callback?status=pending`,
          },
          auto_return: 'approved',
          notification_url: `${backendBaseGen}/webhooks/mercadopago`,
        }),
      },
    });

    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    res.json({
      payment_url: preference.init_point,
      external_reference: externalRef,
      amount: finalAmount,
    });
  } catch (err) {
    logger.error('Admin generateClientPaymentLink error:', err);
    res.status(500).json({ error: 'Error generando link de pago: ' + err.message });
  }
}

// ============================================================
// HISTORIAL DE PAGOS DE UN CLIENTE
// ============================================================
async function getClientPayments(req, res) {
  try {
    const { clientId } = req.params;
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', clientId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ payments: data });
  } catch (err) {
    logger.error('Admin getClientPayments error:', err);
    res.status(500).json({ error: 'Error obteniendo pagos' });
  }
}

// ============================================================
// CREAR/RENOVAR SUSCRIPCIÓN MANUAL (sin pago MP)
// ============================================================
async function createClientSubscription(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, months = 1 } = req.body;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    // Desactivar suscripción anterior
    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('user_id', user_id)
      .eq('type', 'gym_client')
      .eq('status', 'active');

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .insert({
        tenant_id: tenantId,
        user_id,
        type: 'gym_client',
        amount,
        currency: 'ARS',
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status: 'active',
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Suscripción creada', subscription });
  } catch (err) {
    logger.error('Admin createClientSubscription error:', err);
    res.status(500).json({ error: 'Error creando suscripción' });
  }
}


// GET /admin/clients/:id/progress — Progreso de un cliente en su rutina
// ============================================================

async function paymentLinkAndWhatsApp(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, description } = req.body;

    // Reusar la lógica de generateClientPaymentLink pero devolver también datos para WhatsApp
    const [clientRes, tenantRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', user_id).eq('tenant_id', tenantId).eq('role', 'client').single(),
      supabase.from('tenants').select('name, mp_access_token, mp_configured, subscription_price').eq('id', tenantId).single(),
    ]);

    const client = clientRes.data;
    const tenant = tenantRes.data;

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    if (!tenant?.mp_access_token || !tenant?.mp_configured) {
      return res.status(400).json({ error: 'Configurá MercadoPago primero', needs_mp_setup: true });
    }

    const finalAmount = parseFloat(amount) || parseFloat(tenant.subscription_price) || 5000;
    const externalRef = `gym-${tenantId}-${user_id}-${Date.now()}`;

    const { data: payment } = await supabase.from('payments')
      .insert({ tenant_id: tenantId, user_id, type: 'gym_client', amount: finalAmount, currency: 'ARS', status: 'pending', mp_external_reference: externalRef })
      .select().single();

    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const gymMpClient = new MercadoPagoConfig({ accessToken: tenant.mp_access_token });

    const backendUrl = process.env.BACKEND_URL?.trim();
    const notificationUrl = backendUrl && backendUrl.startsWith('https://')
      ? `${backendUrl}/webhooks/mercadopago`
      : null;

    const backendBase = (process.env.BACKEND_URL || '').trim().replace(/\/$/, '');
    const preference = await new Preference(gymMpClient).create({
      body: {
        items: [{ title: description || `Suscripción mensual — ${tenant.name}`, quantity: 1, unit_price: finalAmount, currency_id: 'ARS' }],
        payer: { name: client.full_name, email: client.email },
        external_reference: externalRef,
        payment_methods: { installments: 1, excluded_payment_types: [] },
        expires: true,
        expiration_date_to: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        ...(backendBase.startsWith('https://') && {
          back_urls: {
            success: `${backendBase}/payments/callback?status=success`,
            failure: `${backendBase}/payments/callback?status=failure`,
            pending: `${backendBase}/payments/callback?status=pending`,
          },
          auto_return: 'approved',
          notification_url: `${backendBase}/webhooks/mercadopago`,
        }),
      },
    });

    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    // Armar el mensaje WhatsApp listo para enviar
    const firstName = client.full_name?.split(' ')[0] || 'cliente';
    const whatsappMsg = `Hola ${firstName}! 👋 Te mando el link para renovar tu suscripción en ${tenant.name}:\n\n${preference.init_point}\n\n¡Gracias! 💪`;

    res.json({
      payment_url: preference.init_point,
      amount: finalAmount,
      whatsapp_phone: client.phone?.replace(/\D/g, ''),
      whatsapp_msg: whatsappMsg,
      whatsapp_url: client.phone
        ? `https://wa.me/${client.phone.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMsg)}`
        : null,
    });
  } catch (err) {
    logger.error('paymentLinkAndWhatsApp error:', err);
    res.status(500).json({ error: 'Error generando link: ' + err.message });
  }
}

// ============================================================
// POST /admin/clients/:id/sync-payment — Sincronizar pago manualmente
// Verifica el último pago pendiente contra MP y activa la suscripción
// ============================================================
async function syncClientPayment(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id: userId } = req.params;

    // Buscar el último pago pendiente o aprobado del cliente
    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('type', 'gym_client')
      .in('status', ['pending', 'in_process', 'approved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (pErr || !payment) {
      return res.status(404).json({ error: 'No hay pagos pendientes para este cliente' });
    }

    // Si ya está aprobado en nuestra DB, solo activar suscripción
    if (payment.status === 'approved') {
      await activateGymClientSubscription(payment);
      return res.json({ message: 'Suscripción activada', status: 'approved' });
    }

    // Buscar credenciales MP del gym
    const { data: tenantData } = await supabase
      .from('tenants')
      .select('mp_access_token')
      .eq('id', tenantId)
      .single();

    if (!tenantData?.mp_access_token) {
      // Sin credenciales MP, solo se puede activar manualmente
      const { manual } = req.body;
      if (manual) {
        await supabase.from('payments').update({ status: 'approved', payment_date: new Date().toISOString() }).eq('id', payment.id);
        await activateGymClientSubscription({ ...payment, status: 'approved' });
        return res.json({ message: '✅ Pago activado manualmente', status: 'approved' });
      }
      return res.status(400).json({ error: 'MercadoPago no configurado. Activá manualmente.' });
    }

    const { MercadoPagoConfig, Payment: MpPayment, MerchantOrder } = require('mercadopago');
    const gymMpClient = new MercadoPagoConfig({ accessToken: tenantData.mp_access_token });

    // Si tiene mp_payment_id, consultar MP directamente
    if (payment.mp_payment_id) {
      const mpPayment = await new MpPayment(gymMpClient).get({ id: payment.mp_payment_id });

      if (mpPayment.status === 'approved') {
        await supabase.from('payments').update({
          status: 'approved',
          payment_date: mpPayment.date_approved ? new Date(mpPayment.date_approved).toISOString() : new Date().toISOString(),
        }).eq('id', payment.id);

        await activateGymClientSubscription({ ...payment, status: 'approved' });
        return res.json({ message: '✅ Pago verificado y suscripción activada', status: 'approved' });
      }

      return res.json({ message: `Pago en estado: ${mpPayment.status}`, status: mpPayment.status });
    }

    // Sin mp_payment_id — el admin puede activar manualmente
    const { manual } = req.body;
    if (manual) {
      await supabase.from('payments').update({
        status: 'approved',
        payment_date: new Date().toISOString(),
      }).eq('id', payment.id);
      await activateGymClientSubscription({ ...payment, status: 'approved' });
      return res.json({ message: '✅ Pago activado manualmente', status: 'approved' });
    }
    return res.json({ message: 'Pago pendiente sin confirmar. El webhook lo procesará automáticamente o activá manualmente.', status: 'pending' });
  } catch (err) {
    logger.error('syncClientPayment error:', err);
    res.status(500).json({ error: 'Error sincronizando pago: ' + err.message });
  }
}

// Helper interno reutilizable
async function activateGymClientSubscription(payment) {
  const { tenant_id, user_id, amount } = payment;

  // Expirar suscripciones anteriores
  await supabase.from('subscriptions')
    .update({ status: 'expired' })
    .eq('user_id', user_id)
    .eq('type', 'gym_client')
    .eq('status', 'active');

  // Crear nueva suscripción activa por 30 días
  const startDate = new Date();
  const endDate   = new Date();
  endDate.setMonth(endDate.getMonth() + 1);

  const { error } = await supabase.from('subscriptions').insert({
    tenant_id,
    user_id,
    type: 'gym_client',
    amount,
    currency: 'ARS',
    status: 'active',
    start_date: startDate.toISOString().split('T')[0],
    end_date:   endDate.toISOString().split('T')[0],
  });

  if (error) throw error;
  logger.info(`Subscription activated for user ${user_id}`);
}


module.exports = { generateClientPaymentLink, getClientPayments, createClientSubscription, paymentLinkAndWhatsApp, syncClientPayment, activateGymClientSubscription };
