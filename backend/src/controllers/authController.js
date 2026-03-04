const supabase = require('../config/supabase');
const logger = require('../config/logger');

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Obtener perfil con tenant info
    const { data: profile } = await supabase
      .from('users')
      .select('*, tenants(id, name, status, logo_url)')
      .eq('auth_id', data.user.id)
      .single();

    if (!profile) {
      return res.status(404).json({ error: 'Perfil de usuario no encontrado' });
    }

    if (profile.status === 'inactive') {
      return res.status(403).json({ error: 'Cuenta inactiva' });
    }

    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        tenant_id: profile.tenant_id,
        tenant: profile.tenants,
      },
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}

async function refreshToken(req, res) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token requerido' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: 'Token inválido o expirado' });

    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  } catch (err) {
    logger.error('Refresh token error:', err);
    res.status(500).json({ error: 'Error refrescando token' });
  }
}

async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body;
    const { email } = req.user;

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Verificar contraseña actual
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: current_password,
    });

    if (signInError) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    // Actualizar contraseña
    const { error } = await supabase.auth.admin.updateUserById(req.user.auth_id, {
      password: new_password,
    });

    if (error) throw error;

    res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    logger.error('Change password error:', err);
    res.status(500).json({ error: 'Error cambiando contraseña' });
  }
}

module.exports = { login, refreshToken, changePassword };
