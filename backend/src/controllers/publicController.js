/**
 * PUBLIC REGISTRATION CONTROLLER
 * No requiere autenticación — es el flujo de auto-registro del dueño del gym.
 *
 * Flujo:
 * 1. POST /public/register → crea tenant + admin user + genera link de pago MP
 * 2. MP webhook confirma pago → activa la cuenta (ya manejado en webhookController)
 * 3. Admin hace login normalmente
 */

const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');
const emailService = require('../services/emailService');

// ============================================================
// PLANES DISPONIBLES
// ============================================================
const PLANS = {
  basic: {
    name: 'Básico',
    price: 1,
    currency: 'ARS',
    max_clients: 50,
    features: ['Hasta 50 clientes', 'Rutinas ilimitadas', 'Check-ins', 'Avisos'],
  },
  pro: {
    name: 'Pro',
    price: 2,
    currency: 'ARS',
    max_clients: 200,
    features: ['Hasta 200 clientes', 'Todo lo del básico', 'Health Score', 'Soporte prioritario'],
  },
};

// ============================================================
// GET /public/plans — Obtener planes disponibles
// ============================================================
async function getPlans(req, res) {
  res.json({ plans: PLANS });
}

// ============================================================
// POST /public/register — Registrar nuevo gimnasio
// ============================================================
async function register(req, res) {
  const { gym_name, email, admin_name, password, phone, plan = 'basic' } = req.body;

  // Validaciones básicas
  if (!gym_name?.trim() || !email?.trim() || !password || !admin_name?.trim()) {
    return res.status(400).json({ error: 'Nombre del gym, email, nombre y contraseña son requeridos' });
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Plan inválido' });
  }

  const selectedPlan = PLANS[plan];

  try {
    // 1. Verificar que el email no esté ya registrado
    const { data: existingAuth } = await supabase.auth.admin.listUsers();
    const emailExists = existingAuth?.users?.some(u => u.email === email.toLowerCase().trim());
    if (emailExists) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
    }

    // 2. Crear tenant en estado "pending" (se activa al confirmar pago)
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name: gym_name.trim(),
        email: email.toLowerCase().trim(),
        phone: phone || null,
        status: 'inactive', // se activa cuando paga
        plan,
        monthly_fee: selectedPlan.price,
      })
      .select()
      .single();

    if (tenantError) {
      if (tenantError.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un gimnasio con ese email' });
      }
      throw tenantError;
    }

    // 3. Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: { tenant_id: tenant.id, role: 'admin' },
    });

    if (authError) {
      await supabase.from('tenants').delete().eq('id', tenant.id);
      throw authError;
    }

    // 4. Crear perfil de admin
    const { data: adminUser, error: userError } = await supabase
      .from('users')
      .insert({
        tenant_id: tenant.id,
        auth_id: authData.user.id,
        email: email.toLowerCase().trim(),
        full_name: admin_name.trim(),
        phone: phone || null,
        role: 'admin',
        status: 'active',
      })
      .select()
      .single();

    if (userError) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      await supabase.from('tenants').delete().eq('id', tenant.id);
      throw userError;
    }

    // 5. Crear suscripción SaaS en estado pending
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const { data: subscription } = await supabase
      .from('subscriptions')
      .insert({
        tenant_id: tenant.id,
        user_id: adminUser.id,
        type: 'saas',
        amount: selectedPlan.price,
        currency: selectedPlan.currency,
        start_date: new Date().toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status: 'pending',
      })
      .select()
      .single();

    // 6. Generar link de pago MercadoPago
    const externalRef = `saas-register-${tenant.id}-${Date.now()}`;

    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenant.id,
        user_id: adminUser.id,
        type: 'saas',
        amount: selectedPlan.price,
        currency: selectedPlan.currency,
        status: 'pending',
        mp_external_reference: externalRef,
        metadata: { plan, registration: true },
      })
      .select()
      .single();

    const preference = await mpService.createPaymentPreference({
      tenantId: tenant.id,
      userId: adminUser.id,
      amount: selectedPlan.price,
      currency: selectedPlan.currency,
      description: `GymSaaS ${selectedPlan.name} — ${gym_name}`,
      externalReference: externalRef,
    });

    await supabase.from('payments')
      .update({ mp_preference_id: preference.id })
      .eq('id', payment.id);

    // 7. Email de bienvenida con link de pago
    emailService.sendWelcomeGym({
      adminEmail: email,
      gymName: gym_name,
      adminName: admin_name,
      tempPassword: password,
    }).catch(() => {});

    logger.info(`New gym registered: ${tenant.id} - ${gym_name} - plan: ${plan}`);

    res.status(201).json({
      message: 'Cuenta creada. Completá el pago para activarla.',
      tenant_id: tenant.id,
      payment_url: preference.init_point,
      external_reference: externalRef,
      plan: selectedPlan,
    });

  } catch (err) {
    logger.error('Public register error:', err);
    res.status(500).json({ error: 'Error al crear la cuenta: ' + err.message });
  }
}


// ============================================================
// GET /public/register/status/:externalRef — Verificar si el pago fue aprobado
// Polling desde la app para saber cuándo activar el acceso
// ============================================================
async function checkRegistrationStatus(req, res) {
  try {
    const { externalRef } = req.params;

    const { data: payment } = await supabase
      .from('payments')
      .select('status, tenant_id, tenants(status, name)')
      .eq('mp_external_reference', externalRef)
      .single();

    if (!payment) {
      return res.status(404).json({ error: 'Referencia no encontrada' });
    }

    res.json({
      payment_status: payment.status,
      tenant_status: payment.tenants?.status,
      gym_name: payment.tenants?.name,
      is_active: payment.tenants?.status === 'active' && payment.status === 'approved',
    });
  } catch (err) {
    logger.error('checkRegistrationStatus error:', err);
    res.status(500).json({ error: 'Error verificando estado' });
  }
}
// POST /public/activate — activar cuenta cuando el webhook no llegó
async function activateAfterPayment(req, res) {
  try {
    const { external_reference } = req.body;

    const { data: payment } = await supabase
      .from('payments')
      .select('*, tenants(status)')
      .eq('mp_external_reference', external_reference)
      .single();

    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    if (payment.tenants?.status === 'active') {
      return res.json({ already_active: true });
    }

    // Verificar con MercadoPago si el pago está aprobado
    const mpService = require('../services/mercadopago');
    
    // Buscar el pago por external_reference en MP
    const { data: mpPayments } = await supabase
      .from('payments')
      .select('mp_payment_id')
      .eq('mp_external_reference', external_reference)
      .not('mp_payment_id', 'is', null)
      .single();

    if (mpPayments?.mp_payment_id) {
      const mpPayment = await mpService.getPaymentInfo(mpPayments.mp_payment_id);
      if (mpPayment.status !== 'approved') {
        return res.json({ pending: true, mp_status: mpPayment.status });
      }
    }

    // Activar el tenant
    await supabase.from('tenants')
      .update({ status: 'active' })
      .eq('id', payment.tenant_id);

    await supabase.from('payments')
      .update({ status: 'approved' })
      .eq('mp_external_reference', external_reference);

    await supabase.from('subscriptions')
      .update({ status: 'active' })
      .eq('tenant_id', payment.tenant_id)
      .eq('type', 'saas');

    res.json({ activated: true });
  } catch (err) {
    logger.error('activateAfterPayment error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getPlans, register, checkRegistrationStatus, activateAfterPayment };

