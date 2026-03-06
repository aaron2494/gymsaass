const express = require('express');

// ---- Client Router ----
const clientRouter = express.Router();
const clientController = require('../controllers/clientController');
const progressController = require('../controllers/progressController');
const { authenticate, requireRole } = require('../middleware/auth');

clientRouter.use(authenticate, requireRole('client'));

clientRouter.get('/profile', clientController.getProfile);
clientRouter.get('/routine', clientController.getMyRoutine);
clientRouter.get('/subscription', clientController.getMySubscription);
clientRouter.get('/payments', clientController.getMyPayments);

// Workout logs
clientRouter.post('/workout-log', progressController.logWorkout);
clientRouter.get('/workout-logs', progressController.getWorkoutLogs);

// PRs
clientRouter.get('/prs', progressController.getPersonalRecords);

// Progreso corporal
clientRouter.post('/body-progress', progressController.logBodyProgress);
clientRouter.get('/body-progress', progressController.getBodyProgress);

// Logros
clientRouter.get('/achievements', progressController.getAchievements);

// ---- Webhook Router ----
const webhookRouter = express.Router();
const { handleWebhook } = require('../controllers/webhookController');

// IMPORTANTE: El webhook de MercadoPago necesita el body crudo para verificar firma
webhookRouter.post('/mercadopago', express.json(), handleWebhook);

module.exports = { clientRouter, webhookRouter };
