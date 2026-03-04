/**
 * HEALTH SCORE SERVICE
 *
 * Calcula un score 0-100 por gimnasio que refleja la "salud" del negocio.
 * Se muestra al admin para que vea el valor del SaaS y tenga incentivo a mejorar.
 *
 * Ponderación:
 *  - 40pts: % de clientes con suscripción activa
 *  - 25pts: % de clientes con rutina asignada
 *  - 20pts: check-ins en los últimos 7 días (normalizado)
 *  - 15pts: retención (clientes activos este mes vs mes anterior)
 */

const supabase = require('../config/supabase');
const logger = require('../config/logger');

async function calculateHealthScore(tenantId) {
  try {
    const today = new Date();
    const sevenDaysAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(today - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(today - 60 * 24 * 60 * 60 * 1000);

    const [
      { count: totalClients },
      { count: clientsWithActiveSub },
      { count: clientsWithRoutine },
      { count: checkInsThisWeek },
      { count: newClientsThisMonth },
      { count: newClientsLastMonth },
    ] = await Promise.all([
      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('role', 'client').eq('status', 'active'),

      supabase.from('subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('type', 'gym_client').eq('status', 'active'),

      supabase.from('user_routines')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('is_active', true),

      supabase.from('check_ins')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('checked_in_at', sevenDaysAgo.toISOString()),

      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('role', 'client')
        .gte('created_at', thirtyDaysAgo.toISOString()),

      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('role', 'client')
        .gte('created_at', sixtyDaysAgo.toISOString())
        .lt('created_at', thirtyDaysAgo.toISOString()),
    ]);

    const total = totalClients || 0;
    if (total === 0) return { score: 0, breakdown: {}, stats: buildStats(0, 0, 0, 0, 0, 0) };

    // ---- Componente 1: % con suscripción activa (40 pts) ----
    const subRatio = Math.min(clientsWithActiveSub / total, 1);
    const subScore = Math.round(subRatio * 40);

    // ---- Componente 2: % con rutina asignada (25 pts) ----
    const routineRatio = Math.min(clientsWithRoutine / total, 1);
    const routineScore = Math.round(routineRatio * 25);

    // ---- Componente 3: check-ins (20 pts) ----
    // Esperamos al menos 1 check-in por cliente activo por semana = 100%
    const expectedCheckIns = Math.max(clientsWithActiveSub, 1);
    const checkInRatio = Math.min(checkInsThisWeek / expectedCheckIns, 1);
    const checkInScore = Math.round(checkInRatio * 20);

    // ---- Componente 4: crecimiento/retención (15 pts) ----
    // Si agregaron al menos tantos como el mes anterior → 100%
    const growthRatio = newClientsLastMonth > 0
      ? Math.min(newClientsThisMonth / newClientsLastMonth, 1)
      : newClientsThisMonth > 0 ? 1 : 0.5; // si no había clientes antes, score neutro
    const growthScore = Math.round(growthRatio * 15);

    const score = subScore + routineScore + checkInScore + growthScore;

    // Calcular suscripciones por vencer
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const { count: expiringCount } = await supabase
      .from('subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('type', 'gym_client').eq('status', 'active')
      .lte('end_date', in7Days.toISOString().split('T')[0]);

    const stats = buildStats(total, clientsWithActiveSub, clientsWithRoutine, checkInsThisWeek, newClientsThisMonth, expiringCount || 0);

    return {
      score,
      breakdown: {
        subscriptions: { score: subScore, max: 40, ratio: Math.round(subRatio * 100) },
        routines: { score: routineScore, max: 25, ratio: Math.round(routineRatio * 100) },
        checkins: { score: checkInScore, max: 20, ratio: Math.round(checkInRatio * 100) },
        growth: { score: growthScore, max: 15, ratio: Math.round(growthRatio * 100) },
      },
      stats,
    };
  } catch (err) {
    logger.error(`calculateHealthScore error for tenant ${tenantId}:`, err);
    return { score: 0, breakdown: {}, stats: {} };
  }
}

function buildStats(total, activeSubs, withRoutine, checkIns, newThisMonth, expiring) {
  return {
    totalClients: total,
    activeClients: activeSubs,
    clientsWithRoutine: withRoutine,
    checkInsThisWeek: checkIns,
    newClientsThisMonth: newThisMonth,
    expiringCount: expiring,
    healthScore: 0, // se sobreescribe desde el caller
  };
}

/**
 * Persiste el health score en la tabla tenants
 */
async function persistHealthScore(tenantId, score) {
  await supabase.from('tenants').update({
    health_score: score,
    health_score_updated_at: new Date().toISOString(),
  }).eq('id', tenantId);
}

/**
 * Genera sugerencias accionables basadas en el breakdown
 */
function generateSuggestions(breakdown, stats) {
  const suggestions = [];

  if (breakdown.subscriptions?.ratio < 80) {
    suggestions.push({
      type: 'warning',
      icon: '💳',
      title: 'Suscripciones bajas',
      action: `${stats.totalClients - stats.activeClients} clientes sin suscripción activa. Generá links de pago.`,
    });
  }

  if (breakdown.routines?.ratio < 70) {
    suggestions.push({
      type: 'info',
      icon: '📋',
      title: 'Clientes sin rutina',
      action: `${stats.totalClients - stats.clientsWithRoutine} clientes no tienen rutina asignada. Asigná una para mejorar la retención.`,
    });
  }

  if (breakdown.checkins?.ratio < 50) {
    suggestions.push({
      type: 'info',
      icon: '✅',
      title: 'Baja asistencia registrada',
      action: 'Registrá la asistencia de tus clientes para trackear mejor el negocio.',
    });
  }

  if (stats.expiringCount > 0) {
    suggestions.push({
      type: 'urgent',
      icon: '⚠️',
      title: `${stats.expiringCount} suscripción(es) por vencer`,
      action: 'Contactá a estos clientes antes de que pierdan acceso.',
    });
  }

  return suggestions;
}

module.exports = { calculateHealthScore, persistHealthScore, generateSuggestions };
