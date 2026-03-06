const supabase = require('../config/supabase');
const logger = require('../config/logger');

// Definición de todos los logros posibles
const ACHIEVEMENT_DEFINITIONS = {
  first_checkin:      { label: 'Primera visita',       emoji: '🏃', desc: 'Registraste tu primera asistencia' },
  checkins_7:         { label: '7 días seguidos',       emoji: '🔥', desc: 'Racha de 7 días consecutivos' },
  checkins_30:        { label: '30 asistencias',        emoji: '💪', desc: '30 visitas al gimnasio' },
  checkins_100:       { label: 'Centenario',            emoji: '🏅', desc: '100 visitas al gimnasio' },
  first_workout:      { label: 'Primer entrenamiento',  emoji: '📝', desc: 'Registraste tu primer workout' },
  workouts_10:        { label: '10 workouts',           emoji: '⚡', desc: '10 entrenamientos registrados' },
  first_pr:           { label: 'Primer PR',             emoji: '🏆', desc: 'Superaste tu record personal por primera vez' },
  prs_5:              { label: '5 records',             emoji: '🥇', desc: 'Lograste 5 records personales' },
  first_body_log:     { label: 'Seguimiento iniciado',  emoji: '📊', desc: 'Registraste tu primera medición' },
  weight_loss_5:      { label: '-5kg logrados',         emoji: '🌟', desc: 'Bajaste 5kg desde tu primer registro' },
};

// ============================================================
// POST /client/workout-log — Guardar workout + detectar PRs
// ============================================================
async function logWorkout(req, res) {
  try {
    const userId = req.user.id;
    const tenantId = req.tenantId;
    const { routine_id, exercises, notes, duration_minutes } = req.body;

    // Guardar el log
    const { data: log, error } = await supabase
      .from('workout_logs')
      .insert({ user_id: userId, tenant_id: tenantId, routine_id, exercises_data: exercises, notes, duration_minutes, logged_at: new Date().toISOString() })
      .select().single();

    if (error) throw error;

    // Detectar PRs
    const newPRs = [];
    for (const ex of (exercises || [])) {
      const sets = ex.sets?.filter(s => s.completed && s.weight && parseFloat(s.weight) > 0) || [];
      if (!sets.length) continue;

      const maxWeight = Math.max(...sets.map(s => parseFloat(s.weight)));
      const maxReps   = Math.max(...sets.map(s => parseInt(s.reps) || 0));

      // Buscar PR anterior para este ejercicio
      const { data: prevPR } = await supabase
        .from('personal_records')
        .select('weight_kg, reps')
        .eq('user_id', userId)
        .eq('exercise_name', ex.name)
        .order('weight_kg', { ascending: false })
        .limit(1)
        .single();

      const isNewPR = !prevPR || maxWeight > parseFloat(prevPR.weight_kg);

      if (isNewPR) {
        const { data: pr } = await supabase
          .from('personal_records')
          .insert({
            user_id: userId, tenant_id: tenantId,
            exercise_name: ex.name,
            weight_kg: maxWeight, reps: maxReps,
            workout_log_id: log.id,
          })
          .select().single();

        if (pr) newPRs.push({ exercise: ex.name, weight_kg: maxWeight, reps: maxReps, previous_kg: prevPR?.weight_kg || null });
      }
    }

    // Verificar logros nuevos
    const newAchievements = await checkAndGrantAchievements(userId, tenantId, { newPRs, log });

    res.status(201).json({
      message: 'Entrenamiento registrado',
      log,
      new_prs: newPRs,
      new_achievements: newAchievements,
    });
  } catch (err) {
    logger.error('logWorkout error:', err);
    res.status(500).json({ error: 'Error registrando entrenamiento: ' + err.message });
  }
}

// ============================================================
// GET /client/workout-logs
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

// ============================================================
// GET /client/prs — Records personales agrupados por ejercicio
// ============================================================
async function getPersonalRecords(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('personal_records')
      .select('*')
      .eq('user_id', userId)
      .order('achieved_at', { ascending: false });
    if (error) throw error;

    // Agrupar por ejercicio — solo el mejor de cada uno
    const byExercise = {};
    for (const pr of (data || [])) {
      if (!byExercise[pr.exercise_name] || pr.weight_kg > byExercise[pr.exercise_name].weight_kg) {
        byExercise[pr.exercise_name] = pr;
      }
    }

    // Historial completo por ejercicio (para el gráfico de evolución)
    const history = {};
    for (const pr of (data || [])) {
      if (!history[pr.exercise_name]) history[pr.exercise_name] = [];
      history[pr.exercise_name].push({ weight_kg: pr.weight_kg, date: pr.achieved_at });
    }

    res.json({
      prs: Object.values(byExercise).sort((a, b) => new Date(b.achieved_at) - new Date(a.achieved_at)),
      history,
      total: Object.keys(byExercise).length,
    });
  } catch (err) {
    logger.error('getPersonalRecords error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// POST /client/body-progress — Guardar medición corporal
// ============================================================
async function logBodyProgress(req, res) {
  try {
    const userId = req.user.id;
    const tenantId = req.tenantId;
    const { weight_kg, body_fat_pct, muscle_mass_kg, chest_cm, waist_cm, hips_cm, arm_cm, leg_cm, notes } = req.body;

    const { data, error } = await supabase
      .from('body_progress')
      .insert({ user_id: userId, tenant_id: tenantId, weight_kg, body_fat_pct, muscle_mass_kg, chest_cm, waist_cm, hips_cm, arm_cm, leg_cm, notes, measured_at: new Date().toISOString().split('T')[0] })
      .select().single();

    if (error) throw error;

    // Verificar logro de pérdida de peso
    const newAchievements = await checkAndGrantAchievements(userId, tenantId, { bodyLog: data });

    res.status(201).json({ message: 'Medición guardada', progress: data, new_achievements: newAchievements });
  } catch (err) {
    logger.error('logBodyProgress error:', err);
    res.status(500).json({ error: 'Error guardando medición: ' + err.message });
  }
}

// ============================================================
// GET /client/body-progress — Historial de mediciones
// ============================================================
async function getBodyProgress(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('body_progress')
      .select('*')
      .eq('user_id', userId)
      .order('measured_at', { ascending: true })
      .limit(30);
    if (error) throw error;

    // Calcular tendencia de peso
    const weights = (data || []).filter(d => d.weight_kg).map(d => ({ date: d.measured_at, value: parseFloat(d.weight_kg) }));
    const first = weights[0];
    const last  = weights[weights.length - 1];
    const weightDiff = (first && last && first !== last) ? (last.value - first.value).toFixed(1) : null;

    res.json({
      logs: data || [],
      weight_trend: weights,
      weight_diff: weightDiff ? parseFloat(weightDiff) : null,
      total_logs: data?.length || 0,
    });
  } catch (err) {
    logger.error('getBodyProgress error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// GET /client/achievements — Logros del usuario
// ============================================================
async function getAchievements(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('achievements')
      .select('*')
      .eq('user_id', userId)
      .order('achieved_at', { ascending: false });
    if (error) throw error;

    const unlocked = (data || []).map(a => ({
      ...a,
      ...(ACHIEVEMENT_DEFINITIONS[a.achievement_key] || { label: a.achievement_key, emoji: '🏅', desc: '' }),
    }));

    // Logros bloqueados (los que no tiene)
    const unlockedKeys = new Set(unlocked.map(a => a.achievement_key));
    const locked = Object.entries(ACHIEVEMENT_DEFINITIONS)
      .filter(([key]) => !unlockedKeys.has(key))
      .map(([key, def]) => ({ achievement_key: key, ...def, locked: true }));

    res.json({ unlocked, locked, total_unlocked: unlocked.length, total: Object.keys(ACHIEVEMENT_DEFINITIONS).length });
  } catch (err) {
    logger.error('getAchievements error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// HELPER — Verificar y otorgar logros
// ============================================================
async function checkAndGrantAchievements(userId, tenantId, context = {}) {
  const granted = [];

  async function grant(key) {
    const { error } = await supabase.from('achievements')
      .insert({ user_id: userId, tenant_id: tenantId, achievement_key: key })
      .select().single();
    if (!error) granted.push({ achievement_key: key, ...ACHIEVEMENT_DEFINITIONS[key] });
  }

  try {
    // PRs
    if (context.newPRs?.length > 0) {
      const { count } = await supabase.from('personal_records').select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (count === 1) await grant('first_pr');
      if (count >= 5) await grant('prs_5');
    }

    // Workouts
    if (context.log) {
      const { count } = await supabase.from('workout_logs').select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (count === 1) await grant('first_workout');
      if (count >= 10) await grant('workouts_10');
    }

    // Body progress
    if (context.bodyLog) {
      const { count } = await supabase.from('body_progress').select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (count === 1) await grant('first_body_log');

      // Pérdida de 5kg
      const { data: firstLog } = await supabase.from('body_progress').select('weight_kg').eq('user_id', userId).order('measured_at', { ascending: true }).limit(1).single();
      if (firstLog && context.bodyLog.weight_kg && (parseFloat(firstLog.weight_kg) - parseFloat(context.bodyLog.weight_kg)) >= 5) {
        await grant('weight_loss_5');
      }
    }
  } catch (e) {
    logger.error('checkAchievements error:', e);
  }

  return granted;
}

module.exports = { logWorkout, getWorkoutLogs, getPersonalRecords, logBodyProgress, getBodyProgress, getAchievements };
