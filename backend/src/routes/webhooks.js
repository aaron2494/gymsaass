const express = require('express');
const router  = express.Router();

const { handleWebhook } = require('../controllers/webhookController');

// IMPORTANTE: express.json() se aplica acá (no en app.js) porque el webhook
// de MercadoPago necesita el body parseado pero con headers específicos.
router.post('/mercadopago', express.json(), handleWebhook);

module.exports = router;
