const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');
const emailService = require('../services/emailService');

// ============================================================
// DASHBOARD DEL ADMIN
// ============================================================
async function getDashboard(req, res) {
  try {
    const tenantId = req.tenantId;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [
      checkInsToday,
      checkInsYesterday,
      urgentExpiring,
      todayPayments,
      { count: activeClients },
      { count: totalClients },
    ] = await Promise.all([
      // Check-ins de hoy
      supabase.from('check_ins')
        .select('id, checked_in_at, users!check_ins_user_id_fkey(id, full_name)')
        .eq('tenant_id', tenantId)
        .gte('checked_in_at', todayStart)
        .order('checked_in_at', { ascending: false }),

      // Check-ins de ayer (para comparar)
      supabase.from('check_ins')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('checked_in_at', yesterdayStart)
        .lt('checked_in_at', todayStart),

      // Vencen en 3 días o menos — URGENTE
      supabase.from('subscriptions')
        .select('id, end_date, amount, users!subscriptions_user_id_fkey(id, full_name, phone)')
        .eq('tenant_id', tenantId)
        .eq('type', 'gym_client')
        .eq('status', 'active')
        .lte('end_date', in3Days)
        .gte('end_date', todayStr)
        .order('end_date', { ascending: true }),

      // Cobros aprobados hoy
      supabase.from('payments')
        .select('id, amount, users!payments_user_id_fkey(full_name)')
        .eq('tenant_id', tenantId)
        .eq('type', 'gym_client')
        .eq('status', 'approved')
        .gte('created_at', todayStart),

      // Clientes activos
      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('role', 'client')
        .eq('status', 'active'),

      // Total clientes
      supabase.from('users')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('role', 'client'),
    ]);

    const todayRevenue = (todayPayments.data || []).reduce((s, p) => s + parseFloat(p.amount), 0);
    const todayCI = checkInsToday.data?.length || 0;
    const yesterdayCI = checkInsYesterday.count || 0;

    res.json({
      today: {
        check_ins: checkInsToday.data || [],
        check_ins_count: todayCI,
        check_ins_vs_yesterday: todayCI - yesterdayCI,
        revenue: todayRevenue,
        payments: todayPayments.data || [],
      },
      urgent: {
        expiring: urgentExpiring.data || [],
        expiring_count: urgentExpiring.data?.length || 0,
      },
      summary: {
        active_clients: activeClients || 0,
        total_clients: totalClients || 0,
      },
    });
  } catch (err) {
    logger.error('Admin getDashboard error:', err);
    res.status(500).json({ error: 'Error obteniendo dashboard: ' + err.message });
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
    const { email, full_name, phone } = req.body;

    // Verificar que el email no exista en este tenant
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email en este gimnasio' });
    }

    // Obtener nombre del gimnasio para el email de bienvenida
    const { data: tenant } = await supabase
      .from('tenants')
      .select('name, phone')
      .eq('id', tenantId)
      .single();

    // Contraseña temporal aleatoria — el cliente la reemplaza con el link de bienvenida
    const tempPassword = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-4).toUpperCase();

    // Crear en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
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

    // Generar link para que el cliente elija su propia contraseña (expira en 24hs)
    let setPasswordUrl = null;
    let whatsappUrl    = null;
    try {
      const { data: linkData } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: {
          // Apunta a la página HTML intermedia del backend (HTTPS).
          // Esa página extrae el token y abre la app con el deep link nativo.
          // Esto funciona desde cualquier browser (incluyendo el in-app de WhatsApp).
          redirectTo: (process.env.BACKEND_URL || 'http://localhost:3000') + '/set-password',
        },
      });
      setPasswordUrl = linkData?.properties?.action_link || null;
    } catch (linkErr) {
      logger.warn('No se pudo generar link de bienvenida para ' + email + ': ' + linkErr.message);
    }

    // Enviar email de bienvenida (fire-and-forget — no falla el request si el email falla)
    if (setPasswordUrl) {
      emailService.sendClientWelcome({
        clientEmail:    email,
        clientName:     full_name,
        gymName:        tenant?.name || 'Tu gimnasio',
        setPasswordUrl,
      }).catch(err => logger.error('Error enviando email bienvenida cliente: ' + err.message));
    }

    // URL de WhatsApp para que el admin reenvíe manualmente si el cliente no tiene email
    if (phone && setPasswordUrl) {
      const gymName   = tenant?.name || 'el gimnasio';
      const firstName = full_name.split(' ')[0];
      const msg = `Hola ${firstName}! 👋 Te damos la bienvenida a ${gymName}.\n\nYa tenés tu cuenta lista. Tocá el link para elegir tu contraseña y empezar a usar la app:\n\n${setPasswordUrl}\n\n¡Nos vemos en el gym! 💪`;
      whatsappUrl = `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`;
    }

    logger.info(`Client created: ${newUser.id} in tenant ${tenantId}`);
    res.status(201).json({
      message: 'Cliente creado exitosamente',
      client: newUser,
      welcome_email_sent: !!setPasswordUrl,
      whatsapp_url: whatsappUrl,
    });
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
        ...(() => {
          const url = process.env.BACKEND_URL?.trim();
          return url && url.startsWith('https://')
            ? { notification_url: `${url}/webhooks/mercadopago` }
            : {};
        })(),
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


// GET /admin/clients/:id/progress — Progreso de un cliente en su rutina
// ============================================================
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

module.exports = {
  getDashboard, getClients, createClient, updateClient,
  createClientSubscription, generateClientPaymentLink, getClientPayments,
  getRoutines, getRoutineById, createRoutine, updateRoutine, deleteRoutine, assignRoutine,
  getClientAlerts, getMonthlyStats, deactivateClient, deleteClient,
  getClientNotes, addClientNote, deleteClientNote,
  getClientRanking, paymentLinkAndWhatsApp, syncClientPayment,
  getClientProgress,
};

// ============================================================
// GET /admin/clients/:id/notes — Notas del admin sobre un cliente
// ============================================================
async function getClientNotes(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('client_notes')
      .select('id, content, created_at, admin_id, users!client_notes_admin_id_fkey(full_name)')
      .eq('user_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (err) {
    logger.error('getClientNotes error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// POST /admin/clients/:id/notes — Agregar nota sobre cliente
// ============================================================
async function addClientNote(req, res) {
  try {
    const tenantId = req.tenantId;
    const adminId  = req.user.id;
    const { id }   = req.params;
    const { content } = req.body;

    if (!content?.trim()) return res.status(400).json({ error: 'Contenido requerido' });

    const { data, error } = await supabase
      .from('client_notes')
      .insert({ user_id: id, tenant_id: tenantId, admin_id: adminId, content: content.trim() })
      .select('id, content, created_at')
      .single();

    if (error) throw error;
    res.status(201).json({ note: data });
  } catch (err) {
    logger.error('addClientNote error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// DELETE /admin/clients/:id/notes/:noteId — Eliminar nota
// ============================================================
async function deleteClientNote(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id, noteId } = req.params;

    const { error } = await supabase
      .from('client_notes')
      .delete()
      .eq('id', noteId)
      .eq('user_id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('deleteClientNote error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// GET /admin/clients/ranking — Ranking de clientes más activos
// ============================================================
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
async function paymentLinkAndWhatsApp(req, res) {
  try {
    const tenantId = req.tenantId;
    const { user_id, amount, description } = req.body;

    // Reusar la lógica de generateClientPaymentLink pero devolver también datos para WhatsApp
    const [clientRes, tenantRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', user_id).eq('tenant_id', tenantId).eq('role', 'client').single(),
      supabase.from('tenants').select('name, mp_access_token, mp_configured, subscription_price').eq('id', tenantId).single(),
    ]);

    const client = clientRes.data;
    const tenant = tenantRes.data;

    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    if (!tenant?.mp_access_token || !tenant?.mp_configured) {
      return res.status(400).json({ error: 'Configurá MercadoPago primero', needs_mp_setup: true });
    }

    const finalAmount = parseFloat(amount) || parseFloat(tenant.subscription_price) || 5000;
    const externalRef = `gym-${tenantId}-${user_id}-${Date.now()}`;

    const { data: payment } = await supabase.from('payments')
      .insert({ tenant_id: tenantId, user_id, type: 'gym_client', amount: finalAmount, currency: 'ARS', status: 'pending', mp_external_reference: externalRef })
      .select().single();

    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const gymMpClient = new MercadoPagoConfig({ accessToken: tenant.mp_access_token });

    const backendUrl = process.env.BACKEND_URL?.trim();
    const notificationUrl = backendUrl && backendUrl.startsWith('https://')
      ? `${backendUrl}/webhooks/mercadopago`
      : null;

    const preference = await new Preference(gymMpClient).create({
      body: {
        items: [{ title: description || `Suscripción mensual — ${tenant.name}`, quantity: 1, unit_price: finalAmount, currency_id: 'ARS' }],
        payer: { name: client.full_name, email: client.email },
        external_reference: externalRef,
        payment_methods: { installments: 1 },
        ...(notificationUrl && { notification_url: notificationUrl }),
      },
    });

    await supabase.from('payments').update({ mp_preference_id: preference.id }).eq('id', payment.id);

    // Armar el mensaje WhatsApp listo para enviar
    const firstName = client.full_name?.split(' ')[0] || 'cliente';
    const whatsappMsg = `Hola ${firstName}! 👋 Te mando el link para renovar tu suscripción en ${tenant.name}:\n\n${preference.init_point}\n\n¡Gracias! 💪`;

    res.json({
      payment_url: preference.init_point,
      amount: finalAmount,
      whatsapp_phone: client.phone?.replace(/\D/g, ''),
      whatsapp_msg: whatsappMsg,
      whatsapp_url: client.phone
        ? `https://wa.me/${client.phone.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMsg)}`
        : null,
    });
  } catch (err) {
    logger.error('paymentLinkAndWhatsApp error:', err);
    res.status(500).json({ error: 'Error generando link: ' + err.message });
  }
}

// ============================================================
// POST /admin/clients/:id/sync-payment — Sincronizar pago manualmente
// Verifica el último pago pendiente contra MP y activa la suscripción
// ============================================================
async function syncClientPayment(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id: userId } = req.params;

    // Buscar el último pago pendiente o aprobado del cliente
    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('type', 'gym_client')
      .in('status', ['pending', 'in_process', 'approved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (pErr || !payment) {
      return res.status(404).json({ error: 'No hay pagos pendientes para este cliente' });
    }

    // Si ya está aprobado en nuestra DB, solo activar suscripción
    if (payment.status === 'approved') {
      await activateGymClientSubscription(payment);
      return res.json({ message: 'Suscripción activada', status: 'approved' });
    }

    // Si tiene mp_payment_id, consultar MP directamente
    if (payment.mp_payment_id) {
      const { MercadoPagoConfig, Payment } = require('mercadopago');
      const { data: tenantData } = await supabase
        .from('tenants')
        .select('mp_access_token')
        .eq('id', tenantId)
        .single();

      if (!tenantData?.mp_access_token) {
        return res.status(400).json({ error: 'MercadoPago no configurado' });
      }

      const mpClient  = new MercadoPagoConfig({ accessToken: tenantData.mp_access_token });
      const mpPayment = await new Payment(mpClient).get({ id: payment.mp_payment_id });

      if (mpPayment.status === 'approved') {
        await supabase.from('payments').update({
          status: 'approved',
          payment_date: mpPayment.date_approved ? new Date(mpPayment.date_approved).toISOString() : new Date().toISOString(),
        }).eq('id', payment.id);

        await activateGymClientSubscription({ ...payment, status: 'approved' });
        return res.json({ message: '✅ Pago verificado y suscripción activada', status: 'approved' });
      }

      return res.json({ message: `Pago en estado: ${mpPayment.status}`, status: mpPayment.status });
    }

    // Sin mp_payment_id — activar manualmente (el admin confirma el pago)
    const { manual } = req.body;
    if (manual) {
      await supabase.from('payments').update({
        status: 'approved',
        payment_date: new Date().toISOString(),
      }).eq('id', payment.id);

      await activateGymClientSubscription({ ...payment, status: 'approved' });
      return res.json({ message: '✅ Pago activado manualmente', status: 'approved' });
    }

    return res.json({ message: 'Pago pendiente sin confirmar', status: 'pending' });
  } catch (err) {
    logger.error('syncClientPayment error:', err);
    res.status(500).json({ error: 'Error sincronizando pago: ' + err.message });
  }
}

// Helper interno reutilizable
async function activateGymClientSubscription(payment) {
  const { tenant_id, user_id, amount } = payment;

  // Expirar suscripciones anteriores
  await supabase.from('subscriptions')
    .update({ status: 'expired' })
    .eq('user_id', user_id)
    .eq('type', 'gym_client')
    .eq('status', 'active');

  // Crear nueva suscripción activa por 30 días
  const startDate = new Date();
  const endDate   = new Date();
  endDate.setMonth(endDate.getMonth() + 1);

  const { error } = await supabase.from('subscriptions').insert({
    tenant_id,
    user_id,
    type: 'gym_client',
    amount,
    currency: 'ARS',
    status: 'active',
    start_date: startDate.toISOString().split('T')[0],
    end_date:   endDate.toISOString().split('T')[0],
  });

  if (error) throw error;
  logger.info(`Subscription activated for user ${user_id}`);
}

// ============================================================
