const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

// Todas las rutas requieren ser admin
router.use(authenticate, requireRole('admin', 'owner'));

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// Clientes
router.get('/clients', adminController.getClients);
router.post('/clients', validate(schemas.createUser), adminController.createClient);
router.patch('/clients/:clientId', adminController.updateClient);
router.get('/clients/:clientId/payments', adminController.getClientPayments);

// Suscripciones
router.post('/clients/subscription', validate(schemas.createSubscription), adminController.createClientSubscription);
router.post('/clients/payment-link', adminController.generateClientPaymentLink);

// Rutinas
router.get('/routines', adminController.getRoutines);
router.get('/routines/:routineId', adminController.getRoutineById);
router.post('/routines', validate(schemas.createRoutine), adminController.createRoutine);
router.put('/routines/:routineId', adminController.updateRoutine);
router.delete('/routines/:routineId', adminController.deleteRoutine);

// Asignar rutina
router.post('/routines/assign', validate(schemas.assignRoutine), adminController.assignRoutine);

// Configuración del gimnasio
router.get('/settings', settingsController.getSettings);
router.put('/settings', settingsController.updateSettings);
router.post('/settings/mercadopago', settingsController.saveMercadoPagoCredentials);
router.delete('/settings/mercadopago', settingsController.removeMercadoPagoCredentials);

// Alertas y stats
router.get('/clients/alerts', adminController.getClientAlerts);
router.get('/stats/monthly', adminController.getMonthlyStats);

module.exports = router;
