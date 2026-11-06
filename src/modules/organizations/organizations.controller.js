'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool }    = require('../../config/database');
const { auditLog }   = require('../../middleware/requireOIDC');

/**
 * POST /api/v1/organizations
 * Buat organisasi baru. User otomatis jadi ORG_OWNER.
 */
async function createOrganization(req, res) {
  try {
    const pool   = getPool();
    const userId = req.iamUser.id;
    const { name, slug, organization_type = 'business' } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ status: 'error', message: 'name dan slug wajib diisi.' });
    }

    // Validasi slug: lowercase, alphanumeric + dash
    const cleanSlug = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Cek duplikat slug
    const [[dupSlug]] = await pool.query(
      'SELECT id FROM iam_organizations WHERE slug = ? LIMIT 1',
      [cleanSlug]
    );
    if (dupSlug) {
      return res.status(409).json({ status: 'error', message: `Slug '${cleanSlug}' sudah digunakan.` });
    }

    const orgId        = uuidv4();
    const membershipId = uuidv4();
    const mrId         = uuidv4();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Buat org
      await conn.query(
        `INSERT INTO iam_organizations (id, name, slug, organization_type, status, created_by)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        [orgId, String(name).trim(), cleanSlug, organization_type, userId]
      );

      // 2. Daftarkan creator sebagai member
      await conn.query(
        `INSERT INTO iam_organization_members (id, organization_id, user_id, status)
         VALUES (?, ?, ?, 'active')`,
        [membershipId, orgId, userId]
      );

      // 3. Assign role ORG_OWNER
      const [[ownerRole]] = await conn.query(
        "SELECT id FROM iam_roles WHERE code = 'ORG_OWNER' LIMIT 1"
      );
      if (ownerRole) {
        await conn.query(
          `INSERT INTO iam_membership_roles (id, membership_id, role_id, application_id)
           VALUES (?, ?, ?, NULL)`,
          [mrId, membershipId, ownerRole.id]
        );
      }

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    await auditLog({
      eventType:  'ORGANIZATION_CREATED',
      actorId:    userId,
      targetType: 'organization',
      targetId:   orgId,
      payload:    { name, slug: cleanSlug, organization_type },
      req,
    });

    res.status(201).json({
      status: 'ok',
      message: 'Organization created.',
      data: { id: orgId, slug: cleanSlug, name, organization_type },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/organizations/:id
 */
async function getOrganization(req, res) {
  try {
    const pool  = getPool();
    const orgId = req.params.id;

    const [[org]] = await pool.query(
      'SELECT id, name, slug, organization_type, status, created_by, created_at FROM iam_organizations WHERE id = ? LIMIT 1',
      [orgId]
    );
    if (!org) return res.status(404).json({ status: 'error', message: 'Organization not found.' });

    // Validasi: user harus jadi member
    const [[membership]] = await pool.query(
      "SELECT id FROM iam_organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      [orgId, req.iamUser.id]
    );
    if (!membership) {
      return res.status(403).json({ status: 'error', message: 'Access denied.' });
    }

    res.json({ status: 'ok', data: org });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * PATCH /api/v1/organizations/:id
 */
async function updateOrganization(req, res) {
  try {
    const pool      = getPool();
    const orgId     = req.params.id;
    const userId    = req.iamUser.id;
    const { name }  = req.body;

    if (!name) return res.status(400).json({ status: 'error', message: 'name wajib diisi.' });

    // Hanya ORG_OWNER / ORG_ADMIN yang boleh update
    const [[membership]] = await pool.query(
      `SELECT m.id FROM iam_organization_members m
       JOIN iam_membership_roles mr ON mr.membership_id = m.id
       JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
         AND r.code IN ('ORG_OWNER', 'ORG_ADMIN')
       LIMIT 1`,
      [orgId, userId]
    );
    if (!membership) return res.status(403).json({ status: 'error', message: 'Insufficient permissions.' });

    await pool.query('UPDATE iam_organizations SET name = ? WHERE id = ?', [String(name).trim(), orgId]);

    await auditLog({ eventType: 'ORGANIZATION_UPDATED', actorId: userId, targetType: 'organization', targetId: orgId, payload: { name }, req });
    res.json({ status: 'ok', message: 'Organization updated.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/organizations/:id/members
 */
async function getMembers(req, res) {
  try {
    const pool  = getPool();
    const orgId = req.params.id;

    // User harus member
    const [[membership]] = await pool.query(
      "SELECT id FROM iam_organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      [orgId, req.iamUser.id]
    );
    if (!membership) return res.status(403).json({ status: 'error', message: 'Access denied.' });

    const [rows] = await pool.query(
      `SELECT
         m.id AS membership_id, m.status AS membership_status, m.joined_at,
         u.id AS user_id, u.display_name, u.status AS user_status,
         e.email,
         r.code AS role_code, r.name AS role_name
       FROM iam_organization_members m
       JOIN iam_users u ON u.id = m.user_id
       LEFT JOIN iam_user_emails e ON e.user_id = u.id AND e.is_primary = 1
       LEFT JOIN iam_membership_roles mr ON mr.membership_id = m.id AND mr.application_id IS NULL
       LEFT JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.organization_id = ?
       ORDER BY m.joined_at ASC`,
      [orgId]
    );

    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * POST /api/v1/organizations/:id/members
 * Tambah / undang member baru ke organisasi.
 */
async function addMember(req, res) {
  try {
    const pool    = getPool();
    const orgId   = req.params.id;
    const actorId = req.iamUser.id;
    const { email, role_code = 'ORG_MEMBER' } = req.body;

    if (!email || !String(email).trim()) {
      return res.status(400).json({ status: 'error', message: 'Email member wajib diisi.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    // Aktor harus ORG_OWNER atau ORG_ADMIN
    const [[actorMember]] = await pool.query(
      `SELECT m.id FROM iam_organization_members m
       JOIN iam_membership_roles mr ON mr.membership_id = m.id
       JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
         AND r.code IN ('ORG_OWNER', 'ORG_ADMIN') AND mr.application_id IS NULL
       LIMIT 1`,
      [orgId, actorId]
    );
    if (!actorMember) {
      return res.status(403).json({ status: 'error', message: 'Hanya Admin atau Owner yang dapat menambahkan member.' });
    }

    // Cari user berdasarkan email
    const [[userEmailRecord]] = await pool.query(
      `SELECT u.id, u.display_name FROM iam_users u
       JOIN iam_user_emails e ON e.user_id = u.id
       WHERE LOWER(e.email) = ? LIMIT 1`,
      [cleanEmail]
    );

    let targetUserId;
    if (userEmailRecord) {
      targetUserId = userEmailRecord.id;
    } else {
      // Jika user belum ada di NexaMOS, buat profil user terdaftar awal
      targetUserId = uuidv4();
      const emailId = uuidv4();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO iam_users (id, identity_subject, display_name, status)
           VALUES (?, ?, ?, 'active')`,
          [targetUserId, `pending_${uuidv4().substring(0, 8)}`, cleanEmail.split('@')[0]]
        );
        await conn.query(
          `INSERT INTO iam_user_emails (id, user_id, email, is_primary, is_verified)
           VALUES (?, ?, ?, 1, 0)`,
          [emailId, targetUserId, cleanEmail]
        );
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    // Cek apakah sudah terdaftar di org ini
    const [[existingMember]] = await pool.query(
      'SELECT id, status FROM iam_organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1',
      [orgId, targetUserId]
    );

    if (existingMember && existingMember.status === 'active') {
      return res.status(409).json({ status: 'error', message: 'User sudah aktif sebagai member di organisasi ini.' });
    }

    // Validasi role
    const [[roleRecord]] = await pool.query(
      'SELECT id FROM iam_roles WHERE code = ? LIMIT 1',
      [role_code]
    );
    const validRoleId = roleRecord ? roleRecord.id : null;

    const membershipId = existingMember ? existingMember.id : uuidv4();

    if (existingMember) {
      await pool.query(
        "UPDATE iam_organization_members SET status = 'active' WHERE id = ?",
        [membershipId]
      );
    } else {
      await pool.query(
        `INSERT INTO iam_organization_members (id, organization_id, user_id, status)
         VALUES (?, ?, ?, 'active')`,
        [membershipId, orgId, targetUserId]
      );
    }

    if (validRoleId) {
      const [[existingMr]] = await pool.query(
        'SELECT id FROM iam_membership_roles WHERE membership_id = ? AND application_id IS NULL LIMIT 1',
        [membershipId]
      );
      if (existingMr) {
        await pool.query('UPDATE iam_membership_roles SET role_id = ? WHERE id = ?', [validRoleId, existingMr.id]);
      } else {
        await pool.query(
          `INSERT INTO iam_membership_roles (id, membership_id, role_id, application_id)
           VALUES (?, ?, ?, NULL)`,
          [uuidv4(), membershipId, validRoleId]
        );
      }
    }

    await auditLog({
      eventType:  'MEMBER_INVITED',
      actorId,
      targetType: 'organization',
      targetId:   orgId,
      payload:    { targetUserId, email: cleanEmail, role_code },
      req,
    });

    res.status(201).json({
      status: 'ok',
      message: 'Member berhasil ditambahkan ke organisasi.',
      data: { user_id: targetUserId, membership_id: membershipId, role_code }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * PATCH /api/v1/organizations/:id/members/:userId
 * Update status membership (activate/suspend/removed) dan/atau role_code.
 */
async function updateMember(req, res) {
  try {
    const pool         = getPool();
    const { id: orgId, userId: targetUserId } = req.params;
    const actorId      = req.iamUser.id;
    const { status, role_code } = req.body;

    // Aktor harus ORG_OWNER atau ORG_ADMIN
    const [[actorMember]] = await pool.query(
      `SELECT m.id FROM iam_organization_members m
       JOIN iam_membership_roles mr ON mr.membership_id = m.id
       JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
         AND r.code IN ('ORG_OWNER', 'ORG_ADMIN') AND mr.application_id IS NULL
       LIMIT 1`,
      [orgId, actorId]
    );
    if (!actorMember) return res.status(403).json({ status: 'error', message: 'Insufficient permissions.' });

    // Cek target membership
    const [[targetMembership]] = await pool.query(
      'SELECT id, status FROM iam_organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1',
      [orgId, targetUserId]
    );
    if (!targetMembership) {
      return res.status(404).json({ status: 'error', message: 'Member not found.' });
    }

    if (status) {
      const validStatuses = ['active', 'suspended', 'removed'];
      if (!validStatuses.includes(status)) {
        const allowedList = validStatuses.join(', ');
        return res.status(400).json({
          status: 'error',
          message: 'Status harus salah satu dari: ' + allowedList,
        });
      }
      await pool.query(
        'UPDATE iam_organization_members SET status = ? WHERE id = ?',
        [status, targetMembership.id]
      );
    }

    if (role_code) {
      const [[roleRecord]] = await pool.query(
        'SELECT id FROM iam_roles WHERE code = ? LIMIT 1',
        [role_code]
      );
      if (roleRecord) {
        const [[existingMr]] = await pool.query(
          'SELECT id FROM iam_membership_roles WHERE membership_id = ? AND application_id IS NULL LIMIT 1',
          [targetMembership.id]
        );
        if (existingMr) {
          await pool.query('UPDATE iam_membership_roles SET role_id = ? WHERE id = ?', [roleRecord.id, existingMr.id]);
        } else {
          await pool.query(
            `INSERT INTO iam_membership_roles (id, membership_id, role_id, application_id)
             VALUES (?, ?, ?, NULL)`,
            [uuidv4(), targetMembership.id, roleRecord.id]
          );
        }
      }
    }

    await auditLog({
      eventType:  'MEMBER_UPDATED',
      actorId,
      targetType: 'organization_member',
      targetId:   targetUserId,
      payload:    { orgId, status, role_code },
      req,
    });

    res.json({ status: 'ok', message: 'Member berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * DELETE /api/v1/organizations/:id/members/:userId
 * Menghapus member dari organisasi.
 */
async function removeMember(req, res) {
  try {
    const pool = getPool();
    const { id: orgId, userId: targetUserId } = req.params;
    const actorId = req.iamUser.id;

    // Aktor harus ORG_OWNER atau ORG_ADMIN
    const [[actorMember]] = await pool.query(
      `SELECT m.id FROM iam_organization_members m
       JOIN iam_membership_roles mr ON mr.membership_id = m.id
       JOIN iam_roles r ON r.id = mr.role_id
       WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
         AND r.code IN ('ORG_OWNER', 'ORG_ADMIN') AND mr.application_id IS NULL
       LIMIT 1`,
      [orgId, actorId]
    );
    if (!actorMember) return res.status(403).json({ status: 'error', message: 'Insufficient permissions.' });

    await pool.query(
      "UPDATE iam_organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?",
      [orgId, targetUserId]
    );

    await auditLog({
      eventType:  'MEMBER_REMOVED',
      actorId,
      targetType: 'organization_member',
      targetId:   targetUserId,
      payload:    { orgId },
      req,
    });

    res.json({ status: 'ok', message: 'Member berhasil dikeluarkan dari organisasi.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = {
  createOrganization,
  getOrganization,
  updateOrganization,
  getMembers,
  addMember,
  updateMember,
  removeMember,
};

