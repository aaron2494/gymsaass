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
// El pago va directo a la cuenta MP del gimnasio
// ============================================================
async function generateClientPaymentLink(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, description } = req.body;

    // Obtener cliente y datos del tenant (incluyendo credenciales MP)
    const [clientRes, tenantRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', user_id).eq('tenant_id', tenantId).eq('role', 'client').single(),
      supabase.from('tenants').select('name, mp_access_token, mp_configured, subscription_price').eq('id', tenantId).single(),
    ]);

    const client = clientRes.data;
    const tenant = tenantRes.data;

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Verificar que el gym tiene MP configurado
    if (!tenant?.mp_access_token || !tenant?.mp_configured) {
      return res.status(400).json({
        error: 'Tenés que configurar tu MercadoPago antes de generar links de pago.',
        needs_mp_setup: true,
      });
    }

    // Monto: usar el del request o el precio default del gym
    const finalAmount = parseFloat(amount) || parseFloat(tenant.subscription_price) || 5000;
    const externalRef = `gym-${tenantId}-${user_id}-${Date.now()}`;

    // Registrar pago pendiente
    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        user_id,
        type: 'gym_client',
        amount: finalAmount,
        currency: 'ARS',
        status: 'pending',
        mp_external_reference: externalRef,
      })
      .select()
      .single();

    // Crear preferencia con las credenciales del GIMNASIO (no del SaaS)
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const gymMpClient = new MercadoPagoConfig({ accessToken: tenant.mp_access_token });
    const gymPreference = new Preference(gymMpClient);

    const preference = await gymPreference.create({
      body: {
        items: [{
          title: description || `Suscripción mensual — ${tenant.name}`,
          quantity: 1,
          unit_price: finalAmount,
          currency_id: 'ARS',
        }],
        payer: {
          name: client.full_name,
          email: client.email,
        },
        external_reference: externalRef,
        payment_methods: { installments: 1 },
        ...(process.env.NODE_ENV !== 'development' && {
          notification_url: `${process.env.BACKEND_URL}/webhooks/mercadopago`,
        }),
      },
    });

    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    res.json({
      payment_url: preference.init_point,
      external_reference: externalRef,
      amount: finalAmount,
    });
  } catch (err) {
    logger.error('Admin generateClientPaymentLink error:', err);
    res.status(500).json({ error: 'Error generando link de pago: ' + err.message });
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
// PATCH /admin/clients/:id/desactivate — Dar de baja (mantiene datos)
// ============================================================
async function desactivateClient(req, res) {
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
// ============================================================
// PATCH /admin/clients/:id/desactivate — Dar de baja (mantiene datos)
// ============================================================
async function desactivateClient(req, res) {
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
module.exports = {
  getDashboard, getClients, createClient, updateClient,
  createClientSubscription, generateClientPaymentLink, getClientPayments,
  getRoutines, getRoutineById, createRoutine, updateRoutine, deleteRoutine, assignRoutine,
  getClientAlerts, getMonthlyStats,desactivateClient,deleteClient
};
