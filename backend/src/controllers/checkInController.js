const supabase = require('../config/supabase');
const logger = require('../config/logger');

// ============================================================
// CLIENTE: Auto check-in (cliente registra su propia asistencia)
// ============================================================
async function selfCheckIn(req, res) {
  try {
    const userId = req.user.id;
    const tenantId = req.tenantId;

    // Verificar que no hizo check-in hoy ya
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: existing } = await supabase
      .from('check_ins')
      .select('id, checked_in_at')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .gte('checked_in_at', todayStart.toISOString())
      .single();

    if (existing) {
      return res.status(409).json({
        error: 'Ya registraste tu asistencia hoy',
        checked_in_at: existing.checked_in_at,
      });
    }

    const { data, error } = await supabase
      .from('check_ins')
      .insert({ tenant_id: tenantId, user_id: userId })
      .select()
      .single();

    if (error) throw error;

    // Verificar logros de check-in
    const newAchievements = [];
    try {
      const { count } = await supabase.from('check_ins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('tenant_id', tenantId);
      const achievementKeys = [];
      if (count === 1)   achievementKeys.push('first_checkin');
      if (count >= 30)   achievementKeys.push('checkins_30');
      if (count >= 100)  achievementKeys.push('checkins_100');
      for (const key of achievementKeys) {
        const { error: ae } = await supabase.from('achievements').insert({ user_id: userId, tenant_id: tenantId, achievement_key: key });
        if (!ae) newAchievements.push(key);
      }
    } catch (_) {}

    res.status(201).json({ message: '¡Asistencia registrada! 💪', check_in: data, new_achievements: newAchievements });
  } catch (err) {
    logger.error('selfCheckIn error:', err);
    res.status(500).json({ error: 'Error registrando asistencia' });
  }
}

// ============================================================
// CLIENTE: Ver historial de asistencia propio
// ============================================================
async function getMyCheckIns(req, res) {
  try {
    const userId = req.user.id;
    const { limit = 30 } = req.query;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await supabase
      .from('check_ins')
      .select('id, checked_in_at, notes')
      .eq('user_id', userId)
      .gte('checked_in_at', thirtyDaysAgo.toISOString())
      .order('checked_in_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    // Calcular racha actual
    const streak = calculateStreak(data || []);

    res.json({ check_ins: data || [], total_this_month: data?.length || 0, streak });
  } catch (err) {
    logger.error('getMyCheckIns error:', err);
    res.status(500).json({ error: 'Error obteniendo asistencia' });
  }
}

// ============================================================
// ADMIN: Registrar check-in manual para un cliente
// ============================================================
async function adminCheckIn(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, notes } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    // Verificar que el cliente pertenece al tenant
    const { data: client } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('id', user_id)
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .single();

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { data, error } = await supabase
      .from('check_ins')
      .insert({
        tenant_id: tenantId,
        user_id,
        registered_by: req.user.id,
        notes,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      message: `Asistencia de ${client.full_name} registrada`,
      check_in: data,
    });
  } catch (err) {
    logger.error('adminCheckIn error:', err);
    res.status(500).json({ error: 'Error registrando asistencia' });
  }
}

// ============================================================
// ADMIN: Ver asistencia del gimnasio (reporte)
// ============================================================
async function getGymAttendance(req, res) {
  try {
    const tenantId = req.tenantId;
    const { days = 7 } = req.query;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - parseInt(days));

    const { data, error } = await supabase
      .from('check_ins')
      .select(`
        id, checked_in_at,
        users(id, full_name, email)
      `)
      .eq('tenant_id', tenantId)
      .gte('checked_in_at', fromDate.toISOString())
      .order('checked_in_at', { ascending: false });

    if (error) throw error;

    // Agrupar por día para el gráfico
    const byDay = {};
    for (const ci of data || []) {
      const day = ci.checked_in_at.split('T')[0];
      byDay[day] = (byDay[day] || 0) + 1;
    }

    // Top clientes más asistentes
    const byClient = {};
    for (const ci of data || []) {
      const uid = ci.users?.id;
      if (!uid) continue;
      if (!byClient[uid]) byClient[uid] = { ...ci.users, count: 0 };
      byClient[uid].count++;
    }
    const topClients = Object.values(byClient).sort((a, b) => b.count - a.count).slice(0, 5);

    res.json({
      check_ins: data || [],
      total: data?.length || 0,
      by_day: byDay,
      top_clients: topClients,
      period_days: parseInt(days),
    });
  } catch (err) {
    logger.error('getGymAttendance error:', err);
    res.status(500).json({ error: 'Error obteniendo asistencia' });
  }
}

// ============================================================
// HELPER: Calcular racha de días consecutivos
// ============================================================
function calculateStreak(checkIns) {
  if (!checkIns.length) return 0;

  const days = [...new Set(checkIns.map(ci => ci.checked_in_at.split('T')[0]))].sort().reverse();

  let streak = 0;
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // La racha puede empezar hoy o ayer
  if (days[0] !== today && days[0] !== yesterday) return 0;

  let expected = days[0];
  for (const day of days) {
    if (day === expected) {
      streak++;
      const prev = new Date(expected);
      prev.setDate(prev.getDate() - 1);
      expected = prev.toISOString().split('T')[0];
    } else {
      break;
    }
  }

  return streak;
}

module.exports = { selfCheckIn, getMyCheckIns, adminCheckIn, getGymAttendance };
