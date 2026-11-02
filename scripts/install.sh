#!/usr/bin/env bash
#
# Install the MindPanel agent from this checkout on a Linux host.
#
# Usage:
#   sudo MINDPANEL_URL=https://panel.example.com \
#        REGISTRATION_CODE=mpreg_... \
#        ./scripts/install.sh
#
# The registration code is written to /etc/mindpanel-agent/agent.env for the
# first start only. Remove it after the agent has registered successfully.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/mindpanel-agent"
CONFIG_DIR="/etc/mindpanel-agent"
STATE_DIR="/var/lib/mindpanel-agent"
SERVICE_FILE="/etc/systemd/system/mindpanel-agent.service"
AGENT_USER="mindpanel-agent"

if [[ -z "${MINDPANEL_URL:-}" ]]; then
  echo "MINDPANEL_URL is required, for example https://panel.example.com" >&2
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/node_modules/zod" ]]; then
  echo "node_modules/zod not found. Run 'npm install' in ${ROOT_DIR} first." >&2
  exit 1
fi

echo "Building agent..."
cd "${ROOT_DIR}"
npm run build

if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${STATE_DIR}" --shell /usr/sbin/nologin "${AGENT_USER}"
fi

install -d -m 0755 "${INSTALL_DIR}" "${INSTALL_DIR}/node_modules"
install -d -m 0700 -o "${AGENT_USER}" -g "${AGENT_USER}" "${STATE_DIR}"
install -d -m 0750 "${CONFIG_DIR}"

rm -rf "${INSTALL_DIR}/dist" "${INSTALL_DIR}/node_modules/zod"
cp -a "${ROOT_DIR}/dist" "${INSTALL_DIR}/dist"
cp -a "${ROOT_DIR}/node_modules/zod" "${INSTALL_DIR}/node_modules/zod"

cat > "${INSTALL_DIR}/package.json" <<'JSON'
{
  "name": "mindpanel-agent-install",
  "private": true,
  "type": "module"
}
JSON

ENV_FILE="${CONFIG_DIR}/agent.env"
umask 077
cat > "${ENV_FILE}" <<EOF
MINDPANEL_URL=${MINDPANEL_URL}
AGENT_STATE_FILE=${STATE_DIR}/state.json
LOG_LEVEL=info
EOF
if [[ -n "${REGISTRATION_CODE:-}" ]]; then
  cat >> "${ENV_FILE}" <<EOF
REGISTRATION_CODE=${REGISTRATION_CODE}
EOF
fi
chmod 600 "${ENV_FILE}"
chown root:root "${ENV_FILE}"

install -m 0644 "${ROOT_DIR}/deploy/mindpanel-agent.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable --now mindpanel-agent

cat <<EOF

MindPanel agent installed.

  Service:  systemctl status mindpanel-agent
  Logs:     journalctl -u mindpanel-agent -f
  Config:   ${ENV_FILE}
  State:    ${STATE_DIR}/state.json

After the first successful registration, remove REGISTRATION_CODE from
${ENV_FILE} and run:
  systemctl restart mindpanel-agent

Uninstall:
  ${ROOT_DIR}/scripts/uninstall.sh
EOF
