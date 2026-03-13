const supabase = require('../config/supabase');
const logger   = require('../config/logger');

async function getClientRanking(req, res) {
  try {
    const tenantId = req.tenantId;
    const { days = 30 } = req.query;

    const fromDate = new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    const [clientsRes, checkInsRes, workoutsRes] = await Promise.all([
      supabase.from('users')
        .select('id, full_name, email, phone, status, created_at')
        .eq('tenant_id', tenantId)
        .eq('role', 'client')
        .eq('status', 'active'),

      supabase.from('check_ins')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .gte('checked_in_at', fromDate),

      supabase.from('workout_logs')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .gte('logged_at', fromDate),
    ]);

    const clients  = clientsRes.data  || [];
    const checkIns = checkInsRes.data || [];
    const workouts = workoutsRes.data || [];

    // Contar por usuario
    const ciCount  = {};
    const wkCount  = {};
    for (const ci of checkIns) ciCount[ci.user_id] = (ciCount[ci.user_id] || 0) + 1;
    for (const wk of workouts) wkCount[wk.user_id] = (wkCount[wk.user_id] || 0) + 1;

    // Score = check-ins * 1 + workouts * 2 (workout vale más porque implica más engagement)
    const ranked = clients.map(c => ({
      ...c,
      check_ins:  ciCount[c.id] || 0,
      workouts:   wkCount[c.id] || 0,
      score:      (ciCount[c.id] || 0) + (wkCount[c.id] || 0) * 2,
    })).sort((a, b) => b.score - a.score);

    // Detectar en riesgo: tienen suscripción activa pero score = 0 en los últimos 14 días
    const at_risk = ranked.filter(c => c.score === 0);

    res.json({
      ranking: ranked.slice(0, 20),
      at_risk: at_risk.slice(0, 10),
      period_days: parseInt(days),
      total_active: clients.length,
    });
  } catch (err) {
    logger.error('getClientRanking error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// POST /admin/clients/payment-link-whatsapp — Link + WhatsApp en 1 gesto
// ============================================================

module.exports = { getClientRanking };
