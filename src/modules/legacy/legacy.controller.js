'use strict';

/**
 * Legacy Account Link Module
 *
 * Digunakan saat user CRM lama login pertama kali via OIDC.
 * Flow:
 *   1. CRM backend deteksi user belum punya Global User ID.
 *   2. CRM call POST /api/v1/legacy/link dengan data user lama.
 *   3. Identity API buat / resolusi Global User + isi legacy_account_links.
 *   4. CRM simpan global_user_id di sesi-nya.
 */

const { v4: uuidv4 } = require('uuid');
const { getPool }    = require('../../config/database');
const { auditLog }   = require('../../middleware/requireOIDC');

/**
 * POST /api/v1/legacy/link
 * Menghubungkan user CRM lama ke Global User ID.
 *
 * Body:
 *   - identity_subject  : Keycloak 'sub' (dari token OIDC user yang baru login)
 *   - display_name      : Nama tampil user
 *   - email             : Email user
 *   - source_system     : 'NEXAMOS_CRM'
 *   - legacy_user_id    : id integer dari tabel users tenant (string)
 *   - legacy_tenant_id  : slug tenant (contoh: 'derma-indonesia')
 *   - legacy_role       : role lama (Admin / Manager / CRO / dll)
 */
async function linkLegacyAccount(req, res) {
  try {
    const pool = getPool();
    const {
      identity_subject,
      display_name,
      email,
      source_system   = 'NEXAMOS_CRM',
      legacy_user_id,
      legacy_tenant_id,
      legacy_role,
    } = req.body;

    if (!identity_subject || !legacy_user_id || !legacy_tenant_id) {
      return res.status(400).json({
        status: 'error',
        message: 'identity_subject, legacy_user_id, dan legacy_tenant_id wajib diisi.',
      });
    }

    // 1. Cek apakah link sudah ada
    const [[existingLink]] = await pool.query(
      `SELECT l.id, l.user_id, l.migration_status
       FROM iam_legacy_account_links l
       WHERE l.source_system = ? AND l.legacy_user_id = ? AND l.legacy_tenant_id = ?
       LIMIT 1`,
      [source_system, String(legacy_user_id), legacy_tenant_id]
    );

    if (existingLink) {
      // Link sudah ada — kembalikan Global User ID
      return res.json({
        status: 'ok',
        message: 'Already linked.',
        data: {
          global_user_id:    existingLink.user_id,
          migration_status:  existingLink.migration_status,
        },
      });
    }

    // 2. Cek apakah Global User sudah ada berdasarkan identity_subject
    let globalUserId = null;
    const [[existingUser]] = await pool.query(
      'SELECT id FROM iam_users WHERE identity_subject = ? LIMIT 1',
      [identity_subject]
    );

    if (existingUser) {
      globalUserId = existingUser.id;
    } else {
      // 3. Buat Global User baru
      const userId  = uuidv4();
      const emailId = uuidv4();

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.query(
          `INSERT INTO iam_users (id, identity_subject, display_name, status)
           VALUES (?, ?, ?, 'active')`,
          [userId, identity_subject, String(display_name || '').trim() || 'User']
        );

        if (email) {
          await conn.query(
            `INSERT INTO iam_user_emails (id, user_id, email, is_primary, is_verified)
             VALUES (?, ?, ?, 1, 1)`,
            [emailId, userId, String(email).trim().toLowerCase()]
          );
        }

        await conn.commit();
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }

      globalUserId = userId;
    }

    // 4. Buat iam_legacy_account_links
    const linkId = uuidv4();
    await pool.query(
      `INSERT INTO iam_legacy_account_links
         (id, user_id, source_system, legacy_user_id, legacy_tenant_id, migration_status)
       VALUES (?, ?, ?, ?, ?, 'linked')`,
      [linkId, globalUserId, source_system, String(legacy_user_id), legacy_tenant_id]
    );

    // 5. Pastikan user jadi member di org yang sesuai dengan tenant
    // Resolve org by legacy_tenant_id (slug)
    const [[org]] = await pool.query(
      "SELECT id FROM iam_organizations WHERE slug = ? AND status = 'active' LIMIT 1",
      [legacy_tenant_id]
    );

    if (org) {
      // Cek sudah member atau belum
      const [[alreadyMember]] = await pool.query(
        "SELECT id FROM iam_organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1",
        [org.id, globalUserId]
      );

      if (!alreadyMember) {
        const membershipId = uuidv4();
        const mrId         = uuidv4();

        const conn2 = await pool.getConnection();
        try {
          await conn2.beginTransaction();

          await conn2.query(
            `INSERT INTO iam_organization_members (id, organization_id, user_id, status)
             VALUES (?, ?, ?, 'active')`,
            [membershipId, org.id, globalUserId]
          );

          // Map CRM role lama → IAM role
          const crmRoleMap = {
            'Admin':     'CRM_ADMIN',
            'Manager':   'CRM_MANAGER',
            'Chief CRO': 'CRM_CHIEF_CRO',
            'CRO':       'CRM_CRO',
          };
          const iamRoleCode = crmRoleMap[legacy_role] || 'CRM_CRO';

          const [[iamRole]] = await conn2.query(
            'SELECT id FROM iam_roles WHERE code = ? LIMIT 1',
            [iamRoleCode]
          );

          const [[crmApp]] = await conn2.query(
            "SELECT id FROM iam_applications WHERE code = 'NEXAMOS_CRM' LIMIT 1"
          );

          if (iamRole && crmApp) {
            await conn2.query(
              `INSERT INTO iam_membership_roles (id, membership_id, role_id, application_id)
               VALUES (?, ?, ?, ?)`,
              [mrId, membershipId, iamRole.id, crmApp.id]
            );
          }

          await conn2.commit();
        } catch (txErr2) {
          await conn2.rollback();
          throw txErr2;
        } finally {
          conn2.release();
        }
      }
    }

    await auditLog({
      eventType:  'LEGACY_ACCOUNT_LINKED',
      actorId:    globalUserId,
      targetType: 'user',
      targetId:   globalUserId,
      payload:    { source_system, legacy_user_id, legacy_tenant_id, legacy_role },
      req,
    });

    res.status(201).json({
      status: 'ok',
      message: 'Legacy account linked.',
      data: {
        global_user_id:   globalUserId,
        migration_status: 'linked',
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * GET /api/v1/legacy/resolve?subject=<keycloak_sub>
 * Resolve Global User ID dari Keycloak subject — dipakai CRM saat login.
 */
async function resolveBySubject(req, res) {
  try {
    const pool    = getPool();
    const subject = req.query.subject;

    if (!subject) return res.status(400).json({ status: 'error', message: 'subject query param required.' });

    const [[user]] = await pool.query(
      `SELECT u.id, u.display_name, u.status,
              e.email, e.is_verified AS email_verified
       FROM iam_users u
       LEFT JOIN iam_user_emails e ON e.user_id = u.id AND e.is_primary = 1
       WHERE u.identity_subject = ?
       LIMIT 1`,
      [subject]
    );

    if (!user) {
      return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'User not found.' });
    }

    res.json({ status: 'ok', data: user });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = { linkLegacyAccount, resolveBySubject };

