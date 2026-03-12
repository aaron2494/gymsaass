require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');

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
// GET /set-password — Página intermedia del deep link de bienvenida
// Supabase redirige aquí después de validar el OTP (redirectTo apunta a esta URL).
// Esta página extrae el access_token del hash y abre la app nativa.
// Funciona desde cualquier browser incluyendo el de WhatsApp.
// ============================================================
app.get('/set-password', (req, res) => {
  const APP_SCHEME = process.env.FRONTEND_URL || 'myapp://';
  const scheme = APP_SCHEME.replace(/\/$/, '');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crear contraseña — GymSaaS</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #6C63FF; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #fff; border-radius: 20px; padding: 36px 28px;
      max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    }
    .emoji { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 900; color: #2D3436; margin-bottom: 8px; }
    p  { font-size: 14px; color: #636E72; line-height: 1.6; margin-bottom: 24px; }
    .btn {
      display: block; background: #6C63FF; color: #fff;
      font-size: 16px; font-weight: 800; padding: 16px 24px;
      border-radius: 12px; text-decoration: none; margin-bottom: 12px;
      border: none; cursor: pointer; width: 100%;
    }
    .btn:active { opacity: 0.85; }
    .btn.secondary {
      background: transparent; color: #6C63FF;
      border: 2px solid #6C63FF; margin-bottom: 0;
    }
    .error { color: #FF4757; }
    #status { font-size: 13px; color: #B2BEC3; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji" id="emoji">💪</div>
    <h1 id="title">Abriendo la app…</h1>
    <p id="msg">Si no se abre automáticamente, tocá el botón.</p>
    <button class="btn" id="btnOpen" style="display:none" onclick="openApp()">
      Abrir en la app
    </button>
    <p id="status"></p>
  </div>

  <script>
    // Extraer params del hash (#access_token=...&type=recovery) o query string
    function getParams() {
      var hash  = (location.hash  || '').replace(/^#/, '');
      var query = (location.search || '').replace(/^\\?/, '');
      var str   = hash || query;
      var p = {};
      str.split('&').forEach(function(pair) {
        var parts = pair.split('=');
        if (parts[0]) p[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
      });
      return p;
    }

    var params = getParams();
    var token  = params['access_token'];
    var error  = params['error'];

    function setError(msg) {
      document.getElementById('emoji').textContent = '⚠️';
      document.getElementById('title').textContent = 'Link inválido o expirado';
      document.getElementById('msg').innerHTML = msg;
      document.getElementById('status').textContent = '';
    }

    function openApp() {
      // Construir deep link con el token
      var deepLink = '${scheme}/set-password#access_token=' + encodeURIComponent(token)
        + '&type=recovery';
      document.getElementById('status').textContent = 'Abriendo app…';
      window.location.href = deepLink;

      // Si después de 2.5s el browser sigue acá, la app no se abrió
      setTimeout(function() {
        document.getElementById('status').textContent =
          '¿No se abrió? Asegurate de tener la app instalada y el celular desbloqueado.';
      }, 2500);
    }

    if (error) {
      setError('El link expiró o ya fue usado.<br>Pedile al gimnasio que te reenvíe la invitación.');
    } else if (!token) {
      setError('No se encontró el token de acceso.<br>Pedile al gimnasio que te reenvíe la invitación.');
    } else {
      // Intentar abrir la app automáticamente
      document.getElementById('btnOpen').style.display = 'block';
      setTimeout(openApp, 600);
    }
  </script>
</body>
</html>`);
});
