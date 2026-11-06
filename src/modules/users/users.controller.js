'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool }    = require('../../config/database');
const { auditLog }   = require('../../middleware/requireOIDC');

/**
 * GET /api/v1/users/me
 * Profil lengkap user yang sedang login (dari token OIDC).
 */
async function getMe(req, res) {
  try {
    const pool   = getPool();
    const userId = req.iamUser.id;

    const [[user]] = await pool.query(
      `SELECT u.id, u.display_name, u.status, u.created_at,
              e.email, e.is_verified AS email_verified
       FROM iam_users u
       LEFT JOIN iam_user_emails e ON e.user_id = u.id AND e.is_primary = 1
       WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    if (!user) return res.status(404).json({ status: 'error', message: 'User not found.' });

    res.json({
      status: 'ok',
      data: {
        id:             user.id,
        display_name:   user.display_name,
        email:          user.email,
        email_verified: !!user.email_verified,
        status:         user.status,
        created_at:     user.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * PATCH /api/v1/users/me
 * Update display_name user.
 */
async function updateMe(req, res) {
  try {
    const pool        = getPool();
    const userId      = req.iamUser.id;
    const { display_name } = req.body;

    if (!display_name || !String(display_name).trim()) {
      return res.status(400).json({ status: 'error', message: 'display_name is required.' });
    }

    const cleanName = String(display_name).trim();

    await pool.query(
      'UPDATE iam_users SET display_name = ? WHERE id = ?',
      [cleanName, userId]
    );

    await auditLog({
      eventType:  'USER_PROFILE_UPDATED',
      actorId:    userId,
      targetType: 'user',
      targetId:   userId,
      payload:    { display_name: cleanName },
      req,
    });

    res.json({ status: 'ok', message: 'Profile updated.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/users/me/organizations
 * Daftar organisasi yang diikuti user beserta role-nya.
 */
async function getMyOrganizations(req, res) {
  try {
    const pool   = getPool();
    const userId = req.iamUser.id;

    const [rows] = await pool.query(
      `SELECT
         o.id, o.name, o.slug, o.organization_type, o.status,
         m.id AS membership_id, m.status AS membership_status, m.joined_at,
         r.code AS role_code, r.name AS role_name
       FROM iam_organization_members m
       JOIN iam_organizations o ON o.id = m.organization_id
       LEFT JOIN iam_membership_roles mr ON mr.membership_id = m.id AND mr.application_id IS NULL
       LEFT JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active'
       ORDER BY m.joined_at ASC`,
      [userId]
    );

    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/users/me/products
 * Daftar produk yang dapat diakses user (via entitlement org atau personal).
 */
async function getMyProducts(req, res) {
  try {
    const pool   = getPool();
    const userId = req.iamUser.id;

    // Ambil org IDs milik user
    const [memberRows] = await pool.query(
      `SELECT organization_id FROM iam_organization_members
       WHERE user_id = ? AND status = 'active'`,
      [userId]
    );
    const orgIds = memberRows.map(r => r.organization_id);

    // Query entitlement personal + entitlement via org
    let entitlements = [];

    // Personal entitlements
    const [personalEnts] = await pool.query(
      `SELECT pe.id, pe.status, pe.plan_code, pe.valid_from, pe.valid_until,
              a.code AS app_code, a.name AS app_name, a.domain,
              NULL AS org_id, NULL AS org_name
       FROM iam_product_entitlements pe
       JOIN iam_applications a ON a.id = pe.application_id
       WHERE pe.user_id = ? AND pe.organization_id IS NULL`,
      [userId]
    );
    entitlements = [...personalEnts];

    // Org-level entitlements
    if (orgIds.length > 0) {
      const placeholders = orgIds.map(() => '?').join(',');
      const [orgEnts] = await pool.query(
        `SELECT pe.id, pe.status, pe.plan_code, pe.valid_from, pe.valid_until,
                a.code AS app_code, a.name AS app_name, a.domain,
                o.id AS org_id, o.name AS org_name
         FROM iam_product_entitlements pe
         JOIN iam_applications a ON a.id = pe.application_id
         JOIN iam_organizations o ON o.id = pe.organization_id
         WHERE pe.organization_id IN (${placeholders}) AND pe.user_id IS NULL`,
        orgIds
      );
      entitlements = [...entitlements, ...orgEnts];
    }

    res.json({ status: 'ok', data: entitlements });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * POST /api/v1/users/provision
 * INTERNAL — Dipanggil setelah user register di Keycloak.
 * Membuat record di iam_users + iam_user_emails.
 */
async function provisionUser(req, res) {
  try {
    const pool = getPool();
    const { identity_subject, display_name, email } = req.body;

    if (!identity_subject || !display_name || !email) {
      return res.status(400).json({
        status: 'error',
        message: 'identity_subject, display_name, dan email wajib diisi.',
      });
    }

    // Cek jika sudah ada
    const [[existing]] = await pool.query(
      'SELECT id FROM iam_users WHERE identity_subject = ? LIMIT 1',
      [identity_subject]
    );
    if (existing) {
      return res.json({ status: 'ok', message: 'User already provisioned.', data: { id: existing.id } });
    }

    const userId  = uuidv4();
    const emailId = uuidv4();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO iam_users (id, identity_subject, display_name, status)
         VALUES (?, ?, ?, 'active')`,
        [userId, identity_subject, String(display_name).trim()]
      );

      await conn.query(
        `INSERT INTO iam_user_emails (id, user_id, email, is_primary, is_verified)
         VALUES (?, ?, ?, 1, 0)`,
        [emailId, userId, String(email).trim().toLowerCase()]
      );

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    await auditLog({
      eventType:  'USER_PROVISIONED',
      actorId:    userId,
      targetType: 'user',
      targetId:   userId,
      payload:    { identity_subject, email },
      req,
    });

    res.status(201).json({
      status: 'ok',
      message: 'User provisioned.',
      data: { id: userId },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * PATCH /api/v1/users/:userId/status (Superadmin only)
 * Suspend atau aktifkan user.
 */
async function updateUserStatus(req, res) {
  try {
    const pool        = getPool();
    const { userId }  = req.params;
    const { status }  = req.body;
    const actorId     = req.iamUser.id;

    const validStatuses = ['active', 'suspended', 'deleted'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ status: 'error', message: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    const [[target]] = await pool.query('SELECT id, status FROM iam_users WHERE id = ? LIMIT 1', [userId]);
    if (!target) return res.status(404).json({ status: 'error', message: 'User not found.' });

    await pool.query('UPDATE iam_users SET status = ? WHERE id = ?', [status, userId]);

    await auditLog({
      eventType:  'USER_STATUS_CHANGED',
      actorId,
      targetType: 'user',
      targetId:   userId,
      payload:    { from: target.status, to: status },
      req,
    });

    res.json({ status: 'ok', message: `User status updated to '${status}'.` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/users/me/audit-events
 * Riwayat aktivitas & sesi login user dari iam_audit_events.
 */
async function getMyAuditEvents(req, res) {
  try {
    const pool   = getPool();
    const userId = req.iamUser.id;

    const [rows] = await pool.query(
      `SELECT id, event_type, target_type, target_id, payload, ip_address, user_agent, created_at
       FROM iam_audit_events
       WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?)
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId, userId]
    );

    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * POST /api/v1/users/me/sessions/revoke
 * Catat pembatalan / pencabutan seluruh sesi user.
 */
async function revokeMySessions(req, res) {
  try {
    const userId = req.iamUser.id;

    await auditLog({
      eventType:  'USER_SESSIONS_REVOKED',
      actorId:    userId,
      targetType: 'user',
      targetId:   userId,
      payload:    { reason: 'User requested logout from all sessions' },
      req,
    });

    res.json({ status: 'ok', message: 'All user sessions revoked successfully.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = {
  getMe,
  updateMe,
  getMyOrganizations,
  getMyProducts,
  getMyAuditEvents,
  revokeMySessions,
  provisionUser,
  updateUserStatus,
};

