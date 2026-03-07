const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');
const crypto = require('crypto');

// ============================================================
// VERIFICAR FIRMA DEL WEBHOOK (seguridad)
// ============================================================
function verifyWebhookSignature(req) {
  // MercadoPago envía una firma en el header x-signature
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  if (!signature || !requestId) return false;

  // Extraer ts y hash de la firma
  const parts = signature.split(',');
  const ts = parts.find(p => p.startsWith('ts='))?.split('=')[1];
  const v1 = parts.find(p => p.startsWith('v1='))?.split('=')[1];

  if (!ts || !v1) return false;

  // Construir el string a firmar
  const dataId = req.query.data?.id || req.body?.data?.id || '';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

  const expectedHash = crypto
    .createHmac('sha256', process.env.MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest('hex');

  return expectedHash === v1;
}

// ============================================================
// HANDLER PRINCIPAL DEL WEBHOOK
// ============================================================
async function handleWebhook(req, res) {
  // Responder inmediatamente a MercadoPago para evitar reintentos
  res.status(200).json({ received: true });

  try {
    const { type, action, data } = req.body;

    logger.info('Webhook received:', { type, action, dataId: data?.id });

    // Verificar firma solo si MP_WEBHOOK_SECRET está configurado
    if (process.env.MP_WEBHOOK_SECRET && !verifyWebhookSignature(req)) {
      logger.warn('Webhook signature verification failed');
      return;
    }

    // Registrar evento en audit log
    const { data: webhookEvent } = await supabase
      .from('webhook_events')
      .insert({
        event_type: `${type}.${action}`,
        mp_event_id: data?.id,
        payload: req.body,
        processed: false,
      })
      .select()
      .single();

    // Procesar según el tipo de evento
    if (type === 'payment') {
      await processPaymentEvent(data?.id, webhookEvent?.id);
    } else if (type === 'subscription_preapproval') {
      await processPreApprovalEvent(data?.id, action, webhookEvent?.id);
    } else if (type === 'subscription_authorized_payment') {
      await processAuthorizedPaymentEvent(data?.id, webhookEvent?.id);
    } else {
      logger.info(`Unhandled webhook type: ${type}`);
      await markWebhookProcessed(webhookEvent?.id);
    }
  } catch (err) {
    logger.error('Webhook processing error:', err);
    // No rethrowing - ya respondimos 200 a MercadoPago
  }
}

// ============================================================
// PROCESAR PAGO ÚNICO
// ============================================================
async function processPaymentEvent(mpPaymentId, webhookEventId) {
  try {
    if (!mpPaymentId) return;

    // Obtener detalles del pago desde MP (server-side, no confiar en webhook payload)
    const mpPayment = await mpService.getPaymentInfo(mpPaymentId);

    const {
      status,
      external_reference,
      transaction_amount,
      payment_method_id,
      payment_type_id,
      date_approved,
      status_detail,
      metadata,
    } = mpPayment;

    const mappedStatus = mpService.mapPaymentStatus(status);

    logger.info(`Processing payment ${mpPaymentId}: ${status} (${external_reference})`);

    // Buscar pago existente por external_reference
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('*')
      .eq('mp_external_reference', external_reference)
      .single();

    if (!existingPayment) {
      logger.warn(`Payment with ref ${external_reference} not found in DB`);

      // Crear registro si no existe (caso edge)
      if (metadata?.tenant_id) {
        await supabase.from('payments').insert({
          tenant_id: metadata.tenant_id,
          user_id: metadata.user_id || null,
          type: metadata.type || 'gym_client',
          amount: transaction_amount,
          currency: 'ARS',
          status: mappedStatus,
          mp_payment_id: String(mpPaymentId),
          mp_external_reference: external_reference,
          payment_method: payment_method_id,
          payment_type: payment_type_id,
          payment_date: date_approved ? new Date(date_approved).toISOString() : null,
          metadata: { status_detail },
        });
      }

      await markWebhookProcessed(webhookEventId);
      return;
    }

    // Actualizar pago existente
    await supabase.from('payments').update({
      status: mappedStatus,
      mp_payment_id: String(mpPaymentId),
      payment_method: payment_method_id,
      payment_type: payment_type_id,
      payment_date: date_approved ? new Date(date_approved).toISOString() : null,
      failure_reason: mpService.isPaymentFailed(status) ? status_detail : null,
      metadata: { status_detail, ...existingPayment.metadata },
    }).eq('id', existingPayment.id);

    // Si el pago fue aprobado, activar la suscripción
    if (mpService.isPaymentApproved(status)) {
      await activateSubscription(existingPayment);
    }

    await markWebhookProcessed(webhookEventId);
    logger.info(`Payment ${mpPaymentId} processed: ${mappedStatus}`);
  } catch (err) {
    logger.error(`processPaymentEvent error for ${mpPaymentId}:`, err);
    await markWebhookFailed(webhookEventId, err.message);
  }
}

// ============================================================
// ACTIVAR SUSCRIPCIÓN TRAS PAGO APROBADO
// ============================================================
async function activateSubscription(payment) {
  try {
    const { tenant_id, user_id, type, amount } = payment;

    if (type === 'saas') {
      // Activar tenant si estaba bloqueado por pago
      await supabase.from('tenants').update({ status: 'active' }).eq('id', tenant_id);

      // Actualizar suscripción SaaS
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('tenant_id', tenant_id)
        .eq('type', 'saas')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (sub) {
        const newEndDate = new Date(sub.end_date || new Date());
        newEndDate.setMonth(newEndDate.getMonth() + 1);

        await supabase.from('subscriptions').update({
          status: 'active',
          end_date: newEndDate.toISOString().split('T')[0],
          mp_preapproval_id: payment.mp_preapproval_id,
        }).eq('id', sub.id);
      }

      logger.info(`SaaS subscription activated for tenant ${tenant_id}`);
    } else if (type === 'gym_client' && user_id) {
      // Desactivar suscripción anterior
      await supabase.from('subscriptions')
        .update({ status: 'expired' })
        .eq('user_id', user_id)
        .eq('type', 'gym_client')
        .eq('status', 'active');

      // Crear nueva suscripción activa
      const startDate = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);

      await supabase.from('subscriptions').insert({
        tenant_id,
        user_id,
        type: 'gym_client',
        amount,
        currency: 'ARS',
        status: 'active',
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      });

      logger.info(`Client subscription activated for user ${user_id}`);
    }
  } catch (err) {
    logger.error('activateSubscription error:', err);
  }
}

// ============================================================
// PROCESAR PREAPPROVAL (suscripción recurrente)
// ============================================================
async function processPreApprovalEvent(preApprovalId, action, webhookEventId) {
  try {
    // Solo manejar cancelaciones aquí
    if (action === 'updated') {
      // Buscar tenant por preapproval_id
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('mp_preapproval_id', String(preApprovalId))
        .single();

      if (subscription) {
        // Actualizar estado según acción
        logger.info(`PreApproval ${preApprovalId} updated`);
      }
    }

    await markWebhookProcessed(webhookEventId);
  } catch (err) {
    logger.error(`processPreApprovalEvent error:`, err);
    await markWebhookFailed(webhookEventId, err.message);
  }
}

// ============================================================
// PROCESAR PAGO DE SUSCRIPCIÓN RECURRENTE
// ============================================================
async function processAuthorizedPaymentEvent(paymentId, webhookEventId) {
  // Similar a processPaymentEvent, para cobros automáticos de preapproval
  await processPaymentEvent(paymentId, webhookEventId);
}

// ============================================================
// HELPERS
// ============================================================
async function markWebhookProcessed(eventId) {
  if (!eventId) return;
  await supabase.from('webhook_events').update({
    processed: true,
    processed_at: new Date().toISOString(),
  }).eq('id', eventId);
}

async function markWebhookFailed(eventId, errorMessage) {
  if (!eventId) return;
  await supabase.from('webhook_events').update({
    processed: false,
    error_message: errorMessage,
    retry_count: supabase.raw('retry_count + 1'),
  }).eq('id', eventId);
}

module.exports = { handleWebhook };
