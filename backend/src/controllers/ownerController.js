const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');
const emailService = require('../services/emailService');

// ============================================================
// DASHBOARD - Métricas globales del SaaS Owner
// ============================================================
async function getDashboard(req, res) {
  try {
    const [
      { count: totalGyms },
      { count: activeGyms },
      { count: blockedGyms },
      { data: recentPayments },
      { data: expiringSubscriptions },
    ] = await Promise.all([
      supabase.from('tenants').select('*', { count: 'exact', head: true }),
      supabase.from('tenants').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('tenants').select('*', { count: 'exact', head: true }).eq('status', 'blocked'),
      supabase.from('payments')
        .select('amount, status, created_at, tenants(name)')
        .eq('type', 'saas')
        .eq('status', 'approved')
        .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())
        .order('created_at', { ascending: false }),
      supabase.from('subscriptions')
        .select('*, tenants(name, email)')
        .eq('type', 'saas')
        .eq('status', 'active')
        .lte('end_date', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('end_date', { ascending: true }),
    ]);

    const monthlyRevenue = recentPayments?.reduce((sum, p) => sum + parseFloat(p.amount), 0) || 0;

    // Churn: gimnasios que cancelaron en los últimos 30 días
    const { count: churnCount } = await supabase
      .from('subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'saas')
      .in('status', ['cancelled', 'expired'])
      .gte('updated_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    res.json({
      metrics: {
        total_gyms: totalGyms || 0,
        active_gyms: activeGyms || 0,
        blocked_gyms: blockedGyms || 0,
        monthly_revenue: monthlyRevenue,
        churn_last_30_days: churnCount || 0,
      },
      expiring_subscriptions: expiringSubscriptions || [],
      recent_payments: recentPayments || [],
    });
  } catch (err) {
    logger.error('Owner getDashboard error:', err);
    res.status(500).json({ error: 'Error obteniendo dashboard' });
  }
}

// ============================================================
// LISTAR GIMNASIOS
// ============================================================
async function getGyms(req, res) {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    let query = supabase
      .from('tenants')
      .select(`
        *,
        users!users_tenant_id_fkey(count),
        subscriptions!subscriptions_tenant_id_fkey(status, end_date, amount)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ gyms: data, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('Owner getGyms error:', err);
    res.status(500).json({ error: 'Error obteniendo gimnasios' });
  }
}

// ============================================================
// CREAR GIMNASIO + ADMIN USER
// ============================================================
async function createGym(req, res) {
  try {
    const { name, email, phone, address, monthly_fee, admin_name, admin_password } = req.body;

    // 1. Crear tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({ name, email, phone, address, monthly_fee: monthly_fee || process.env.SAAS_MONTHLY_FEE })
      .select()
      .single();

    if (tenantError) {
      if (tenantError.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un gimnasio con ese email' });
      }
      throw tenantError;
    }

    // 2. Crear usuario admin en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: admin_password || Math.random().toString(36).slice(-8),
      email_confirm: true,
    });

    if (authError) {
      // Rollback tenant
      await supabase.from('tenants').delete().eq('id', tenant.id);
      throw authError;
    }

    // 3. Crear perfil admin
    const { data: adminUser, error: userError } = await supabase
      .from('users')
      .insert({
        tenant_id: tenant.id,
        auth_id: authData.user.id,
        email,
        full_name: admin_name || name,
        role: 'admin',
      })
      .select()
      .single();

    if (userError) throw userError;

    // 4. Crear suscripción SaaS (estado pending hasta confirmar pago)
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const { data: subscription } = await supabase
      .from('subscriptions')
      .insert({
        tenant_id: tenant.id,
        user_id: adminUser.id,
        type: 'saas',
        amount: tenant.monthly_fee,
        currency: process.env.SAAS_CURRENCY || 'ARS',
        start_date: new Date().toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status: 'pending',
      })
      .select()
      .single();

    logger.info(`Gym created: ${tenant.id} - ${name}`);

    // Enviar email de bienvenida al admin del gimnasio
    emailService.sendWelcomeGym({
      adminEmail: email,
      gymName: name,
      adminName: admin_name || name,
      tempPassword: admin_password || '(contraseña configurada)',
    }).catch(err => logger.error('Welcome email error:', err)); // no bloquear respuesta

    res.status(201).json({
      message: 'Gimnasio creado exitosamente',
      tenant,
      admin: adminUser,
      subscription,
    });
  } catch (err) {
    logger.error('Owner createGym error:', err);
    res.status(500).json({ error: 'Error creando gimnasio: ' + err.message });
  }
}

// ============================================================
// ACTUALIZAR ESTADO DEL GIMNASIO (bloquear/activar)
// ============================================================
async function updateGymStatus(req, res) {
  try {
    const { tenantId } = req.params;
    const { status, reason } = req.body;

    const { data, error } = await supabase
      .from('tenants')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', tenantId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Gimnasio no encontrado' });

    logger.info(`Gym ${tenantId} status updated to ${status}. Reason: ${reason || 'N/A'}`);

    res.json({ message: `Gimnasio ${status === 'blocked' ? 'bloqueado' : 'actualizado'}`, gym: data });
  } catch (err) {
    logger.error('Owner updateGymStatus error:', err);
    res.status(500).json({ error: 'Error actualizando estado' });
  }
}

// ============================================================
// VER DETALLE DE UN GIMNASIO
// ============================================================
async function getGymDetail(req, res) {
  try {
    const { tenantId } = req.params;

    const [
      { data: tenant },
      { data: users },
      { data: subscriptions },
      { data: payments },
    ] = await Promise.all([
      supabase.from('tenants').select('*').eq('id', tenantId).single(),
      supabase.from('users').select('id, full_name, email, role, status, created_at').eq('tenant_id', tenantId),
      supabase.from('subscriptions').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }),
      supabase.from('payments').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(10),
    ]);

    if (!tenant) return res.status(404).json({ error: 'Gimnasio no encontrado' });

    res.json({ tenant, users: users || [], subscriptions: subscriptions || [], payments: payments || [] });
  } catch (err) {
    logger.error('Owner getGymDetail error:', err);
    res.status(500).json({ error: 'Error obteniendo detalle del gimnasio' });
  }
}

// ============================================================
// GENERAR LINK DE PAGO SAAS PARA UN GIMNASIO
// ============================================================
async function generateSaasPaymentLink(req, res) {
  try {
    const { tenantId } = req.params;

    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    if (!tenant) return res.status(404).json({ error: 'Gimnasio no encontrado' });

    const externalRef = `saas-${tenantId}-${Date.now()}`;

    // Crear registro de pago pendiente
    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        type: 'saas',
        amount: tenant.monthly_fee,
        currency: process.env.SAAS_CURRENCY || 'ARS',
        status: 'pending',
        mp_external_reference: externalRef,
      })
      .select()
      .single();

    const preference = await mpService.createPaymentPreference({
      tenantId,
      userId: null,
      amount: tenant.monthly_fee,
      currency: process.env.SAAS_CURRENCY || 'ARS',
      description: `GymSaaS - ${tenant.name} - Suscripción mensual`,
      externalReference: externalRef,
    });

    // Actualizar con preference ID
    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    res.json({
      payment_url: preference.init_point,
      sandbox_url: preference.sandbox_init_point,
      preference_id: preference.id,
      external_reference: externalRef,
    });
  } catch (err) {
    logger.error('Owner generateSaasPaymentLink error:', err);
    res.status(500).json({ error: 'Error generando link de pago' });
  }
}

module.exports = {
  getDashboard,
  getGyms,
  createGym,
  updateGymStatus,
  getGymDetail,
  generateSaasPaymentLink,
};
