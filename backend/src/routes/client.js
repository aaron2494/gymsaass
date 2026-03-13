const express = require('express');
const router  = express.Router();

const clientController  = require('../controllers/clientController');
const progressController = require('../controllers/progressController');
const noticesController = require('../controllers/noticesController');
const checkInController = require('../controllers/checkInController');
const { authenticate, requireRole } = require('../middleware/auth');

// Todas las rutas requieren ser cliente autenticado
router.use(authenticate, requireRole('client'));

// Perfil y suscripción
router.get('/profile',      clientController.getProfile);
router.get('/routine',      clientController.getMyRoutine);
router.get('/subscription', clientController.getMySubscription);
router.get('/payments',     clientController.getMyPayments);

// Workout logs y progreso
router.post('/workout-log',   progressController.logWorkout);
router.get('/workout-logs',   progressController.getWorkoutLogs);
router.get('/prs',            progressController.getPersonalRecords);
router.post('/body-progress', progressController.logBodyProgress);
router.get('/body-progress',  progressController.getBodyProgress);
router.get('/achievements',   progressController.getAchievements);

// Avisos del gimnasio
// NOTA: montado acá (bajo /client) para que matchee antes que la ruta genérica de retentionRoutes
router.get('/notices', noticesController.getClientNotices);

// Check-in de asistencia
router.post('/checkin',  checkInController.selfCheckIn);
router.get('/checkins',  checkInController.getMyCheckIns);

module.exports = router;
