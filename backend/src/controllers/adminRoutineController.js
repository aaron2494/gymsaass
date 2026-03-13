const supabase = require('../config/supabase');
const logger   = require('../config/logger');

async function getRoutines(req, res) {
  try {
    const tenantId = req.tenantId;
    const { page = 1, limit = 20, search } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('routines')
      .select('*, exercises(count)', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (search) query = query.ilike('name', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      routines: data,
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / parseInt(limit)),
    });
  } catch (err) {
    logger.error('Admin getRoutines error:', err);
    res.status(500).json({ error: 'Error obteniendo rutinas' });
  }
}

async function getRoutineById(req, res) {
  try {
    const { routineId } = req.params;
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('routines')
      .select('*, exercises(*)')
      .eq('id', routineId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Rutina no encontrada' });
    res.json({ routine: data });
  } catch (err) {
    logger.error('Admin getRoutineById error:', err);
    res.status(500).json({ error: 'Error obteniendo rutina' });
  }
}

async function createRoutine(req, res) {
  try {
    const tenantId = req.tenantId;
    const { name, description, days_per_week, difficulty, exercises } = req.body;

    const { data: routine, error } = await supabase
      .from('routines')
      .insert({ tenant_id: tenantId, name, description, days_per_week, difficulty, created_by: req.user.id })
      .select()
      .single();

    if (error) throw error;

    if (exercises && exercises.length > 0) {
      const exercisesData = exercises.map((ex, idx) => ({
        routine_id:   routine.id,
        day_number:   ex.day_number   || 1,
        name:         ex.name,
        muscle_group: ex.muscle_group || '',
        sets:         parseInt(ex.sets)         || 3,
        reps:         String(ex.reps            || '10'),
        rest_seconds: parseInt(ex.rest_seconds) || 60,
        weight_kg:    ex.weight_kg    || null,
        notes:        ex.notes        || null,
        video_url:    ex.video_url    || null,
        order_index:  ex.order_index  ?? idx,
      }));

      const { error: exError } = await supabase.from('exercises').insert(exercisesData);
      if (exError) throw exError;
    }

    const { data: fullRoutine } = await supabase
      .from('routines')
      .select('*, exercises(*)')
      .eq('id', routine.id)
      .single();

    res.status(201).json({ message: 'Rutina creada', routine: fullRoutine });
  } catch (err) {
    logger.error('Admin createRoutine error:', err);
    res.status(500).json({ error: 'Error creando rutina' });
  }
}

async function updateRoutine(req, res) {
  try {
    const { routineId } = req.params;
    const tenantId = req.tenantId;
    const { name, description, days_per_week, difficulty } = req.body;

    const { data, error } = await supabase
      .from('routines')
      .update({ name, description, days_per_week, difficulty })
      .eq('id', routineId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Rutina no encontrada' });

    res.json({ message: 'Rutina actualizada', routine: data });
  } catch (err) {
    logger.error('Admin updateRoutine error:', err);
    res.status(500).json({ error: 'Error actualizando rutina' });
  }
}

async function deleteRoutine(req, res) {
  try {
    const { routineId } = req.params;
    const tenantId = req.tenantId;

    // Verificar que no esté asignada a usuarios activos
    const { count } = await supabase
      .from('user_routines')
      .select('*', { count: 'exact', head: true })
      .eq('routine_id', routineId)
      .eq('is_active', true);

    if (count > 0) {
      return res.status(400).json({ error: 'No se puede eliminar: la rutina está asignada a clientes activos' });
    }

    const { error } = await supabase
      .from('routines')
      .delete()
      .eq('id', routineId)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ message: 'Rutina eliminada' });
  } catch (err) {
    logger.error('Admin deleteRoutine error:', err);
    res.status(500).json({ error: 'Error eliminando rutina' });
  }
}

// ============================================================
// ASIGNAR RUTINA A CLIENTE
// ============================================================
async function assignRoutine(req, res) {
  try {
    const tenantId = req.tenantId;

    // Aceptar user_id en distintos formatos por si el cliente manda distinto
    const user_id    = req.body.user_id || req.body.userId || req.body.client_id;
    const routine_id = req.body.routine_id || req.body.routineId;
    const notes      = req.body.notes;

    logger.info('assignRoutine body: ' + JSON.stringify(req.body));
    logger.info('assignRoutine parsed: ' + JSON.stringify({ user_id, routine_id }));

    if (!user_id)    return res.status(400).json({ error: 'user_id requerido' });
    if (!routine_id) return res.status(400).json({ error: 'routine_id requerido' });

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(user_id))    return res.status(400).json({ error: `user_id inválido: "${user_id}"` });
    if (!uuidRe.test(routine_id)) return res.status(400).json({ error: `routine_id inválido: "${routine_id}"` });

    // Desactivar rutinas anteriores del usuario
    await supabase
      .from('user_routines')
      .update({ is_active: false })
      .eq('user_id', user_id)
      .eq('tenant_id', tenantId);

    // Verificar si ya existe la asignación (.maybeSingle no falla si no hay filas)
    const { data: existing } = await supabase
      .from('user_routines')
      .select('id')
      .eq('user_id', user_id)
      .eq('routine_id', routine_id)
      .maybeSingle();

    let assignment;
    if (existing) {
      const { data } = await supabase
        .from('user_routines')
        .update({ is_active: true, notes, assigned_at: new Date().toISOString(), assigned_by: req.user.id })
        .eq('id', existing.id)
        .select()
        .single();
      assignment = data;
    } else {
      const { data } = await supabase
        .from('user_routines')
        .insert({ tenant_id: tenantId, user_id, routine_id, notes, assigned_by: req.user.id })
        .select()
        .single();
      assignment = data;
    }

    res.json({ message: 'Rutina asignada exitosamente', assignment });
  } catch (err) {
    logger.error('Admin assignRoutine error:', err);
    res.status(500).json({ error: 'Error asignando rutina' });
  }
}


module.exports = { getRoutines, getRoutineById, createRoutine, updateRoutine, deleteRoutine, assignRoutine };
