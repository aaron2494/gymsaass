const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const publicController = require('../controllers/publicController');

// Rate limit estricto para registro (evitar spam)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  message: { error: 'Demasiados intentos. Intentá en 1 hora.' },
});

router.get('/plans', publicController.getPlans);
router.post('/register', registerLimiter, publicController.register);
router.get('/register/status/:externalRef', publicController.checkRegistrationStatus);

module.exports = router;
