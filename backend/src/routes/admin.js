const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

// Todas las rutas requieren ser admin
const aiRoutineController = require('../controllers/aiRoutineController');

router.use(authenticate, requireRole('admin', 'owner'));

router.post('/ai-routine', aiRoutineController.generateRoutine);

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

// Rutinas — assign ANTES de /:routineId para evitar conflicto de rutas
router.get('/routines', adminController.getRoutines);
router.post('/routines', validate(schemas.createRoutine), adminController.createRoutine);
router.post('/routines/assign', adminController.assignRoutine);
router.get('/routines/:routineId', adminController.getRoutineById);
router.put('/routines/:routineId', adminController.updateRoutine);
router.delete('/routines/:routineId', adminController.deleteRoutine);

// Configuración del gimnasio
router.get('/settings', settingsController.getSettings);
router.put('/settings', settingsController.updateSettings);
router.post('/settings/mercadopago', settingsController.saveMercadoPagoCredentials);
router.delete('/settings/mercadopago', settingsController.removeMercadoPagoCredentials);

// Alertas y stats
router.get('/clients/alerts', adminController.getClientAlerts);
router.get('/clients/ranking', adminController.getClientRanking);
router.get('/stats/monthly', adminController.getMonthlyStats);
router.patch('/clients/:id/deactivate', adminController.deactivateClient);
router.delete('/clients/:id', adminController.deleteClient);
router.get('/clients/:id/notes', adminController.getClientNotes);
router.post('/clients/:id/notes', adminController.addClientNote);
router.delete('/clients/:id/notes/:noteId', adminController.deleteClientNote);
router.get('/clients/:id/progress', adminController.getClientProgress);
router.post('/clients/:id/sync-payment', adminController.syncClientPayment);
router.post('/clients/payment-link-whatsapp', adminController.paymentLinkAndWhatsApp);

module.exports = router;
