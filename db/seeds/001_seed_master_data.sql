-- =============================================================
-- NexaMOS Identity & Access Platform
-- Seed: 001 — Master Data
-- Jalankan setelah migration 001 selesai.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- Product Registry (iam_applications)
-- ─────────────────────────────────────────────────────────────
INSERT INTO `iam_applications` (`id`, `code`, `name`, `domain`, `status`) VALUES
  (UUID(), 'NEXAMOS_CRM',       'NexaMOS CRM',       'crm.nexamos.cloud',         'active'),
  (UUID(), 'NEXAMOS_WEB_STUDIO','NexaMOS Web Studio', 'studio.nexamos.cloud',      'beta'),
  (UUID(), 'NEXAMOS_WORKSPACE', 'NexaMOS Workspace',  'workspace.nexamos.cloud',   'active'),
  (UUID(), 'NEXAMOS_ADMIN',     'NexaMOS Admin',      'superadmin.nexamos.cloud',  'active');

-- ─────────────────────────────────────────────────────────────
-- Roles
-- ─────────────────────────────────────────────────────────────
INSERT INTO `iam_roles` (`id`, `code`, `name`, `scope`) VALUES
  (UUID(), 'SUPERADMIN',  'Super Admin',          'platform'),
  (UUID(), 'ORG_OWNER',   'Organization Owner',   'organization'),
  (UUID(), 'ORG_ADMIN',   'Organization Admin',   'organization'),
  (UUID(), 'ORG_MEMBER',  'Organization Member',  'organization'),
  -- CRM-specific roles (scope = application, diisi saat membership_role dibuat)
  (UUID(), 'CRM_ADMIN',      'CRM Admin',      'application'),
  (UUID(), 'CRM_MANAGER',    'CRM Manager',    'application'),
  (UUID(), 'CRM_CHIEF_CRO',  'CRM Chief CRO',  'application'),
  (UUID(), 'CRM_CRO',        'CRM CRO',        'application');

-- ─────────────────────────────────────────────────────────────
-- Permissions (contoh awal — dapat diperluas)
-- ─────────────────────────────────────────────────────────────
INSERT INTO `iam_permissions` (`id`, `code`, `description`) VALUES
  (UUID(), 'users:read',               'Melihat data user'),
  (UUID(), 'users:write',              'Mengubah data user'),
  (UUID(), 'organizations:read',       'Melihat data organisasi'),
  (UUID(), 'organizations:write',      'Mengubah data organisasi'),
  (UUID(), 'organizations:delete',     'Menghapus organisasi'),
  (UUID(), 'members:invite',           'Mengundang member ke organisasi'),
  (UUID(), 'members:remove',           'Menghapus member dari organisasi'),
  (UUID(), 'entitlements:read',        'Melihat entitlement produk'),
  (UUID(), 'entitlements:grant',       'Memberikan akses produk'),
  (UUID(), 'entitlements:revoke',      'Mencabut akses produk'),
  (UUID(), 'audit:read',               'Membaca audit log'),
  (UUID(), 'platform:superadmin',      'Akses penuh seluruh platform');

-- =============================================================
-- SELESAI — Seed 001
-- =============================================================

