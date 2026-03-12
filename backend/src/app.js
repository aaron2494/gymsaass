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

// POST /invite — guarda un link y devuelve una URL segura para WhatsApp
app.post('/invite', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url requerida' });
  const id = inviteStore.createInvite(url);
  logger.info('Invite created: ' + id);
  res.json({ invite_url: (process.env.BACKEND_URL || 'http://localhost:3000') + '/invite/' + id });
});

// GET /invite/:id — cuando el USUARIO (no el bot de WA) toca el link, redirige al link real
// WhatsApp pre-fetcha URLs pero este endpoint devuelve HTML, no redirige.
// Solo redirige cuando el usuario toca "Abrir" en la página.
app.get('/invite/:id', (req, res) => {
  const record = inviteStore.getInvite(req.params.id);
  const APP_SCHEME = (process.env.FRONTEND_URL || 'myapp://').replace(/\/$/, '');

  if (!record || record.expires_at < Date.now()) {
    return res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expirado</title>
<style>body{font-family:system-ui,sans-serif;background:#6C63FF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:20px;padding:36px 28px;max-width:380px;width:100%;text-align:center}</style></head>
<body><div class="card">
<div style="font-size:48px;margin-bottom:16px">⚠️</div>
<h1 style="font-size:20px;font-weight:900;color:#2D3436;margin-bottom:8px">Link expirado</h1>
<p style="font-size:14px;color:#636E72;line-height:1.6">Este link ya fue usado o expiró.<br>Pedile al gimnasio que te reenvíe la invitación.</p>
</div></body></html>`);
  }

  const { url } = record;
  // NO eliminamos el registro acá — lo hace Supabase al validar el token.
  // Si WhatsApp fetchea esta página, ve HTML y no sigue el redirect.

  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crear contraseña — GymSaaS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#6C63FF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:20px;padding:36px 28px;max-width:380px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.18)}
.emoji{font-size:52px;margin-bottom:16px}
h1{font-size:22px;font-weight:900;color:#2D3436;margin-bottom:8px}
p{font-size:14px;color:#636E72;line-height:1.6;margin-bottom:24px}
.btn{display:block;background:#6C63FF;color:#fff;font-size:16px;font-weight:800;padding:16px 24px;border-radius:12px;text-decoration:none;margin-bottom:12px;border:none;cursor:pointer;width:100%}
#status{font-size:13px;color:#B2BEC3;margin-top:16px}
</style></head>
<body><div class="card">
  <div class="emoji">💪</div>
  <h1>¡Bienvenido!</h1>
  <p>Tocá el botón para abrir la app y elegir tu contraseña.</p>
  <button class="btn" onclick="openApp()">Abrir en la app</button>
  <p id="status"></p>
</div>
<script>
// Esta página NO redirige automáticamente para que WhatsApp no consuma el link.
// Solo abre la app cuando el USUARIO toca el botón.
var supabaseUrl = ${JSON.stringify(url)};
var appScheme   = ${JSON.stringify(APP_SCHEME)};

function openApp() {
  // Extraer access_token de la URL de Supabase y pasárselo a la app
  var match = supabaseUrl.match(/[?&]token=([^&]+)/);
  if (match) {
    // Formato directo con token — construir deep link para la app
    // La app lo recibe en Linking.getInitialURL() y llama al backend /auth/set-password
    var deepLink = appScheme + '/set-password?supabase_url=' + encodeURIComponent(supabaseUrl);
    document.getElementById('status').textContent = 'Abriendo app…';
    window.location.href = deepLink;
  } else {
    // La URL de Supabase es la de verify — abrirla directamente abre el browser, no la app.
    // Redirigir a Supabase que luego redirige a la app via redirectTo configurado.
    document.getElementById('status').textContent = 'Abriendo…';
    window.location.href = supabaseUrl;
  }
  setTimeout(function() {
    document.getElementById('status').textContent = '¿No se abrió? Asegurate de tener la app instalada.';
  }, 2500);
}
</script>
</body></html>`);
});
