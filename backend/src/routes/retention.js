/**
 * RUTAS DE RETENCIÓN
 * Avisos, check-ins, health score, notas de clientes
 */
const express = require('express');
const router = express.Router();

const { authenticate, requireRole } = require('../middleware/auth');
const noticesController = require('../controllers/noticesController');
const checkInController = require('../controllers/checkInController');
const insightsController = require('../controllers/insightsController');

// ============================================================
// AVISOS (notices)
// ============================================================

// Admin: gestión de avisos
router.post('/notices',
  authenticate, requireRole('admin', 'owner'),
  noticesController.createNotice
);
router.get('/notices',
  authenticate, requireRole('admin', 'owner'),
  noticesController.getNotices
);
router.patch('/notices/:noticeId',
  authenticate, requireRole('admin', 'owner'),
  noticesController.updateNotice
);
router.delete('/notices/:noticeId',
  authenticate, requireRole('admin', 'owner'),
  noticesController.deleteNotice
);

// Client: ver avisos activos — definido en routes/client.js bajo /client/notices

// ============================================================
// CHECK-INS
// ============================================================

// Cliente: auto check-in
router.post('/client/checkin',
  authenticate, requireRole('client'),
  checkInController.selfCheckIn
);

// Cliente: ver su historial
router.get('/client/checkins',
  authenticate, requireRole('client'),
  checkInController.getMyCheckIns
);

// Admin: registrar check-in manual
router.post('/admin/checkin',
  authenticate, requireRole('admin', 'owner'),
  checkInController.adminCheckIn
);

// Admin: reporte de asistencia del gimnasio
router.get('/admin/attendance',
  authenticate, requireRole('admin', 'owner'),
  checkInController.getGymAttendance
);

// ============================================================
// HEALTH SCORE
// ============================================================

// Admin: ver su propio health score
router.get('/admin/health-score',
  authenticate, requireRole('admin', 'owner'),
  insightsController.getMyHealthScore
);

// Owner: ver health score de todos los gyms
router.get('/owner/health-scores',
  authenticate, requireRole('owner'),
  insightsController.getAllHealthScores
);

// ============================================================
// NOTAS DE CLIENTES
// ============================================================

router.get('/admin/clients/:clientId/notes',
  authenticate, requireRole('admin', 'owner'),
  insightsController.getClientNotes
);
router.post('/admin/clients/:clientId/notes',
  authenticate, requireRole('admin', 'owner'),
  insightsController.addClientNote
);
router.delete('/admin/notes/:noteId',
  authenticate, requireRole('admin', 'owner'),
  insightsController.deleteClientNote
);

module.exports = router;
