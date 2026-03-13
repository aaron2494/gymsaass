const supabase = require('../config/supabase');
const logger = require('../config/logger');
const mpService = require('../services/mercadopago');
const emailService = require('../services/emailService');
const inviteStore = require('../services/inviteStore');


// ============================================================
// DASHBOARD DEL ADMIN
// ============================================================
async function getDashboard(req, res) {
  // Deshabilitar caché — el dashboard cambia constantemente
  res.set('Cache-Control', 'no-store');
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

// ============================================================
// CLIENTES
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

    // Crear invite de bienvenida.
    // NO usamos generateLink de Supabase porque WhatsApp pre-fetchea URLs
    // y quema el OTP token antes de que el usuario lo abra.
    // En cambio: guardamos email+auth_id en memoria, mandamos /invite/:id
    // que es una página web con formulario → el usuario pone su contraseña
    // directamente en el browser, sin deep links ni app.
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const inviteId   = inviteStore.createInvite(email, authData.user.id);
    const inviteUrl  = backendUrl + '/invite/' + inviteId;
    let whatsappUrl  = null;

    // Enviar email de bienvenida (fire-and-forget — Resend puede fallar en dev)
    emailService.sendClientWelcome({
      clientEmail:    email,
      clientName:     full_name,
      gymName:        tenant?.name || 'Tu gimnasio',
      setPasswordUrl: inviteUrl,
    }).catch(err => logger.error('Error enviando email bienvenida cliente: ' + err.message));

    // URL de WhatsApp — /invite/:id devuelve HTML, WhatsApp no puede consumirlo
    if (phone) {
      const gymName   = tenant?.name || 'el gimnasio';
      const firstName = full_name.split(' ')[0];
      const msg = `Hola ${firstName}! 👋 Te damos la bienvenida a ${gymName}.\n\nYa tenés tu cuenta lista. Tocá el link para elegir tu contraseña y empezar a usar la app 💪\n\n${inviteUrl}`;
      whatsappUrl = `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`;
    }

    logger.info(`Client created: ${newUser.id} in tenant ${tenantId}`);
    res.status(201).json({
      message: 'Cliente creado exitosamente',
      client: newUser,
      welcome_email_sent: true,
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


module.exports = {
  getDashboard,
  getClients,
  createClient,
  updateClient,
};
