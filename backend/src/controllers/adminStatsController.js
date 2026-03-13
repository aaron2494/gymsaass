const supabase = require('../config/supabase');
const logger   = require('../config/logger');
const mpService    = require('../services/mercadopago');
const emailService = require('../services/emailService');
const inviteStore  = require('../services/inviteStore');

async function getClientProgress(req, res) {
  try {
    const { id: clientId } = req.params;
    const tenantId = req.tenantId;
    const { page = 1, limit = 10 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);

    // Stats globales — query separada sin paginación para que sean exactas
    const { data: allLogs } = await supabase
      .from('workout_logs')
      .select('logged_at, duration_minutes, exercises_data')
      .eq('user_id', clientId)
      .eq('tenant_id', tenantId)
      .order('logged_at', { ascending: false });

    const totalWorkouts = allLogs?.length || 0;
    const totalMinutes  = (allLogs || []).reduce((s, l) => s + (l.duration_minutes || 0), 0);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeek = (allLogs || []).filter(l => new Date(l.logged_at) > oneWeekAgo).length;

    // Racha
    let streak = 0;
    const logDays = [...new Set((allLogs || []).map(l => l.logged_at?.split('T')[0]))].sort().reverse();
    for (let i = 0; i < logDays.length; i++) {
      const expected = new Date();
      expected.setDate(expected.getDate() - i);
      if (logDays[i] === expected.toISOString().split('T')[0]) streak++;
      else break;
    }

    // Lista paginada de logs con detalle completo
    const { data: logs, error: logsErr, count } = await supabase
      .from('workout_logs')
      .select('id, routine_id, exercises_data, notes, duration_minutes, logged_at', { count: 'exact' })
      .eq('user_id', clientId)
      .eq('tenant_id', tenantId)
      .order('logged_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (logsErr) throw logsErr;

    // PRs del cliente
    const { data: prs } = await supabase
      .from('personal_records')
      .select('exercise_name, weight_kg, reps, achieved_at')
      .eq('user_id', clientId)
      .order('achieved_at', { ascending: false })
      .limit(10);

    res.json({
      stats: { total_workouts: totalWorkouts, total_minutes: totalMinutes, this_week: thisWeek, streak },
      logs: logs || [],
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / parseInt(limit)),
      prs: prs || [],
    });
  } catch (err) {
    logger.error('getClientProgress error:', err);
    res.status(500).json({ error: 'Error obteniendo progreso: ' + err.message });
  }
}

module.exports = {
  getDashboard,
  getClients,
  createClient,
  updateClient,
  getRoutines,
  getRoutineById,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  assignRoutine,
  generateClientPaymentLink,
  getClientPayments,
  createClientSubscription,
};

// ============================================================
// GET /admin/clients/alerts — Clientes con deuda o sin asistencia
// ============================================================
async function getClientAlerts(req, res) {
  try {
    const tenantId = req.tenantId;
    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [clientsRes, checkInsRes] = await Promise.all([
      supabase.from('users')
        .select('id, full_name, email, phone, subscriptions(id, status, end_date, amount)')
        .eq('tenant_id', tenantId)
        .eq('role', 'client')
        .eq('status', 'active'),
      supabase.from('check_ins')
        .select('user_id, checked_in_at')
        .eq('tenant_id', tenantId)
        .gte('checked_in_at', fourteenDaysAgo),
    ]);

    const clients = clientsRes.data || [];
    const checkIns = checkInsRes.data || [];

    // Clientes con deuda (sin suscripción activa o vencida)
    const withDebt = clients.filter(c => {
      const activeSub = c.subscriptions?.find(s => s.status === 'active' && s.end_date >= today);
      return !activeSub;
    }).map(c => ({
      ...c,
      alert_type: 'debt',
      alert_label: 'Sin suscripción activa',
    }));

    // Clientes sin asistencia en 7 días
    const activeClientIds = new Set(checkIns.filter(ci => ci.checked_in_at >= sevenDaysAgo).map(ci => ci.user_id));
    const withoutAttendance = clients.filter(c => {
      const hasSub = c.subscriptions?.find(s => s.status === 'active' && s.end_date >= today);
      return hasSub && !activeClientIds.has(c.id);
    }).map(c => ({
      ...c,
      alert_type: 'no_attendance',
      alert_label: 'Sin asistencia hace +7 días',
    }));

    res.json({
      debt: withDebt,
      no_attendance: withoutAttendance,
      total_alerts: withDebt.length + withoutAttendance.length,
    });
  } catch (err) {
    logger.error('getClientAlerts error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// GET /admin/stats/monthly — Comparativa ingresos mes actual vs anterior
// ============================================================
async function getMonthlyStats(req, res) {
  try {
    const tenantId = req.tenantId;
    const now = new Date();

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString();

    const [thisMonth, lastMonth, newClientsThis, newClientsLast] = await Promise.all([
      supabase.from('payments').select('amount').eq('tenant_id', tenantId).eq('type', 'gym_client').eq('status', 'approved').gte('created_at', thisMonthStart),
      supabase.from('payments').select('amount').eq('tenant_id', tenantId).eq('type', 'gym_client').eq('status', 'approved').gte('created_at', lastMonthStart).lte('created_at', lastMonthEnd),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'client').gte('created_at', thisMonthStart),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'client').gte('created_at', lastMonthStart).lte('created_at', lastMonthEnd),
    ]);

    const thisRevenue = (thisMonth.data || []).reduce((s, p) => s + parseFloat(p.amount), 0);
    const lastRevenue = (lastMonth.data || []).reduce((s, p) => s + parseFloat(p.amount), 0);
    const diff = lastRevenue > 0 ? Math.round(((thisRevenue - lastRevenue) / lastRevenue) * 100) : 0;

    res.json({
      this_month: { revenue: thisRevenue, new_clients: newClientsThis.count || 0 },
      last_month: { revenue: lastRevenue, new_clients: newClientsLast.count || 0 },
      revenue_diff_pct: diff,
      is_growing: thisRevenue >= lastRevenue,
    });
  } catch (err) {
    logger.error('getMonthlyStats error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// PATCH /admin/clients/:id/deactivate — Dar de baja (mantiene datos)
// ============================================================
async function deactivateClient(req, res) {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    // Verificar que el cliente pertenece a este tenant
    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .single();

    if (findError || !user) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Desactivar usuario
    const { error } = await supabase
      .from('users')
      .update({ status: 'inactive' })
      .eq('id', id);

    if (error) throw error;

    // Cancelar suscripciones activas
    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('user_id', id)
      .eq('status', 'active');

    res.json({ message: `Cliente ${user.full_name} dado de baja` });
  } catch (err) {
    logger.error('deactivateClient error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// DELETE /admin/clients/:id — Eliminar permanentemente
// ============================================================
async function deleteClient(req, res) {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id, full_name, auth_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .single();

    if (findError || !user) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Eliminar de la tabla users (cascadea a subscriptions, payments, etc.)
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Eliminar de Supabase Auth
    if (user.auth_id) {
      await supabase.auth.admin.deleteUser(user.auth_id).catch(() => {});
    }

    res.json({ message: `Cliente ${user.full_name} eliminado` });
  } catch (err) {
    logger.error('deleteClient error:', err);
    res.status(500).json({ error: err.message });
  }
}


module.exports = { getClientProgress, getClientAlerts, getMonthlyStats, deactivateClient, deleteClient };
