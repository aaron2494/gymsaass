const express = require('express');

// ---- Client Router ----
const clientRouter = express.Router();
const clientController = require('../controllers/clientController');
const { authenticate, requireRole } = require('../middleware/auth');

clientRouter.use(authenticate, requireRole('client'));

clientRouter.get('/profile', clientController.getProfile);
clientRouter.get('/routine', clientController.getMyRoutine);
clientRouter.get('/subscription', clientController.getMySubscription);
clientRouter.get('/payments', clientController.getMyPayments);

// ---- Webhook Router ----
const webhookRouter = express.Router();
const { handleWebhook } = require('../controllers/webhookController');

// IMPORTANTE: El webhook de MercadoPago necesita el body crudo para verificar firma
webhookRouter.post('/mercadopago', express.json(), handleWebhook);

module.exports = { clientRouter, webhookRouter };
