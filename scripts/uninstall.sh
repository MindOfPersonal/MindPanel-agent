#!/usr/bin/env bash
#
# Remove the MindPanel agent, its service and its local state.
# The agent's credential is not revoked automatically: revoke it in
# MindPanel > Agent Management before or after removing the agent.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

systemctl disable --now mindpanel-agent 2>/dev/null || true
rm -f /etc/systemd/system/mindpanel-agent.service
systemctl daemon-reload

rm -rf /opt/mindpanel-agent /etc/mindpanel-agent /var/lib/mindpanel-agent

if id mindpanel-agent >/dev/null 2>&1; then
  userdel mindpanel-agent 2>/dev/null || true
fi

echo "MindPanel agent removed. Revoke its credential in MindPanel if you have not done so."
