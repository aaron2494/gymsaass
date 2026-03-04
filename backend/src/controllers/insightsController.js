const supabase = require('../config/supabase');
const logger = require('../config/logger');
const { calculateHealthScore, generateSuggestions } = require('../services/healthScore');

// ============================================================
// ADMIN: Obtener health score propio
// ============================================================
async function getMyHealthScore(req, res) {
  try {
    const tenantId = req.tenantId;

    const result = await calculateHealthScore(tenantId);
    result.stats.healthScore = result.score;

    const suggestions = generateSuggestions(result.breakdown, result.stats);

    // Marcar como visto para quitar badge de "nuevo"
    await supabase.from('users')
      .update({ last_health_score_seen_at: new Date().toISOString() })
      .eq('id', req.user.id);

    res.json({
      score: result.score,
      breakdown: result.breakdown,
      stats: result.stats,
      suggestions,
      label: getScoreLabel(result.score),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('getMyHealthScore error:', err);
    res.status(500).json({ error: 'Error calculando health score' });
  }
}

function getScoreLabel(score) {
  if (score >= 85) return { text: 'Excelente 🚀', color: '#2ED573' };
  if (score >= 65) return { text: 'Bueno 👍', color: '#00B894' };
  if (score >= 45) return { text: 'Regular ⚠️', color: '#FFA502' };
  return { text: 'Necesita atención 🔴', color: '#FF4757' };
}

// ============================================================
// OWNER: Health scores de todos los gyms
// ============================================================
async function getAllHealthScores(req, res) {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('id, name, health_score, health_score_updated_at, status')
      .order('health_score', { ascending: true }); // los peores primero para actuar

    if (error) throw error;
    res.json({ gyms: data });
  } catch (err) {
    logger.error('getAllHealthScores error:', err);
    res.status(500).json({ error: 'Error obteniendo health scores' });
  }
}

// ============================================================
// ADMIN: Notas sobre un cliente (CRM mínimo)
// ============================================================
async function getClientNotes(req, res) {
  try {
    const { clientId } = req.params;
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('client_notes')
      .select('*, users!client_notes_admin_id_fkey(full_name)')
      .eq('client_id', clientId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (err) {
    logger.error('getClientNotes error:', err);
    res.status(500).json({ error: 'Error obteniendo notas' });
  }
}

async function addClientNote(req, res) {
  try {
    const { clientId } = req.params;
    const tenantId = req.tenantId;
    const { note } = req.body;

    if (!note?.trim()) return res.status(400).json({ error: 'La nota no puede estar vacía' });

    const { data, error } = await supabase
      .from('client_notes')
      .insert({
        tenant_id: tenantId,
        client_id: clientId,
        admin_id: req.user.id,
        note: note.trim(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Nota guardada', note: data });
  } catch (err) {
    logger.error('addClientNote error:', err);
    res.status(500).json({ error: 'Error guardando nota' });
  }
}

async function deleteClientNote(req, res) {
  try {
    const { noteId } = req.params;
    const tenantId = req.tenantId;

    await supabase
      .from('client_notes')
      .delete()
      .eq('id', noteId)
      .eq('tenant_id', tenantId)
      .eq('admin_id', req.user.id); // solo el creador puede borrar

    res.json({ message: 'Nota eliminada' });
  } catch (err) {
    logger.error('deleteClientNote error:', err);
    res.status(500).json({ error: 'Error eliminando nota' });
  }
}

module.exports = {
  getMyHealthScore,
  getAllHealthScores,
  getClientNotes,
  addClientNote,
  deleteClientNote,
};
