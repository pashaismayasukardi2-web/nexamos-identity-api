'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool }    = require('../../config/database');
const { auditLog }   = require('../../middleware/requireOIDC');

/**
 * GET /api/v1/organizations/:id/entitlements
 * Daftar entitlement produk sebuah organisasi.
 */
async function getOrgEntitlements(req, res) {
  try {
    const pool  = getPool();
    const orgId = req.params.id;

    // User harus member org
    const [[membership]] = await pool.query(
      "SELECT id FROM iam_organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      [orgId, req.iamUser.id]
    );
    if (!membership) return res.status(403).json({ status: 'error', message: 'Access denied.' });

    const [rows] = await pool.query(
      `SELECT pe.id, pe.status, pe.plan_code, pe.valid_from, pe.valid_until, pe.created_at,
              a.code AS app_code, a.name AS app_name, a.domain
       FROM iam_product_entitlements pe
       JOIN iam_applications a ON a.id = pe.application_id
       WHERE pe.organization_id = ?
       ORDER BY a.code ASC`,
      [orgId]
    );

    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * POST /api/v1/organizations/:id/entitlements (Superadmin only)
 * Grant entitlement produk ke sebuah organisasi.
 */
async function grantEntitlement(req, res) {
  try {
    const pool      = getPool();
    const orgId     = req.params.id;
    const actorId   = req.iamUser.id;
    const { app_code, plan_code = null, valid_until = null } = req.body;

    if (!app_code) return res.status(400).json({ status: 'error', message: 'app_code wajib diisi.' });

    // Resolve application
    const [[app]] = await pool.query(
      "SELECT id FROM iam_applications WHERE code = ? AND status != 'inactive' LIMIT 1",
      [app_code]
    );
    if (!app) return res.status(404).json({ status: 'error', message: `Application '${app_code}' tidak ditemukan.` });

    // Cek org exist
    const [[org]] = await pool.query("SELECT id FROM iam_organizations WHERE id = ? LIMIT 1", [orgId]);
    if (!org) return res.status(404).json({ status: 'error', message: 'Organization not found.' });

    // Cek apakah sudah ada entitlement aktif
    const [[existing]] = await pool.query(
      "SELECT id FROM iam_product_entitlements WHERE organization_id = ? AND application_id = ? AND status = 'active' LIMIT 1",
      [orgId, app.id]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', message: 'Active entitlement already exists.' });
    }

    const entId = uuidv4();
    await pool.query(
      `INSERT INTO iam_product_entitlements
         (id, organization_id, user_id, application_id, status, plan_code, valid_from, valid_until)
       VALUES (?, ?, NULL, ?, 'active', ?, NOW(), ?)`,
      [entId, orgId, app.id, plan_code, valid_until || null]
    );

    await auditLog({
      eventType:  'ENTITLEMENT_GRANTED',
      actorId,
      targetType: 'organization',
      targetId:   orgId,
      payload:    { app_code, plan_code, valid_until },
      req,
    });

    res.status(201).json({ status: 'ok', message: `Entitlement '${app_code}' granted.`, data: { id: entId } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * PATCH /api/v1/entitlements/:id (Superadmin only)
 * Update status / plan entitlement.
 */
async function updateEntitlement(req, res) {
  try {
    const pool      = getPool();
    const entId     = req.params.id;
    const actorId   = req.iamUser.id;
    const { status, plan_code, valid_until } = req.body;

    const validStatuses = ['active', 'inactive', 'revoked', 'expired'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ status: 'error', message: `Status harus salah satu dari: ${validStatuses.join(', ')}` });
    }

    const [[ent]] = await pool.query('SELECT id, status FROM iam_product_entitlements WHERE id = ? LIMIT 1', [entId]);
    if (!ent) return res.status(404).json({ status: 'error', message: 'Entitlement not found.' });

    const clauses = [];
    const params  = [];
    if (status)      { clauses.push('status = ?');      params.push(status); }
    if (plan_code)   { clauses.push('plan_code = ?');   params.push(plan_code); }
    if (valid_until) { clauses.push('valid_until = ?'); params.push(valid_until); }

    if (clauses.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Tidak ada perubahan.' });
    }

    params.push(entId);
    await pool.query(`UPDATE iam_product_entitlements SET ${clauses.join(', ')} WHERE id = ?`, params);

    await auditLog({
      eventType:  'ENTITLEMENT_UPDATED',
      actorId,
      targetType: 'entitlement',
      targetId:   entId,
      payload:    { status, plan_code, valid_until, from: ent.status },
      req,
    });

    res.json({ status: 'ok', message: 'Entitlement updated.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/organizations/:id/applications
 * Daftar aplikasi yang bisa diakses org (entitlement active).
 */
async function getOrgApplications(req, res) {
  try {
    const pool  = getPool();
    const orgId = req.params.id;

    const [[membership]] = await pool.query(
      "SELECT id FROM iam_organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      [orgId, req.iamUser.id]
    );
    if (!membership) return res.status(403).json({ status: 'error', message: 'Access denied.' });

    const [rows] = await pool.query(
      `SELECT a.code, a.name, a.domain, pe.status AS entitlement_status, pe.plan_code
       FROM iam_product_entitlements pe
       JOIN iam_applications a ON a.id = pe.application_id
       WHERE pe.organization_id = ? AND pe.status = 'active'`,
      [orgId]
    );

    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = { getOrgEntitlements, grantEntitlement, updateEntitlement, getOrgApplications };

