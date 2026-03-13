const supabase = require('../config/supabase');
const logger   = require('../config/logger');

async function getClientNotes(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('client_notes')
      .select('id, content, created_at, admin_id, users!client_notes_admin_id_fkey(full_name)')
      .eq('user_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (err) {
    logger.error('getClientNotes error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// POST /admin/clients/:id/notes — Agregar nota sobre cliente
// ============================================================
async function addClientNote(req, res) {
  try {
    const tenantId = req.tenantId;
    const adminId  = req.user.id;
    const { id }   = req.params;
    const { content } = req.body;

    if (!content?.trim()) return res.status(400).json({ error: 'Contenido requerido' });

    const { data, error } = await supabase
      .from('client_notes')
      .insert({ user_id: id, tenant_id: tenantId, admin_id: adminId, content: content.trim() })
      .select('id, content, created_at')
      .single();

    if (error) throw error;
    res.status(201).json({ note: data });
  } catch (err) {
    logger.error('addClientNote error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// DELETE /admin/clients/:id/notes/:noteId — Eliminar nota
// ============================================================
async function deleteClientNote(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id, noteId } = req.params;

    const { error } = await supabase
      .from('client_notes')
      .delete()
      .eq('id', noteId)
      .eq('user_id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('deleteClientNote error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// GET /admin/clients/ranking — Ranking de clientes más activos
// ============================================================

module.exports = { getClientNotes, addClientNote, deleteClientNote };
