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

app.use(helmet());

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
  windowMs: 15 * 60 * 1000, // 15 minutos
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
app.use('/admin', adminRoutes);
app.use('/client', clientRouter);
app.use('/webhooks', webhookRouter);
app.use('/', retentionRoutes); // avisos, check-ins, health score, notas

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
