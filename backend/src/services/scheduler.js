/**
 * SCHEDULER SERVICE
 *
 * Cron jobs de mantenimiento y alertas automáticas.
 * Sin dependencias externas: usa setInterval + lógica propia.
 *
 * Para producción real con más escala, reemplazar con:
 * - node-cron (npm install node-cron)
 * - Railway Cron Jobs
 * - Supabase pg_cron extension
 *
 * Jobs programados:
 *  - Cada día a las 9:00am: alertas de suscripciones por vencer
 *  - Cada lunes a las 8:00am: resumen semanal a admins
 *  - Cada día: recalcular health scores
 *  - Cada día: auto-bloquear gyms con SaaS vencido (+grace period)
 */

const supabase = require('../config/supabase');
const logger = require('../config/logger');
const emailService = require('./emailService');
const { calculateHealthScore, persistHealthScore } = require('./healthScore');

const GRACE_PERIOD_DAYS = 5; // días de gracia tras vencimiento SaaS antes de bloquear

// ============================================================
// INICIALIZAR TODOS LOS JOBS
// ============================================================
function startScheduler() {
  if (process.env.NODE_ENV === 'test') return;

  logger.info('🕐 Scheduler iniciado');

  // Ejecutar inmediatamente al arrancar (en desarrollo para probar)
  if (process.env.NODE_ENV === 'development') {
    setTimeout(() => runDailyJobs(), 5000);
  }

  // Job diario: verificar cada hora si ya es la hora objetivo
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // 9:00 AM → alertas diarias
    if (hour === 9 && minute < 10) {
      runDailyJobs();
    }

    // Lunes 8:00 AM → resumen semanal
    if (now.getDay() === 1 && hour === 8 && minute < 10) {
      runWeeklyDigest();
    }
  }, 10 * 60 * 1000); // check cada 10 minutos
}

// ============================================================
// JOBS DIARIOS
// ============================================================
async function runDailyJobs() {
  logger.info('Running daily jobs...');
  await Promise.allSettled([
    alertExpiringClientSubscriptions(),
    alertExpiringSaasSubscriptions(),
    autoBlockOverdueGyms(),
    recalculateAllHealthScores(),
  ]);
  logger.info('Daily jobs completed');
}

// ============================================================
// JOB: Alertar admin por suscripciones de CLIENTES por vencer
// ============================================================
async function alertExpiringClientSubscriptions() {
  try {
    const today = new Date();
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const tomorrow = new Date(today.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];

    // Suscripciones que vencen en exactamente 7 días o en 1 día (recordatorios puntuales)
    const { data: expiring } = await supabase
      .from('subscriptions')
      .select(`
        id, end_date, amount, tenant_id,
        users(id, full_name, email, phone),
        tenants(name, email)
      `)
      .eq('type', 'gym_client')
      .eq('status', 'active')
      .in('end_date', [in7Days, tomorrow]);

    if (!expiring?.length) return;

    // Enviar alerta AL CLIENTE (recordatorio personal)
    for (const sub of expiring) {
      const daysLeft = sub.end_date === tomorrow ? 1 : 7;
      const alertType = `client_expiry_${daysLeft}d`;

      // Verificar que no enviamos este alerta hoy para esta suscripción
      const { data: alreadySent } = await supabase
        .from('email_alerts_log')
        .select('id')
        .eq('alert_type', alertType)
        .eq('reference_id', sub.id)
        .single();

      if (alreadySent) continue;

      // Email al cliente
      if (sub.users?.email) {
        await emailService.sendClientSubscriptionReminderToClient({
          clientEmail: sub.users.email,
          clientName: sub.users.full_name,
          gymName: sub.tenants?.name || 'Tu gimnasio',
          endDate: sub.end_date,
          daysLeft,
        });
      }

      // Log para no re-enviar
      await supabase.from('email_alerts_log').insert({
        tenant_id: sub.tenant_id,
        user_id: sub.users?.id,
        alert_type: alertType,
        reference_id: sub.id,
        recipient_email: sub.users?.email,
      }).onConflict(['alert_type', 'reference_id']).ignore();
    }

    // Agrupar por tenant y enviar resumen al ADMIN (solo el de 7 días)
    const byTenant = {};
    for (const sub of expiring.filter(s => s.end_date === in7Days)) {
      const tid = sub.tenant_id;
      if (!byTenant[tid]) {
        byTenant[tid] = { tenantName: sub.tenants?.name, adminEmail: sub.tenants?.email, clients: [] };
      }
      byTenant[tid].clients.push({
        full_name: sub.users?.full_name,
        email: sub.users?.email,
        end_date: sub.end_date,
      });
    }

    for (const [tenantId, data] of Object.entries(byTenant)) {
      const alertType = `admin_expiry_7d_${todayStr}`;
      const { data: alreadySent } = await supabase
        .from('email_alerts_log')
        .select('id')
        .eq('alert_type', alertType)
        .eq('tenant_id', tenantId)
        .limit(1)
        .single();

      if (alreadySent) continue;

      await emailService.sendClientSubscriptionExpiring({
        adminEmail: data.adminEmail,
        gymName: data.tenantName,
        expiringClients: data.clients,
      });

      await supabase.from('email_alerts_log').insert({
        tenant_id: tenantId,
        alert_type: alertType,
        recipient_email: data.adminEmail,
      });
    }

    logger.info(`alertExpiringClientSubscriptions: procesadas ${expiring.length} suscripciones`);
  } catch (err) {
    logger.error('alertExpiringClientSubscriptions error:', err);
  }
}

// ============================================================
// JOB: Alertar admin por suscripción SaaS por vencer
// ============================================================
async function alertExpiringSaasSubscriptions() {
  try {
    const today = new Date();

    for (const daysAhead of [7, 3, 1]) {
      const targetDate = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

      const { data: expiring } = await supabase
        .from('subscriptions')
        .select('*, tenants(id, name, email, status)')
        .eq('type', 'saas')
        .eq('status', 'active')
        .eq('end_date', targetDate);

      if (!expiring?.length) continue;

      for (const sub of expiring) {
        if (sub.tenants?.status === 'blocked') continue; // ya bloqueado, no alertar

        const alertType = `saas_expiry_${daysAhead}d`;
        const { data: alreadySent } = await supabase
          .from('email_alerts_log')
          .select('id')
          .eq('alert_type', alertType)
          .eq('reference_id', sub.id)
          .single();

        if (alreadySent) continue;

        await emailService.sendSaasSubscriptionExpiring({
          adminEmail: sub.tenants.email,
          gymName: sub.tenants.name,
          endDate: sub.end_date,
          daysLeft: daysAhead,
          paymentUrl: null, // se puede generar dinámicamente
        });

        await supabase.from('email_alerts_log').insert({
          tenant_id: sub.tenant_id,
          alert_type: alertType,
          reference_id: sub.id,
          recipient_email: sub.tenants.email,
        }).onConflict(['alert_type', 'reference_id']).ignore();
      }
    }
  } catch (err) {
    logger.error('alertExpiringSaasSubscriptions error:', err);
  }
}

// ============================================================
// JOB: Auto-bloquear gimnasios con SaaS vencido (+ grace period)
// ============================================================
async function autoBlockOverdueGyms() {
  try {
    const graceDate = new Date();
    graceDate.setDate(graceDate.getDate() - GRACE_PERIOD_DAYS);
    const graceDateStr = graceDate.toISOString().split('T')[0];

    // Subs SaaS vencidas hace más de GRACE_PERIOD_DAYS días y gym todavía activo
    const { data: overdueGyms } = await supabase
      .from('subscriptions')
      .select('tenant_id, end_date, tenants(name, email, status)')
      .eq('type', 'saas')
      .eq('status', 'active') // activa en nuestra DB pero la fecha ya pasó
      .lt('end_date', graceDateStr)
      .eq('tenants.status', 'active');

    if (!overdueGyms?.length) return;

    for (const sub of overdueGyms) {
      await supabase.from('tenants')
        .update({ status: 'blocked' })
        .eq('id', sub.tenant_id);

      // Marcar suscripción como expirada
      await supabase.from('subscriptions')
        .update({ status: 'expired' })
        .eq('tenant_id', sub.tenant_id)
        .eq('type', 'saas')
        .eq('end_date', sub.end_date);

      logger.info(`Auto-blocked gym ${sub.tenant_id} (${sub.tenants?.name}) - overdue since ${sub.end_date}`);
    }

    logger.info(`autoBlockOverdueGyms: ${overdueGyms.length} gym(s) procesados`);
  } catch (err) {
    logger.error('autoBlockOverdueGyms error:', err);
  }
}

// ============================================================
// JOB: Recalcular health scores de todos los gyms activos
// ============================================================
async function recalculateAllHealthScores() {
  try {
    const { data: tenants } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('status', 'active');

    if (!tenants?.length) return;

    for (const tenant of tenants) {
      const result = await calculateHealthScore(tenant.id);
      await persistHealthScore(tenant.id, result.score);
    }

    logger.info(`recalculateAllHealthScores: ${tenants.length} gym(s) actualizados`);
  } catch (err) {
    logger.error('recalculateAllHealthScores error:', err);
  }
}

// ============================================================
// JOB SEMANAL: Resumen semanal a admins
// ============================================================
async function runWeeklyDigest() {
  try {
    logger.info('Running weekly digest...');

    const { data: tenants } = await supabase
      .from('tenants')
      .select('id, name, email, health_score, status')
      .eq('status', 'active');

    for (const tenant of tenants || []) {
      const result = await calculateHealthScore(tenant.id);
      result.stats.healthScore = result.score;

      await emailService.sendWeeklyDigest({
        adminEmail: tenant.email,
        gymName: tenant.name,
        stats: result.stats,
      });
    }

    logger.info(`Weekly digest enviado a ${tenants?.length || 0} admins`);
  } catch (err) {
    logger.error('runWeeklyDigest error:', err);
  }
}

// Exportar para poder disparar manualmente desde rutas de admin/owner
module.exports = {
  startScheduler,
  runDailyJobs,
  runWeeklyDigest,
  alertExpiringClientSubscriptions,
  autoBlockOverdueGyms,
  recalculateAllHealthScores,
};
