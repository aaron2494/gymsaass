const supabase = require('../config/supabase');
const logger = require('../config/logger');

/**
 * Verifica el JWT de Supabase y adjunta el usuario al request.
 * También consulta el perfil completo desde la tabla users.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const token = authHeader.split(' ')[1];

    // Verificar token con Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    // Obtener perfil del usuario
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*, tenants(*)')
      .eq('auth_id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Perfil de usuario no encontrado' });
    }

    if (profile.status === 'inactive') {
      return res.status(403).json({ error: 'Cuenta inactiva' });
    }

    // Verificar que el gimnasio no esté bloqueado (para admin y client)
    if (profile.role !== 'owner' && profile.tenants?.status === 'blocked') {
      return res.status(403).json({
        error: 'Acceso suspendido. Contacta al administrador del gimnasio.',
        code: 'TENANT_BLOCKED',
      });
    }

    req.user = profile;
    req.tenantId = profile.tenant_id;
    next();
  } catch (err) {
    logger.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Error de autenticación' });
  }
}

/**
 * Middleware para requerir rol específico
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Acceso denegado. Se requiere rol: ${roles.join(' o ')}`,
      });
    }
    next();
  };
}

/**
 * Middleware para validar que el admin solo accede a su tenant
 */
function requireSameTenant(req, res, next) {
  const targetTenantId = req.params.tenantId || req.body.tenantId || req.query.tenantId;

  if (req.user.role === 'owner') return next(); // Owner puede todo

  if (targetTenantId && targetTenantId !== req.tenantId) {
    return res.status(403).json({ error: 'Acceso denegado a este gimnasio' });
  }
  next();
}

module.exports = { authenticate, requireRole, requireSameTenant };
