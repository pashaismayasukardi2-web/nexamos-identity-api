# nexamos-identity-api

**NexaMOS Identity & Access Platform — Business IAM API**

API ini mengelola identitas global user, organisasi, keanggotaan, dan entitlement produk NexaMOS.
Autentikasi menggunakan OIDC token dari **Keycloak** (`identity.nexamos.cloud`).

---

## Stack
- **Runtime:** Node.js 18+, Express.js
- **Database:** MySQL (Hostinger `u294320793_nexamain`)
- **Auth Engine:** Keycloak 24 (OIDC / JWT RS256)
- **Deploy:** VPS `103.190.0.23`, port `4000` (internal)

---

## Struktur Project

```
nexamos-identity-api/
├── src/
│   ├── app.js                          ← Entry point Express
│   ├── config/
│   │   └── database.js                 ← MySQL pool (IAM DB)
│   ├── middleware/
│   │   └── requireOIDC.js              ← OIDC token verifier + audit logger
│   └── modules/
│       ├── users/                      ← GET /users, PATCH /users, /users/products
│       ├── organizations/              ← CRUD org + member management
│       ├── entitlements/               ← Product entitlement management
│       └── legacy/                     ← CRM legacy account linking
├── db/
│   ├── migrate.js                      ← Migration runner
│   ├── migrations/
│   │   └── 001_create_iam_schema.sql   ← 11 tabel iam_*
│   └── seeds/
│       └── 001_seed_master_data.sql    ← Applications + Roles + Permissions
├── nginx-identity.conf                 ← Nginx config untuk VPS
├── setup-keycloak.sh                   ← Script instalasi Keycloak
├── .env.example
└── package.json
```

---

## Setup Lokal / Development

```bash
# 1. Clone dan install
npm install

# 2. Salin .env
cp .env.example .env
# Edit .env dengan credentials asli

# 3. Jalankan migration (sekali saja)
node db/migrate.js --seed

# 4. Jalankan dev server
npm run dev
```

---

## Deploy ke VPS

### Step 1 — Upload project ke VPS

```bash
# Di local
scp -P 4775 -r nexamos-identity-api/ dsmdsm@103.190.0.23:/var/www/

# Di VPS
cd /var/www/nexamos-identity-api
npm install --production
cp .env.example .env
# Edit .env dengan credentials production
```

### Step 2 — Setup PM2

```bash
# Install PM2 jika belum ada
npm install -g pm2

# Start Identity API
pm2 start src/app.js --name nexamos-identity-api

# Simpan konfigurasi PM2
pm2 save
pm2 startup
```

### Step 3 — Install & Konfigurasi Keycloak

```bash
# Di VPS, jalankan setup script
chmod +x setup-keycloak.sh

# WAJIB isi dulu variabel ini di dalam setup-keycloak.sh:
# KC_ADMIN_PASS=...
# KC_DB_USER=u294320793_adminmain
# KC_DB_PASS=...

sudo ./setup-keycloak.sh
```

### Step 4 — Nginx & SSL

```bash
# Copy nginx config
sudo cp nginx-identity.conf /etc/nginx/sites-available/identity.nexamos.cloud
sudo ln -s /etc/nginx/sites-available/identity.nexamos.cloud \
           /etc/nginx/sites-enabled/

# Test dan reload nginx
sudo nginx -t
sudo systemctl reload nginx

# Issue SSL certificate
sudo certbot --nginx -d identity.nexamos.cloud
```

### Step 5 — Konfigurasi Realm Keycloak

Setelah Keycloak berjalan di `https://identity.nexamos.cloud/admin`:

1. Login dengan `admin` / `KC_ADMIN_PASS`
2. Buat Realm baru: `nexamos`
3. Buat OIDC Clients:

| Client ID | Root URL | Valid Redirect URIs |
|---|---|---|
| `nexamos-crm` | `https://crm.nexamos.cloud` | `https://crm.nexamos.cloud/*` |
| `nexamos-web-studio` | `https://studio.nexamos.cloud` | `https://studio.nexamos.cloud/*` |
| `nexamos-workspace` | `https://workspace.nexamos.cloud` | `https://workspace.nexamos.cloud/*` |
| `nexamos-admin` | `https://superadmin.nexamos.cloud` | `https://superadmin.nexamos.cloud/*` |

4. Aktifkan: `Standard flow` + `PKCE` pada setiap client
5. Buat Realm Role: `superadmin`
6. Set realm token settings: Access Token = 15 menit, Refresh Token = 30 hari

---

## API Endpoints

Base URL: `https://identity.nexamos.cloud/api/v1`

### Users
| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/users` | OIDC | Profil user saat ini |
| PATCH | `/users` | OIDC | Update display_name |
| GET | `/users/organizations` | OIDC | Daftar organisasi user |
| GET | `/users/products` | OIDC | Produk yang bisa diakses |
| POST | `/users/provision` | Internal | Provisioning user baru setelah register Keycloak |
| PATCH | `/users/:userId/status` | Superadmin | Suspend / aktifkan user |

### Organizations
| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/organizations` | OIDC | Buat organisasi |
| GET | `/organizations/:id` | OIDC (member) | Detail organisasi |
| PATCH | `/organizations/:id` | OIDC (ORG_OWNER/ADMIN) | Update organisasi |
| GET | `/organizations/:id/members` | OIDC (member) | Daftar member |
| PATCH | `/organizations/:id/members/:userId` | OIDC (ORG_OWNER/ADMIN) | Update status member |

### Entitlements
| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/organizations/:id/entitlements` | OIDC (member) | Daftar entitlement |
| POST | `/organizations/:id/entitlements` | Superadmin | Grant entitlement |
| GET | `/organizations/:id/applications` | OIDC (member) | Aplikasi yang bisa diakses |
| PATCH | `/entitlements/:id` | Superadmin | Update entitlement |

### Legacy (Internal — server-to-server)
| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/legacy/link` | Internal | Link akun CRM lama ke Global User ID |
| GET | `/legacy/resolve?subject=` | Internal | Resolve Global User dari Keycloak sub |

---

## Status Phase

- [x] **Phase 0** — Technical Discovery ✅
- [x] **Phase 1** — Identity Foundation ✅
  - [x] MySQL IAM Schema (11 tabel)
  - [x] Seed data (4 apps, 8 roles, 12 permissions)
  - [x] Identity API (users, organizations, entitlements, legacy)
  - [ ] Deploy Keycloak ke VPS (manual step — lihat setup-keycloak.sh)
  - [ ] Nginx + SSL setup (manual step — lihat nginx-identity.conf)
  - [ ] PM2 deploy
- [ ] **Phase 2** — Web Studio Integration
- [ ] **Phase 3** — Unified Workspace
- [ ] **Phase 4** — CRM Integration
- [ ] **Phase 5** — Corporate Website
- [ ] **Phase 6** — Hardening

