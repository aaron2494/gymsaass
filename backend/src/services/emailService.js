/**
 * EMAIL SERVICE - Usando Resend (resend.com)
 * Free tier: 3.000 emails/mes, sin tarjeta de crédito.
 * npm install resend
 *
 * Alternativa gratuita: Nodemailer + Gmail SMTP
 * (descomentar sección alternativa al final del archivo)
 */

const logger = require('../config/logger');

// Inicializar Resend solo si hay API key configurada
let resend = null;
try {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resend = new Resend(process.env.RESEND_API_KEY);
  }
} catch (e) {
  logger.warn('Resend no disponible. Emails desactivados.');
}

const FROM_EMAIL = process.env.EMAIL_FROM || 'GymSaaS <noreply@tudominio.com>';
const APP_NAME = 'GymSaaS';

// ============================================================
// HELPER: enviar email con fallback a log
// ============================================================
async function sendEmail({ to, subject, html }) {
  if (!resend) {
    logger.info(`[EMAIL MOCK] To: ${to} | Subject: ${subject}`);
    return { success: true, mock: true };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    if (error) throw error;
    logger.info(`Email enviado a ${to}: ${subject}`);
    return { success: true, data };
  } catch (err) {
    logger.error(`Error enviando email a ${to}:`, err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// TEMPLATE BASE
// ============================================================
function baseTemplate(content, gymName = APP_NAME) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f8; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .header { background: #6C63FF; padding: 28px 32px; }
    .header h1 { color: white; margin: 0; font-size: 22px; }
    .header p { color: rgba(255,255,255,0.8); margin: 4px 0 0; font-size: 13px; }
    .body { padding: 28px 32px; color: #2D3436; line-height: 1.6; }
    .body h2 { font-size: 18px; color: #2D3436; margin-top: 0; }
    .cta { display: inline-block; background: #6C63FF; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; margin: 16px 0; }
    .alert-box { background: #FFF8E1; border-left: 4px solid #FFA502; padding: 14px 16px; border-radius: 0 8px 8px 0; margin: 16px 0; }
    .alert-box.danger { background: #FFF0F0; border-color: #FF4757; }
    .alert-box.success { background: #E8FFF3; border-color: #2ED573; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
    .stat-box { background: #f8f9fa; border-radius: 10px; padding: 14px; text-align: center; }
    .stat-value { font-size: 26px; font-weight: 700; color: #6C63FF; }
    .stat-label { font-size: 12px; color: #636E72; margin-top: 3px; }
    .footer { background: #f8f9fa; padding: 16px 32px; text-align: center; font-size: 12px; color: #B2BEC3; }
    .divider { border: none; border-top: 1px solid #f1f2f6; margin: 20px 0; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>💪 ${APP_NAME}</h1>
      <p>${gymName}</p>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      Este email fue enviado automáticamente por ${APP_NAME}.<br>
      Si tienes dudas, contacta al soporte.
    </div>
  </div>
</body>
</html>`;
}

// ============================================================
// EMAIL: Suscripción del cliente por vencer (al admin)
// ============================================================
async function sendClientSubscriptionExpiring({ adminEmail, gymName, expiringClients }) {
  const rows = expiringClients.map(c =>
    `<li><strong>${c.full_name}</strong> (${c.email}) — vence el <strong>${c.end_date}</strong></li>`
  ).join('');

  const content = `
    <h2>⚠️ Suscripciones por vencer</h2>
    <p>Hola, estos clientes de <strong>${gymName}</strong> tienen su suscripción próxima a vencer:</p>
    <div class="alert-box">
      <ul>${rows}</ul>
    </div>
    <p>Te recomendamos contactarlos para renovar antes de que pierdan acceso.</p>
    <a href="#" class="cta">Abrir panel</a>
    <hr class="divider">
    <p style="font-size:13px;color:#636E72;">Recibirás este aviso automáticamente 7 días antes del vencimiento.</p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `⚠️ ${expiringClients.length} cliente(s) con suscripción por vencer — ${gymName}`,
    html: baseTemplate(content, gymName),
  });
}

// ============================================================
// EMAIL: Aviso al cliente de que su suscripción vence
// ============================================================
async function sendClientSubscriptionReminderToClient({ clientEmail, clientName, gymName, endDate, daysLeft }) {
  const urgency = daysLeft <= 3 ? 'danger' : '';
  const emoji = daysLeft <= 3 ? '🚨' : '⏰';

  const content = `
    <h2>${emoji} Tu membresía vence pronto</h2>
    <p>Hola <strong>${clientName}</strong>,</p>
    <p>Tu membresía en <strong>${gymName}</strong> vence el <strong>${endDate}</strong>.</p>
    <div class="alert-box ${urgency}">
      <strong>Te quedan ${daysLeft} día${daysLeft !== 1 ? 's' : ''} de acceso.</strong><br>
      Habla con tu gimnasio para renovar y no perder tu rutina.
    </div>
    <p>Si ya pagaste, ignorá este mensaje.</p>
  `;

  return sendEmail({
    to: clientEmail,
    subject: `${emoji} Tu membresía en ${gymName} vence en ${daysLeft} días`,
    html: baseTemplate(content, gymName),
  });
}

// ============================================================
// EMAIL: Suscripción SaaS del gimnasio por vencer (al admin)
// ============================================================
async function sendSaasSubscriptionExpiring({ adminEmail, gymName, endDate, daysLeft, paymentUrl }) {
  const content = `
    <h2>⚠️ Tu plan GymSaaS vence pronto</h2>
    <p>Hola, el plan de <strong>${gymName}</strong> en ${APP_NAME} vence el <strong>${endDate}</strong>.</p>
    <div class="alert-box">
      <strong>Quedan ${daysLeft} días.</strong><br>
      Si no renovás, el acceso al sistema quedará suspendido para vos y tus clientes.
    </div>
    ${paymentUrl ? `<a href="${paymentUrl}" class="cta">Renovar ahora →</a>` : ''}
    <p style="font-size:13px;color:#636E72;">Si ya realizaste el pago, el acceso se renovará automáticamente.</p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `⚠️ Tu plan en GymSaaS vence en ${daysLeft} días — ${gymName}`,
    html: baseTemplate(content, gymName),
  });
}

// ============================================================
// EMAIL: Bienvenida al nuevo gimnasio
// ============================================================
async function sendWelcomeGym({ adminEmail, gymName, adminName, tempPassword }) {
  const content = `
    <h2>🎉 ¡Bienvenido a ${APP_NAME}!</h2>
    <p>Hola <strong>${adminName}</strong>,</p>
    <p>Tu gimnasio <strong>${gymName}</strong> ya está activo en ${APP_NAME}.</p>
    <div class="alert-box success">
      <strong>Tus credenciales de acceso:</strong><br>
      📧 Email: <strong>${adminEmail}</strong><br>
      🔑 Contraseña temporal: <strong>${tempPassword}</strong>
    </div>
    <p><strong>Próximos pasos:</strong></p>
    <ul>
      <li>Iniciar sesión en la app y cambiar tu contraseña</li>
      <li>Agregar tus primeros clientes</li>
      <li>Crear rutinas de entrenamiento</li>
      <li>Asignar rutinas a cada cliente</li>
    </ul>
    <p style="font-size:13px;color:#636E72;">Si tenés problemas para ingresar, contactá al soporte.</p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `🎉 Bienvenido a ${APP_NAME} — ${gymName}`,
    html: baseTemplate(content, gymName),
  });
}

// ============================================================
// EMAIL: Resumen semanal al admin (health score)
// ============================================================
async function sendWeeklyDigest({ adminEmail, gymName, stats }) {
  const scoreColor = stats.healthScore >= 80 ? '#2ED573' : stats.healthScore >= 50 ? '#FFA502' : '#FF4757';
  const scoreEmoji = stats.healthScore >= 80 ? '🟢' : stats.healthScore >= 50 ? '🟡' : '🔴';

  const content = `
    <h2>📊 Resumen semanal — ${gymName}</h2>
    <p>Aquí está el estado de tu gimnasio esta semana:</p>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-value" style="color:${scoreColor}">${stats.healthScore}</div>
        <div class="stat-label">${scoreEmoji} Health Score</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${stats.activeClients}</div>
        <div class="stat-label">Clientes activos</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${stats.checkInsThisWeek}</div>
        <div class="stat-label">Check-ins esta semana</div>
      </div>
      <div class="stat-box">
        <div class="stat-value" style="color:#FF4757">${stats.expiringCount}</div>
        <div class="stat-label">Subs por vencer</div>
      </div>
    </div>
    ${stats.expiringCount > 0 ? `
    <div class="alert-box">
      <strong>Acción recomendada:</strong> Tenés ${stats.expiringCount} cliente(s) con suscripción por vencer en los próximos 7 días.
    </div>` : `
    <div class="alert-box success">
      ¡Excelente! Todas las suscripciones están al día.
    </div>`}
  `;

  return sendEmail({
    to: adminEmail,
    subject: `📊 Resumen semanal ${gymName} — Health Score: ${stats.healthScore}/100`,
    html: baseTemplate(content, gymName),
  });
}

module.exports = {
  sendEmail,
  sendClientSubscriptionExpiring,
  sendClientSubscriptionReminderToClient,
  sendSaasSubscriptionExpiring,
  sendWelcomeGym,
  sendWeeklyDigest,
};
