const express = require('express');
const router = express.Router();
const ownerController = require('../controllers/ownerController');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

// Todas las rutas requieren ser owner
router.use(authenticate, requireRole('owner'));

router.get('/dashboard', ownerController.getDashboard);
router.get('/gyms', ownerController.getGyms);
router.post('/gyms', ownerController.createGym);
router.get('/gyms/:tenantId', ownerController.getGymDetail);
router.patch('/gyms/:tenantId/status', validate(schemas.updateTenantStatus), ownerController.updateGymStatus);
router.post('/gyms/:tenantId/payment-link', ownerController.generateSaasPaymentLink);

module.exports = router;
