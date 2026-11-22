#!/usr/bin/env bash
# ==============================================================================
# NexaMOS Identity & Access Platform — Phase 6 Uptime & Error Rate Monitor
# Memantau kesehatan Keycloak (port 8180) dan Identity API (port 4000).
# Jika terdeteksi down atau error rate > threshold, otomatis mencatat alert
# dan me-restart service terkait (self-healing).
# ==============================================================================

set -u

IDENTITY_HEALTH_URL="${IDENTITY_HEALTH_URL:-http://127.0.0.1:4000/health}"
KEYCLOAK_REALM_URL="${KEYCLOAK_REALM_URL:-http://127.0.0.1:8180/identity/realms/nexamos}"
LOG_FILE="${LOG_FILE:-/var/log/nexamos-iam-monitor.log}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
  echo "[$(timestamp)] [INFO] $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "[$(timestamp)] [INFO] $*"
}

log_alert() {
  echo "[$(timestamp)] [ALERT] 🚨 $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "[$(timestamp)] [ALERT] 🚨 $*"
}

# 1. Cek Uptime Keycloak
KC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$KEYCLOAK_REALM_URL" || echo "000")
if [ "$KC_STATUS" != "200" ]; then
  log_alert "Keycloak DOWN or unreachable (HTTP $KC_STATUS at $KEYCLOAK_REALM_URL)! Attempting self-heal restart..."
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart keycloak.service || true
  fi
else
  log_info "Keycloak realm 'nexamos' healthy (HTTP 200)."
fi

# 2. Cek Uptime & Error Rate Identity API
API_BODY=$(curl -s --max-time 5 "$IDENTITY_HEALTH_URL" || echo "")
if [ -z "$API_BODY" ]; then
  log_alert "NexaMOS Identity API DOWN at $IDENTITY_HEALTH_URL! Attempting PM2 restart..."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart nexamos-identity-api || true
  fi
  exit 1
fi

ALERT_FIRING=$(echo "$API_BODY" | grep -o '"alert_firing":true' || true)
if [ -n "$ALERT_FIRING" ]; then
  log_alert "Identity API 5xx Error Rate exceeded threshold! Payload: $API_BODY"
else
  log_info "Identity API healthy: $API_BODY"
fi
