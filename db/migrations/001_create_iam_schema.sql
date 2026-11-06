-- =============================================================
-- NexaMOS Identity & Access Platform
-- Migration: 001 — IAM Schema (MySQL)
-- Database: u294320793_nexamain
-- Semua tabel menggunakan prefix `iam_` untuk isolasi dari
-- tabel operasional CRM existing.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. iam_users — Global User Identity
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_users` (
  `id`                CHAR(36)      NOT NULL,                      -- UUID v4
  `identity_subject`  VARCHAR(255)  NOT NULL,                      -- Keycloak 'sub'
  `display_name`      VARCHAR(150)  NOT NULL DEFAULT '',
  `status`            ENUM('active','suspended','pending','deleted')
                                    NOT NULL DEFAULT 'pending',
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_users_subject` (`identity_subject`),
  INDEX `idx_iam_users_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 2. iam_user_emails
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_user_emails` (
  `id`           CHAR(36)     NOT NULL,
  `user_id`      CHAR(36)     NOT NULL,
  `email`        VARCHAR(255) NOT NULL,
  `is_primary`   TINYINT(1)   NOT NULL DEFAULT 0,
  `is_verified`  TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_emails_email` (`email`),
  INDEX `idx_iam_emails_user_id` (`user_id`),
  INDEX `idx_iam_emails_primary` (`user_id`, `is_primary`),
  CONSTRAINT `fk_iam_emails_user`
    FOREIGN KEY (`user_id`) REFERENCES `iam_users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 3. iam_organizations
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_organizations` (
  `id`                 CHAR(36)     NOT NULL,
  `name`               VARCHAR(150) NOT NULL,
  `slug`               VARCHAR(100) NOT NULL,
  `organization_type`  ENUM('personal','business','company')
                                    NOT NULL DEFAULT 'business',
  `status`             ENUM('active','suspended','deleted')
                                    NOT NULL DEFAULT 'active',
  `created_by`         CHAR(36)     NOT NULL,
  `created_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_orgs_slug` (`slug`),
  INDEX `idx_iam_orgs_created_by` (`created_by`),
  INDEX `idx_iam_orgs_status` (`status`),
  CONSTRAINT `fk_iam_orgs_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `iam_users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 4. iam_organization_members
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_organization_members` (
  `id`               CHAR(36) NOT NULL,
  `organization_id`  CHAR(36) NOT NULL,
  `user_id`          CHAR(36) NOT NULL,
  `status`           ENUM('active','invited','suspended','removed')
                               NOT NULL DEFAULT 'active',
  `joined_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_members_org_user` (`organization_id`, `user_id`),
  INDEX `idx_iam_members_user_id` (`user_id`),
  CONSTRAINT `fk_iam_members_org`
    FOREIGN KEY (`organization_id`) REFERENCES `iam_organizations`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_iam_members_user`
    FOREIGN KEY (`user_id`) REFERENCES `iam_users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 5. iam_applications — Product Registry
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_applications` (
  `id`          CHAR(36)     NOT NULL,
  `code`        VARCHAR(50)  NOT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `domain`      VARCHAR(255) NOT NULL DEFAULT '',
  `status`      ENUM('active','inactive','beta')
                             NOT NULL DEFAULT 'active',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_apps_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 6. iam_product_entitlements
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_product_entitlements` (
  `id`               CHAR(36)     NOT NULL,
  `organization_id`  CHAR(36)     DEFAULT NULL,
  `user_id`          CHAR(36)     DEFAULT NULL,
  `application_id`   CHAR(36)     NOT NULL,
  `status`           ENUM('active','inactive','expired','revoked')
                                  NOT NULL DEFAULT 'inactive',
  `plan_code`        VARCHAR(50)  DEFAULT NULL,  -- FREE / PRO / BUSINESS / ENTERPRISE
  `valid_from`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `valid_until`      DATETIME     DEFAULT NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_iam_ent_org`  (`organization_id`, `application_id`),
  INDEX `idx_iam_ent_user` (`user_id`, `application_id`),
  INDEX `idx_iam_ent_status` (`status`),
  -- Setidaknya salah satu dari org atau user harus diisi (enforced di application layer)
  CONSTRAINT `fk_iam_ent_org`
    FOREIGN KEY (`organization_id`) REFERENCES `iam_organizations`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_iam_ent_user`
    FOREIGN KEY (`user_id`) REFERENCES `iam_users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_iam_ent_app`
    FOREIGN KEY (`application_id`) REFERENCES `iam_applications`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 7. iam_roles
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_roles` (
  `id`     CHAR(36)    NOT NULL,
  `code`   VARCHAR(50) NOT NULL,
  `name`   VARCHAR(100) NOT NULL,
  `scope`  ENUM('platform','organization','application')
                       NOT NULL DEFAULT 'organization',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_roles_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 8. iam_permissions
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_permissions` (
  `id`           CHAR(36) NOT NULL,
  `code`         VARCHAR(100) NOT NULL,
  `description`  TEXT DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_perm_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 9. iam_membership_roles — Role seorang member di dalam org/app
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_membership_roles` (
  `id`             CHAR(36) NOT NULL,
  `membership_id`  CHAR(36) NOT NULL,
  `role_id`        CHAR(36) NOT NULL,
  `application_id` CHAR(36) DEFAULT NULL,  -- NULL = berlaku untuk seluruh org
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_mbrole_unique` (`membership_id`, `role_id`, `application_id`),
  CONSTRAINT `fk_iam_mbrole_member`
    FOREIGN KEY (`membership_id`) REFERENCES `iam_organization_members`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_iam_mbrole_role`
    FOREIGN KEY (`role_id`) REFERENCES `iam_roles`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_iam_mbrole_app`
    FOREIGN KEY (`application_id`) REFERENCES `iam_applications`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 10. iam_legacy_account_links — Mapping user lama CRM → Global ID
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_legacy_account_links` (
  `id`               CHAR(36)     NOT NULL,
  `user_id`          CHAR(36)     NOT NULL,
  `source_system`    VARCHAR(50)  NOT NULL,  -- misal: 'NEXAMOS_CRM'
  `legacy_user_id`   VARCHAR(50)  NOT NULL,  -- ID integer dari tabel users tenant
  `legacy_tenant_id` VARCHAR(50)  DEFAULT NULL,
  `migration_status` ENUM('pending','linked','migrated','failed')
                                  NOT NULL DEFAULT 'pending',
  `linked_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iam_legacy_source_user` (`source_system`, `legacy_user_id`, `legacy_tenant_id`),
  INDEX `idx_iam_legacy_user_id` (`user_id`),
  CONSTRAINT `fk_iam_legacy_user`
    FOREIGN KEY (`user_id`) REFERENCES `iam_users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 11. iam_audit_events — Immutable Audit Log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `iam_audit_events` (
  `id`           CHAR(36)     NOT NULL,
  `event_type`   VARCHAR(100) NOT NULL,
  `actor_id`     CHAR(36)     DEFAULT NULL,  -- user yang melakukan aksi (nullable: system events)
  `target_type`  VARCHAR(50)  DEFAULT NULL,  -- 'user' | 'organization' | 'entitlement' | ...
  `target_id`    VARCHAR(100) DEFAULT NULL,
  `payload`      JSON         DEFAULT NULL,
  `ip_address`   VARCHAR(50)  DEFAULT NULL,
  `user_agent`   TEXT         DEFAULT NULL,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_iam_audit_actor`  (`actor_id`),
  INDEX `idx_iam_audit_type`   (`event_type`),
  INDEX `idx_iam_audit_target` (`target_type`, `target_id`),
  INDEX `idx_iam_audit_time`   (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
-- SELESAI — Migration 001
-- =============================================================

