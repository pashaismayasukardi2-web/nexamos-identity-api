#!/bin/bash
# =============================================================
# NexaMOS Identity & Access Platform
# Keycloak Setup Script — VPS (Ubuntu/Debian)
# Jalankan sebagai root atau dengan sudo
# =============================================================
# 
# CARA PAKAI:
#   chmod +x setup-keycloak.sh
#   sudo ./setup-keycloak.sh
#
# =============================================================

set -e

KC_VERSION="24.0.3"
KC_HOME="/opt/keycloak"
KC_SERVICE="keycloak"
KC_PORT="8180"          # Port internal (nginx akan proxy ke :443)
KC_ADMIN_USER="admin"
KC_ADMIN_PASS=""        # ISI ini sebelum jalankan!
KC_DB_URL="jdbc:mysql://srv1412.hstgr.io:3306/u294320793_nexamain"
KC_DB_USER=""           # ISI: DB user Hostinger
KC_DB_PASS=""           # ISI: DB password Hostinger
KC_HOSTNAME="identity.nexamos.cloud"

echo "============================================"
echo " NexaMOS Keycloak Setup — v${KC_VERSION}"
echo "============================================"

if [ -z "$KC_ADMIN_PASS" ] || [ -z "$KC_DB_USER" ] || [ -z "$KC_DB_PASS" ]; then
  echo "❌ ERROR: Set KC_ADMIN_PASS, KC_DB_USER, dan KC_DB_PASS di dalam script ini terlebih dahulu!"
  exit 1
fi

# ── 1. Install Java 21 ────────────────────────────────────────
echo "[1/6] Installing Java 21..."
apt-get update -q
apt-get install -y -q openjdk-21-jre-headless
java -version

# ── 2. Download & Extract Keycloak ───────────────────────────
echo "[2/6] Downloading Keycloak ${KC_VERSION}..."
mkdir -p ${KC_HOME}
wget -q -O /tmp/keycloak.tar.gz \
  "https://github.com/keycloak/keycloak/releases/download/${KC_VERSION}/keycloak-${KC_VERSION}.tar.gz"
tar -xzf /tmp/keycloak.tar.gz -C ${KC_HOME} --strip-components=1
rm /tmp/keycloak.tar.gz
echo "✅ Keycloak extracted to ${KC_HOME}"

# ── 3. Download MySQL JDBC Driver ─────────────────────────────
echo "[3/6] Downloading MySQL JDBC driver..."
wget -q -O /tmp/mysql-connector.tar.gz \
  "https://dev.mysql.com/get/Downloads/Connector-J/mysql-connector-j-8.3.0.tar.gz"
tar -xzf /tmp/mysql-connector.tar.gz -C /tmp/
cp /tmp/mysql-connector-j-8.3.0/mysql-connector-j-8.3.0.jar \
   ${KC_HOME}/providers/mysql-connector-j.jar
rm -rf /tmp/mysql-connector*
echo "✅ MySQL JDBC driver installed"

# ── 4. Configure Keycloak ─────────────────────────────────────
echo "[4/6] Configuring Keycloak..."
cat > ${KC_HOME}/conf/keycloak.conf << EOF
# Database
db=mysql
db-url=${KC_DB_URL}
db-username=${KC_DB_USER}
db-password=${KC_DB_PASS}

# Hostname
hostname=${KC_HOSTNAME}
hostname-strict=true
hostname-strict-https=true
http-enabled=true
http-port=${KC_PORT}

# Proxy
proxy=edge

# Logging
log=console
log-level=INFO
EOF
echo "✅ keycloak.conf written"

# ── 5. Build Keycloak (dengan MySQL provider) ─────────────────
echo "[5/6] Building Keycloak..."
${KC_HOME}/bin/kc.sh build --db=mysql

# ── 6. Create Systemd Service ─────────────────────────────────
echo "[6/6] Creating systemd service..."
cat > /etc/systemd/system/${KC_SERVICE}.service << EOF
[Unit]
Description=NexaMOS Keycloak Identity Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${KC_HOME}
ExecStart=${KC_HOME}/bin/kc.sh start \
  --optimized \
  --http-port=${KC_PORT}
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
Environment="KEYCLOAK_ADMIN=${KC_ADMIN_USER}"
Environment="KEYCLOAK_ADMIN_PASSWORD=${KC_ADMIN_PASS}"

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${KC_SERVICE}
systemctl start  ${KC_SERVICE}
echo "✅ Keycloak service started"

echo ""
echo "============================================"
echo " ✅ Keycloak Setup Selesai!"
echo "    Internal URL : http://localhost:${KC_PORT}"
echo "    Admin Console: https://${KC_HOSTNAME}/admin"
echo "    Realm Config : Lihat README-keycloak-realm.md"
echo "============================================"
echo ""
echo "NEXT STEPS:"
echo "  1. Tambahkan nginx config untuk proxy ${KC_HOSTNAME} → localhost:${KC_PORT}"
echo "  2. Issue SSL cert: certbot --nginx -d ${KC_HOSTNAME}"
echo "  3. Login ke admin console dan buat realm 'nexamos'"
echo "  4. Import realm config dari nexamos-realm-export.json"

