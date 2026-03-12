const supabase = require('../config/supabase');
const logger = require('../config/logger');

// ============================================================
// ADMIN: Crear aviso
// ============================================================
async function createNotice(req, res) {
  try {
    const tenantId = req.tenantId;
    const { title, body, type = 'info', pinned = false, expires_at } = req.body;

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'Título y contenido son requeridos' });
    }

    const { data, error } = await supabase
      .from('notices')
      .insert({
        tenant_id: tenantId,
        title: title.trim(),
        body: body.trim(),
        type,
        pinned,
        is_active: true,          // siempre activo al crear
        expires_at: expires_at || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Aviso publicado', notice: data });
  } catch (err) {
    logger.error('createNotice error:', err);
    res.status(500).json({ error: 'Error creando aviso' });
  }
}

// ============================================================
// ADMIN: Listar avisos del tenant
// ============================================================
async function getNotices(req, res) {
  try {
    const tenantId = req.tenantId;

    const { data, error } = await supabase
      .from('notices')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ notices: data });
  } catch (err) {
    logger.error('getNotices error:', err);
    res.status(500).json({ error: 'Error obteniendo avisos' });
  }
}

// ============================================================
// ADMIN: Actualizar / desactivar aviso
// ============================================================
async function updateNotice(req, res) {
  try {
    const { noticeId } = req.params;
    const tenantId = req.tenantId;
    const { title, body, type, pinned, is_active, expires_at } = req.body;

    const { data, error } = await supabase
      .from('notices')
      .update({ title, body, type, pinned, is_active, expires_at })
      .eq('id', noticeId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Aviso no encontrado' });

    res.json({ message: 'Aviso actualizado', notice: data });
  } catch (err) {
    logger.error('updateNotice error:', err);
    res.status(500).json({ error: 'Error actualizando aviso' });
  }
}

// ============================================================
// ADMIN: Eliminar aviso
// ============================================================
async function deleteNotice(req, res) {
  try {
    const { noticeId } = req.params;
    const tenantId = req.tenantId;

    const { error } = await supabase
      .from('notices')
      .delete()
      .eq('id', noticeId)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ message: 'Aviso eliminado' });
  } catch (err) {
    logger.error('deleteNotice error:', err);
    res.status(500).json({ error: 'Error eliminando aviso' });
  }
}

// ============================================================
// CLIENT: Ver avisos activos de su gimnasio
// ============================================================
async function getClientNotices(req, res) {
  try {
    const tenantId = req.tenantId;
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('notices')
      .select('id, title, body, type, pinned, created_at, expires_at')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    res.json({ notices: data || [] });
  } catch (err) {
    logger.error('getClientNotices error:', err);
    res.status(500).json({ error: 'Error obteniendo avisos' });
  }
}

module.exports = { createNotice, getNotices, updateNotice, deleteNotice, getClientNotices };
