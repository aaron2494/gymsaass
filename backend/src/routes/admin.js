const express = require('express');
const router  = express.Router();

const adminController     = require('../controllers/adminController');
const routineController   = require('../controllers/adminRoutineController');
const paymentController   = require('../controllers/adminPaymentController');
const statsController     = require('../controllers/adminStatsController');
const notesController     = require('../controllers/adminNotesController');
const rankingController   = require('../controllers/adminRankingController');
const settingsController  = require('../controllers/settingsController');
const aiRoutineController = require('../controllers/aiRoutineController');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, schemas }         = require('../middleware/validate');

// Todas las rutas requieren estar autenticado como admin u owner
router.use(authenticate, requireRole('admin', 'owner'));

// ── AI ────────────────────────────────────────────────────────────────────────
router.post('/ai-routine', aiRoutineController.generateRoutine);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', adminController.getDashboard);

// ── Clientes — rutas fijas ANTES de /:clientId para evitar conflictos ─────────
router.get('/clients/alerts',                 statsController.getClientAlerts);
router.get('/clients/ranking',                rankingController.getClientRanking);
router.post('/clients/payment-link',          paymentController.generateClientPaymentLink);
router.post('/clients/payment-link-whatsapp', paymentController.paymentLinkAndWhatsApp);
router.post('/clients/subscription',          validate(schemas.createSubscription), paymentController.createClientSubscription);

router.get('/clients',             adminController.getClients);
router.post('/clients',            validate(schemas.createUser), adminController.createClient);
router.patch('/clients/:clientId', adminController.updateClient);

router.patch('/clients/:id/deactivate',     statsController.deactivateClient);
router.delete('/clients/:id',               statsController.deleteClient);
router.get('/clients/:clientId/payments',   paymentController.getClientPayments);
router.post('/clients/:id/sync-payment',    paymentController.syncClientPayment);
router.get('/clients/:id/progress',         statsController.getClientProgress);

// Notas de cliente
router.get('/clients/:id/notes',            notesController.getClientNotes);
router.post('/clients/:id/notes',           notesController.addClientNote);
router.delete('/clients/:id/notes/:noteId', notesController.deleteClientNote);

// ── Rutinas — /assign ANTES de /:routineId ────────────────────────────────────
router.post('/routines/assign',       routineController.assignRoutine);
router.get('/routines',               routineController.getRoutines);
router.post('/routines',              validate(schemas.createRoutine), routineController.createRoutine);
router.get('/routines/:routineId',    routineController.getRoutineById);
router.put('/routines/:routineId',    routineController.updateRoutine);
router.delete('/routines/:routineId', routineController.deleteRoutine);

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats/monthly', statsController.getMonthlyStats);

// ── Configuración ─────────────────────────────────────────────────────────────
router.get('/settings',                settingsController.getSettings);
router.put('/settings',                settingsController.updateSettings);
router.post('/settings/mercadopago',   settingsController.saveMercadoPagoCredentials);
router.delete('/settings/mercadopago', settingsController.removeMercadoPagoCredentials);

module.exports = router;
