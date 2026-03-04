const { MercadoPagoConfig, Payment, Preference, PreApproval } = require('mercadopago');
const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const paymentClient = new Payment(client);
const preferenceClient = new Preference(client);
const preApprovalClient = new PreApproval(client);

// ============================================================
// PAGO ÚNICO - Suscripción mensual del cliente al gimnasio
// ============================================================
async function createPaymentPreference({ tenantId, userId, amount, currency, description, externalReference }) {
  const isDev = process.env.NODE_ENV === 'development';

  const body = {
    items: [{
      title: description || 'Suscripción mensual gimnasio',
      quantity: 1,
      unit_price: parseFloat(amount),
      currency_id: currency || 'ARS',
    }],
    external_reference: externalReference || `${tenantId}-${userId}-${Date.now()}`,
    payment_methods: {
      installments: 1,
    },
    expires: true,
    expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    metadata: {
      tenant_id: tenantId,
      user_id: userId,
      type: 'gym_client',
    },
  };

  // back_urls y notification_url solo en producción con URL pública
  if (!isDev) {
    body.back_urls = {
      success: `${process.env.BACKEND_URL}/payments/callback?status=success`,
      failure: `${process.env.BACKEND_URL}/payments/callback?status=failure`,
      pending: `${process.env.BACKEND_URL}/payments/callback?status=pending`,
    };
    body.auto_return = 'approved';
    body.notification_url = `${process.env.BACKEND_URL}/webhooks/mercadopago`;
  }

  const preference = await preferenceClient.create({ body });
  return preference;
}
// ============================================================
// SUSCRIPCIÓN RECURRENTE - Cobro mensual al gimnasio (SaaS)
// ============================================================
async function createSaasSubscription({ tenantId, adminEmail, adminName, amount, currency }) {
  const externalReference = `saas-${tenantId}-${Date.now()}`;

  const preApproval = await preApprovalClient.create({
    body: {
      reason: `GymSaaS - Suscripción mensual`,
      external_reference: externalReference,
      payer_email: adminEmail,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: parseFloat(amount),
        currency_id: currency || 'ARS',
      },
      back_url: `${process.env.BACKEND_URL}/payments/callback?type=saas`,
      notification_url: `${process.env.BACKEND_URL}/webhooks/mercadopago`,
      status: 'pending',
      metadata: {
        tenant_id: tenantId,
        type: 'saas',
      },
    },
  });

  return { preApproval, externalReference };
}

// ============================================================
// OBTENER INFO DE PAGO
// ============================================================
async function getPaymentInfo(paymentId) {
  try {
    const payment = await paymentClient.get({ id: paymentId });
    return payment;
  } catch (err) {
    logger.error(`Error obteniendo pago ${paymentId}:`, err);
    throw err;
  }
}

// ============================================================
// CANCELAR SUSCRIPCIÓN RECURRENTE
// ============================================================
async function cancelPreApproval(preApprovalId) {
  const result = await preApprovalClient.update({
    id: preApprovalId,
    body: { status: 'cancelled' },
  });
  return result;
}

// ============================================================
// MANEJAR ESTADO DE PAGO
// ============================================================
function mapPaymentStatus(mpStatus) {
  const statusMap = {
    approved: 'approved',
    rejected: 'rejected',
    cancelled: 'cancelled',
    pending: 'pending',
    in_process: 'in_process',
    refunded: 'refunded',
    charged_back: 'charged_back',
  };
  return statusMap[mpStatus] || 'pending';
}

function isPaymentApproved(mpStatus) {
  return mpStatus === 'approved';
}

function isPaymentFailed(mpStatus) {
  return ['rejected', 'cancelled', 'charged_back'].includes(mpStatus);
}

module.exports = {
  createPaymentPreference,
  createSaasSubscription,
  getPaymentInfo,
  cancelPreApproval,
  mapPaymentStatus,
  isPaymentApproved,
  isPaymentFailed,
};
