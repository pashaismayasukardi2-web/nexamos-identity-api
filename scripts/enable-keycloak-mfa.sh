#!/usr/bin/env bash
# ==============================================================================
# NexaMOS Identity & Access Platform — Phase 6 MFA (TOTP) Enabler for Keycloak
# Mengaktifkan TOTP (Google Authenticator / FreeOTP) dan Brute-Force Protection
# pada realm `nexamos` via Keycloak Admin REST API.
# ==============================================================================

set -euo pipefail

KC_BASE_URL="${KC_BASE_URL:-http://127.0.0.1:8180/identity}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-NexaMOS_KC_Admin_2026!}"
REALM="nexamos"

echo "🔐 [Phase 6 Hardening] Mengonfigurasi MFA TOTP & Brute-Force Protection di Keycloak Realm '${REALM}'..."

python3 - <<PYEOF
import json, urllib.request, urllib.parse

TOKEN_URL = "${KC_BASE_URL}/realms/master/protocol/openid-connect/token"
REALM_URL = "${KC_BASE_URL}/admin/realms/${REALM}"
REQ_ACTIONS_URL = "${KC_BASE_URL}/admin/realms/${REALM}/authentication/required-actions"

data = urllib.parse.urlencode({
    "client_id": "admin-cli",
    "username": "${KC_ADMIN_USER}",
    "password": "${KC_ADMIN_PASS}",
    "grant_type": "password"
}).encode()

tok = json.loads(urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data)).read())["access_token"]
headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}

# 1. Update Realm OTP Policy (TOTP 6-digit, SHA1, 30s period, Google Authenticator compatible) + Brute Force Detection
realm_payload = {
    "otpPolicyType": "totp",
    "otpPolicyAlgorithm": "HmacSHA1",
    "otpPolicyInitialCounter": 0,
    "otpPolicyDigits": 6,
    "otpPolicyLookAheadWindow": 1,
    "otpPolicyPeriod": 30,
    "otpSupportedApplications": ["totpAppGoogleName", "totpAppFreeOTPName", "totpAppMicrosoftAuthenticatorName"],
    "bruteForceProtected": True,
    "permanentLockout": False,
    "maxFailureWaitSeconds": 900,
    "minimumQuickLoginWaitSeconds": 60,
    "waitIncrementSeconds": 60,
    "quickLoginCheckMilliSeconds": 1000,
    "maxDeltaTimeSeconds": 43200,
    "failureFactor": 5
}

req_realm = urllib.request.Request(
    REALM_URL,
    data=json.dumps(realm_payload).encode(),
    headers=headers,
    method="PUT"
)
urllib.request.urlopen(req_realm)
print("✅ Realm OTP Policy (TOTP 6-digit Google Authenticator) & Brute-Force Protection aktif!")

# 2. Pastikan Required Action CONFIGURE_TOTP dan VERIFY_EMAIL berstatus enabled
actions = json.loads(urllib.request.urlopen(urllib.request.Request(REQ_ACTIONS_URL, headers=headers)).read())
for act in actions:
    alias = act.get("alias")
    if alias in ("CONFIGURE_TOTP", "VERIFY_EMAIL"):
        act["enabled"] = True
        act_url = f"{REQ_ACTIONS_URL}/{alias}"
        urllib.request.urlopen(urllib.request.Request(act_url, data=json.dumps(act).encode(), headers=headers, method="PUT"))
        print(f"✅ Required Action '{alias}' enabled!")
PYEOF

echo "🎉 Konfigurasi MFA TOTP Keycloak selesai!"
