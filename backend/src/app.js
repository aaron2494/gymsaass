require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');
const inviteStore = require('./services/inviteStore');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const ownerRoutes = require('./routes/owner');
const adminRoutes = require('./routes/admin');
const { clientRouter, webhookRouter } = require('./routes/clientAndWebhooks');
const retentionRoutes = require('./routes/retention');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { startScheduler } = require('./services/scheduler');

const app = express();

// ============================================================
// SEGURIDAD
// ============================================================
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"], // necesario para la página /set-password
      styleSrc:   ["'self'", "'unsafe-inline'"],
    },
  },
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'myapp://',
    'http://localhost:8081',
    'http://localhost:19006',
  ],
  credentials: true,
}));

// Rate limiting global
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Rate limiting estricto para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login. Intenta en 15 minutos.' },
});

// Rate limiting por tenant para endpoints de cliente y admin
// Cada tenant tiene su propia ventana — un gym con 300 clientes no bloquea a otros
const tenantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  keyGenerator: (req) => {
    // Usa tenantId si está disponible (post-auth), sino cae a IP
    const tenantId = req.tenantId || req.headers['x-tenant-id'];
    return tenantId ? `tenant:${tenantId}` : `ip:${req.ip}`;
  },
  message: { error: 'Demasiadas solicitudes para este gimnasio. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
});

// ============================================================
// BODY PARSING
// ============================================================
// Para webhooks, necesitamos el body crudo ANTES del JSON parser
app.use('/webhooks', (req, res, next) => {
  express.raw({ type: 'application/json' })(req, res, (err) => {
    if (err) return next(err);
    if (req.body instanceof Buffer) {
      try {
        req.rawBody = req.body;
        req.body = JSON.parse(req.body.toString());
      } catch (e) {
        req.body = {};
      }
    }
    next();
  });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// LOGGING
// ============================================================
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// ============================================================
// ROUTES
// ============================================================
app.use('/public', publicRoutes);
app.use('/auth', authLimiter, authRoutes);
app.use('/owner', ownerRoutes);
app.use('/admin', tenantLimiter, adminRoutes);
app.use('/client', tenantLimiter, clientRouter);
app.use('/webhooks', webhookRouter);
app.use('/', retentionRoutes);

// Callback de pago (redirige a la app)
app.get('/payments/callback', (req, res) => {
  const { status } = req.query;
  const deepLink = `${process.env.FRONTEND_URL || 'myapp'}://payment-result?status=${status}`;
  res.redirect(deepLink);
});

// ============================================================
// ERROR HANDLING
// ============================================================
app.use(notFound);
app.use(errorHandler);

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 GymSaaS Backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  startScheduler();
});

module.exports = app;

// ============================================================
// FLUJO DE BIENVENIDA — sin deep links, todo en el browser
// GET  /invite/:id  →  formulario HTML de contraseña
// POST /invite/:id  →  setea contraseña y muestra éxito
// ============================================================

const supabaseAdmin = require('./config/supabase');

function inviteHtml({ title, emoji, body, showForm, inviteId, error }) {
  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — GymSaaS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#6C63FF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:20px;padding:36px 28px;max-width:400px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2)}
.emoji{font-size:52px;margin-bottom:16px}
h1{font-size:22px;font-weight:900;color:#2D3436;margin-bottom:10px}
p{font-size:14px;color:#636E72;line-height:1.6;margin-bottom:20px}
label{display:block;text-align:left;font-size:13px;font-weight:700;color:#2D3436;margin-bottom:6px}
input[type=password]{width:100%;padding:14px;border:2px solid #DFE6E9;border-radius:12px;font-size:15px;margin-bottom:14px;outline:none}
input[type=password]:focus{border-color:#6C63FF}
button{width:100%;background:#6C63FF;color:#fff;font-size:16px;font-weight:800;padding:16px;border-radius:12px;border:none;cursor:pointer;margin-top:4px}
button:active{opacity:.85}
button:disabled{background:#B2BEC3;cursor:not-allowed}
.error{background:#FFF0F0;border:1.5px solid #FF4757;color:#FF4757;border-radius:10px;padding:12px;font-size:13px;margin-bottom:16px;text-align:left}
.success-note{background:#E8FFF3;border:1.5px solid #2ED573;color:#00B894;border-radius:10px;padding:12px;font-size:13px;margin-top:16px}
</style></head>
<body><div class="card">
  <div class="emoji">${emoji}</div>
  <h1>${title}</h1>
  ${body}
  ${error ? `<div class="error">⚠️ ${error}</div>` : ''}
  ${showForm ? `
  <form method="POST" action="/invite/${inviteId}" id="f">
    <label>Nueva contraseña</label>
    <input type="password" name="password" placeholder="Mínimo 6 caracteres" required minlength="6" autofocus>
    <label>Repetir contraseña</label>
    <input type="password" name="confirm" placeholder="Repetí la misma" required minlength="6">
    <button type="submit" id="btn">Guardar contraseña</button>
  </form>
  <script>
    document.getElementById('f').onsubmit = function() {
      var p = this.password.value, c = this.confirm.value;
      if (p !== c) { alert('Las contraseñas no coinciden'); return false; }
      document.getElementById('btn').disabled = true;
      document.getElementById('btn').textContent = 'Guardando…';
    };
  </script>` : ''}
</div></body></html>`;
}

app.get('/invite/:id', (req, res) => {
  const record = inviteStore.getInvite(req.params.id);
  if (!record) {
    return res.status(410).send(inviteHtml({
      emoji: '⚠️', title: 'Link expirado o ya usado',
      body: '<p>Este link expiró o ya fue utilizado.<br>Pedile al gimnasio que te reenvíe la invitación.</p>',
      showForm: false,
    }));
  }
  res.send(inviteHtml({
    emoji: '💪', title: '¡Bienvenido!',
    body: '<p>Elegí tu contraseña para acceder a la app de tu gimnasio.</p>',
    showForm: true,
    inviteId: req.params.id,
  }));
});

app.post('/invite/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const record = inviteStore.getInvite(req.params.id);
  if (!record) {
    return res.status(410).send(inviteHtml({
      emoji: '⚠️', title: 'Link expirado o ya usado',
      body: '<p>Este link expiró o ya fue utilizado.<br>Pedile al gimnasio que te reenvíe la invitación.</p>',
      showForm: false,
    }));
  }

  const { password, confirm } = req.body;
  if (!password || password.length < 6) {
    return res.send(inviteHtml({
      emoji: '💪', title: '¡Bienvenido!',
      body: '<p>Elegí tu contraseña para acceder a la app de tu gimnasio.</p>',
      showForm: true, inviteId: req.params.id,
      error: 'La contraseña debe tener al menos 6 caracteres.',
    }));
  }
  if (password !== confirm) {
    return res.send(inviteHtml({
      emoji: '💪', title: '¡Bienvenido!',
      body: '<p>Elegí tu contraseña para acceder a la app de tu gimnasio.</p>',
      showForm: true, inviteId: req.params.id,
      error: 'Las contraseñas no coinciden.',
    }));
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(record.auth_id, { password });
    if (error) throw error;

    inviteStore.markUsed(req.params.id);
    logger.info('Password set via invite for: ' + record.email);

    res.send(inviteHtml({
      emoji: '🎉', title: '¡Listo!',
      body: `<p>Tu contraseña fue configurada.<br><br>Ya podés abrir la app e iniciar sesión con:<br><br><strong>${record.email}</strong></p>
      <div class="success-note">✅ Abrí la app y tocá "Iniciar sesión"</div>`,
      showForm: false,
    }));
  } catch (err) {
    logger.error('Error setting password via invite: ' + err.message);
    res.send(inviteHtml({
      emoji: '💪', title: '¡Bienvenido!',
      body: '<p>Elegí tu contraseña para acceder a la app de tu gimnasio.</p>',
      showForm: true, inviteId: req.params.id,
      error: 'Error guardando la contraseña. Intentá de nuevo.',
    }));
  }
});
