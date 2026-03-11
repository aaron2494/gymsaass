const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/change-password', authenticate, authController.changePassword);
router.post('/set-password', authController.setPassword); // deep link bienvenida, sin JWT

module.exports = router;
