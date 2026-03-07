const supabase = require('../config/supabase');
const logger = require('../config/logger');

// ============================================================
// PERFIL DEL CLIENTE
// ============================================================
async function getProfile(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, email, phone, status, created_at, tenants(name, address, phone)')
      .eq('id', userId)
      .single();

    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    logger.error('Client getProfile error:', err);
    res.status(500).json({ error: 'Error obteniendo perfil' });
  }
}

// ============================================================
// RUTINA ACTIVA DEL CLIENTE
// ============================================================
async function getMyRoutine(req, res) {
  try {
    const userId = req.user.id;
    const tenantId = req.tenantId;

    // Verificar suscripción activa
    const today = new Date().toISOString().split('T')[0];
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('id, end_date')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('type', 'gym_client')
      .eq('status', 'active')
      .gte('end_date', today)
      .limit(1)
      .single();

    if (!sub) {
      return res.status(403).json({
        error: 'subscription_required',
        message: 'Necesitás una suscripción activa para ver tu rutina.',
      });
    }

    const { data, error } = await supabase
      .from('user_routines')
      .select(`
        id, assigned_at, notes, is_active,
        routines(
          id, name, description, days_per_week, difficulty,
          exercises(
            id, day_number, name, muscle_group, sets, reps,
            rest_seconds, weight_kg, notes, video_url, order_index
          )
        )
      `)
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
      return res.json({ routine: null, message: 'No tienes una rutina asignada aún' });
    }

    // Ordenar ejercicios por día y luego por order_index
    if (data.routines?.exercises) {
      data.routines.exercises.sort((a, b) => {
        if (a.day_number !== b.day_number) return a.day_number - b.day_number;
        return a.order_index - b.order_index;
      });
    }

    res.json({ assignment: data, routine: data.routines });
  } catch (err) {
    logger.error('Client getMyRoutine error:', err);
    res.status(500).json({ error: 'Error obteniendo rutina' });
  }
}

// ============================================================
// SUSCRIPCIÓN ACTIVA DEL CLIENTE
// ============================================================
async function getMySubscription(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('type', 'gym_client')
      .in('status', ['active', 'pending'])
      .order('end_date', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
      return res.json({ subscription: null, status: 'no_subscription' });
    }

    const today = new Date();
    const endDate = new Date(data.end_date);
    const daysUntilExpiry = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

    res.json({
      subscription: data,
      days_until_expiry: daysUntilExpiry,
      is_expiring_soon: daysUntilExpiry <= 7 && daysUntilExpiry > 0,
      is_expired: daysUntilExpiry <= 0,
    });
  } catch (err) {
    logger.error('Client getMySubscription error:', err);
    res.status(500).json({ error: 'Error obteniendo suscripción' });
  }
}

// ============================================================
// HISTORIAL DE PAGOS DEL CLIENTE
// ============================================================
async function getMyPayments(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('payments')
      .select('id, amount, currency, status, payment_date, payment_method, created_at')
      .eq('user_id', userId)
      .eq('type', 'gym_client')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json({ payments: data });
  } catch (err) {
    logger.error('Client getMyPayments error:', err);
    res.status(500).json({ error: 'Error obteniendo pagos' });
  }
}



// ============================================================
// POST /client/workout-log — Registrar entrenamiento completado
// ============================================================
async function logWorkout(req, res) {
  try {
    const userId = req.user.id;
    const tenantId = req.tenantId;
    const { routine_id, exercises, notes, duration_minutes } = req.body;

    const { data, error } = await supabase
      .from('workout_logs')
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        routine_id,
        exercises_data: exercises, // JSON con series/reps/peso de cada ejercicio
        notes,
        duration_minutes,
        logged_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Entrenamiento registrado', log: data });
  } catch (err) {
    logger.error('logWorkout error:', err);
    res.status(500).json({ error: 'Error registrando entrenamiento: ' + err.message });
  }
}

// ============================================================
// GET /client/workout-logs — Historial de entrenamientos
// ============================================================
async function getWorkoutLogs(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('workout_logs')
      .select('*')
      .eq('user_id', userId)
      .order('logged_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json({ logs: data || [] });
  } catch (err) {
    logger.error('getWorkoutLogs error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getProfile, getMyRoutine, getMySubscription, getMyPayments,
  logWorkout, getWorkoutLogs,
};
