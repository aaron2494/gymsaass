const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');

// ============================================================
// DASHBOARD DEL ADMIN
// ============================================================
async function getDashboard(req, res) {
  try {
    const tenantId = req.tenantId;

    const today = new Date();
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      { count: totalClients },
      { count: activeClients },
      { data: expiringSubscriptions },
      { data: recentClients },
    ] = await Promise.all([
      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('role', 'client'),
      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('role', 'client')
        .eq('status', 'active'),
      supabase.from('subscriptions')
        .select('*, users(full_name, email, phone)')
        .eq('tenant_id', tenantId)
        .eq('type', 'gym_client')
        .eq('status', 'active')
        .lte('end_date', in7Days.toISOString().split('T')[0])
        .order('end_date', { ascending: true }),
      supabase.from('users')
        .select('id, full_name, email, created_at')
        .eq('tenant_id', tenantId)
        .eq('role', 'client')
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    // Ingresos del mes actual (pagos gym_client)
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const { data: monthPayments } = await supabase
      .from('payments')
      .select('amount')
      .eq('tenant_id', tenantId)
      .eq('type', 'gym_client')
      .eq('status', 'approved')
      .gte('payment_date', firstDayOfMonth.toISOString());

    const monthlyRevenue = monthPayments?.reduce((sum, p) => sum + parseFloat(p.amount), 0) || 0;

    res.json({
      metrics: {
        total_clients: totalClients || 0,
        active_clients: activeClients || 0,
        monthly_revenue: monthlyRevenue,
        expiring_count: expiringSubscriptions?.length || 0,
      },
      expiring_subscriptions: expiringSubscriptions || [],
      recent_clients: recentClients || [],
    });
  } catch (err) {
    logger.error('Admin getDashboard error:', err);
    res.status(500).json({ error: 'Error obteniendo dashboard' });
  }
}

// ============================================================
// LISTAR CLIENTES
// ============================================================
async function getClients(req, res) {
  try {
    const tenantId = req.tenantId;
    const { page = 1, limit = 20, status, search } = req.query;
    const from = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select(`
        id, full_name, email, phone, status, created_at,
        subscriptions!subscriptions_user_id_fkey(status, end_date, amount),
        user_routines!user_routines_user_id_fkey(
          is_active,
          routines(name)
        )
      `, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('full_name', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ clients: data, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('Admin getClients error:', err);
    res.status(500).json({ error: 'Error obteniendo clientes' });
  }
}

// ============================================================
// CREAR CLIENTE
// ============================================================
async function createClient(req, res) {
  try {
    const tenantId = req.tenantId;
    const { email, full_name, phone, password } = req.body;

    // Verificar que el email no exista en este tenant
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email en este gimnasio' });
    }

    // Crear en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { tenant_id: tenantId, role: 'client' },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ error: 'Email ya registrado en el sistema' });
      }
      throw authError;
    }

    // Crear perfil
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        tenant_id: tenantId,
        auth_id: authData.user.id,
        email,
        full_name,
        phone,
        role: 'client',
      })
      .select()
      .single();

    if (userError) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      throw userError;
    }

    logger.info(`Client created: ${newUser.id} in tenant ${tenantId}`);
    res.status(201).json({ message: 'Cliente creado exitosamente', client: newUser });
  } catch (err) {
    logger.error('Admin createClient error:', err);
    res.status(500).json({ error: 'Error creando cliente: ' + err.message });
  }
}

// ============================================================
// ACTUALIZAR CLIENTE
// ============================================================
async function updateClient(req, res) {
  try {
    const { clientId } = req.params;
    const tenantId = req.tenantId;
    const { full_name, phone, status } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({ full_name, phone, status })
      .eq('id', clientId)
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Cliente no encontrado' });

    res.json({ message: 'Cliente actualizado', client: data });
  } catch (err) {
    logger.error('Admin updateClient error:', err);
    res.status(500).json({ error: 'Error actualizando cliente' });
  }
}

// ============================================================
// RUTINAS
// ============================================================
async function getRoutines(req, res) {
  try {
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('routines')
      .select('*, exercises(count)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ routines: data });
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
        routine_id: routine.id,
        ...ex,
        order_index: ex.order_index ?? idx,
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
    const { user_id, routine_id, notes } = req.body;

    // Desactivar rutinas anteriores del usuario
    await supabase
      .from('user_routines')
      .update({ is_active: false })
      .eq('user_id', user_id)
      .eq('tenant_id', tenantId);

    // Verificar si ya existe la asignación
    const { data: existing } = await supabase
      .from('user_routines')
      .select('id')
      .eq('user_id', user_id)
      .eq('routine_id', routine_id)
      .single();

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

// ============================================================
// GENERAR LINK DE PAGO PARA CLIENTE
// ============================================================
async function generateClientPaymentLink(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, description } = req.body;

    // Verificar que el cliente pertenece a este tenant
    const { data: client } = await supabase
      .from('users')
      .select('*')
      .eq('id', user_id)
      .eq('tenant_id', tenantId)
      .eq('role', 'client')
      .single();

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const externalRef = `gym-${tenantId}-${user_id}-${Date.now()}`;

    // Registrar pago pendiente
    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        user_id,
        type: 'gym_client',
        amount,
        currency: 'ARS',
        status: 'pending',
        mp_external_reference: externalRef,
      })
      .select()
      .single();

    const preference = await mpService.createPaymentPreference({
      tenantId,
      userId: user_id,
      amount,
      currency: 'ARS',
      description: description || 'Suscripción mensual gimnasio',
      externalReference: externalRef,
    });

    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    res.json({
      payment_url: preference.init_point,
      sandbox_url: preference.sandbox_init_point,
      external_reference: externalRef,
    });
  } catch (err) {
    logger.error('Admin generateClientPaymentLink error:', err);
    res.status(500).json({ error: 'Error generando link de pago' });
  }
}

// ============================================================
// HISTORIAL DE PAGOS DE UN CLIENTE
// ============================================================
async function getClientPayments(req, res) {
  try {
    const { clientId } = req.params;
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', clientId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ payments: data });
  } catch (err) {
    logger.error('Admin getClientPayments error:', err);
    res.status(500).json({ error: 'Error obteniendo pagos' });
  }
}

// ============================================================
// CREAR/RENOVAR SUSCRIPCIÓN MANUAL (sin pago MP)
// ============================================================
async function createClientSubscription(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, months = 1 } = req.body;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    // Desactivar suscripción anterior
    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('user_id', user_id)
      .eq('type', 'gym_client')
      .eq('status', 'active');

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .insert({
        tenant_id: tenantId,
        user_id,
        type: 'gym_client',
        amount,
        currency: 'ARS',
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status: 'active',
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Suscripción creada', subscription });
  } catch (err) {
    logger.error('Admin createClientSubscription error:', err);
    res.status(500).json({ error: 'Error creando suscripción' });
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
