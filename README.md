# MindPanel agent

The MindPanel agent is a standalone, outbound-only collector for Linux servers. It registers with a
MindPanel installation using a one-time code, stores its own credential, and then sends heartbeats
and metrics. It never opens an inbound port and never discovers other machines.

This repository contains only the agent. It has no dependency on the MindPanel web application or
server internals; the wire protocol is vendored in [`src/protocol.ts`](src/protocol.ts).

## Requirements

- Linux (Windows support is a later phase)
- Node.js 22.12 or newer
- Read access to `/proc`, `/sys/class/net` and `/etc/os-release`
- Outbound HTTPS access to the MindPanel URL

The agent runs as an unprivileged system user in the supplied systemd unit. It does not need root.

## Install from source

```bash
git clone https://github.com/MindOfPersonal/MindPanel-agent.git
cd MindPanel-agent
npm install
```

## Register a server

1. In MindPanel, open **Servers → Add server**.
2. Copy the one-time registration code shown after creating the server.
3. Install and start the agent with that code:

```bash
sudo MINDPANEL_URL=https://panel.example.com \
     REGISTRATION_CODE=mpreg_... \
     ./scripts/install.sh
```

The agent registers once, writes its credential to `/var/lib/mindpanel-agent/state.json` (mode
`0600`) and starts reporting. The registration code is single-use and expires after the configured
TTL. Remove `REGISTRATION_CODE` from `/etc/mindpanel-agent/agent.env` after the first successful
registration.

The server appears in MindPanel as **Connecting** after registration and as **Online** only after
the first verified heartbeat. If heartbeats stop, MindPanel marks it **Offline** after the
configured timeout. A revoked credential is rejected immediately.

## Configuration

Configuration is read from environment variables, optionally seeded by a JSON file named by
`AGENT_CONFIG_FILE`. Environment variables take precedence.

| Variable                     | Default                        | Description                                  |
| ---------------------------- | ------------------------------ | -------------------------------------------- |
| `MINDPANEL_URL`              | — (required)                   | Base URL of the MindPanel installation       |
| `REGISTRATION_CODE`          | —                              | One-time code, only needed for first pairing |
| `AGENT_STATE_FILE`           | `./mindpanel-agent-state.json` | Credential/state file, mode `0600`           |
| `HEARTBEAT_INTERVAL_SECONDS` | `15`                           | Configured heartbeat interval                |
| `STATS_INTERVAL_SECONDS`     | `5`                            | Configured metrics interval                  |
| `REQUEST_TIMEOUT_SECONDS`    | `15`                           | HTTP timeout                                 |
| `LOG_LEVEL`                  | `info`                         | `debug`, `info`, `warn` or `error`           |

After registration the intervals advertised by MindPanel are stored in the state file and used on
later starts. See [`config.example.json`](config.example.json) for a file-based example.

## Manual run

```bash
npm install
npm run build

MINDPANEL_URL=https://panel.example.com \
REGISTRATION_CODE=mpreg_... \
AGENT_STATE_FILE=/tmp/mindpanel-agent-state.json \
node dist/index.js
```

## Development

```bash
npm run dev          # run from source with tsx watch
npm run typecheck
npm run test
npm run lint
npm run format:check
```

## Collected data

- CPU usage (aggregate)
- Memory and swap usage
- Load average
- Uptime
- Disk usage per real mountpoint
- Disk I/O per physical disk (read and write rate, plus cumulative counters)
- Network interfaces, addresses, totals and rates
- System information (hostname, OS, kernel, architecture, CPU model/cores, total memory, timezone)
- Top processes by CPU and memory (PID, name, user, CPU, memory, state, start time, command line
  where readable)

Unsupported or unreadable values are omitted; the agent never invents metrics. Metrics are sent
with a protocol version and timestamp, and MindPanel rejects stale, duplicate or malformed
messages.

## Updating

The agent does not update itself. On the monitored host:

```bash
cd /path/to/MindPanel-agent
git pull
npm install
sudo MINDPANEL_URL=https://panel.example.com ./scripts/install.sh
```

`install.sh` rebuilds the agent, replaces `/opt/mindpanel-agent` and restarts the service. The
existing state file is kept, so the agent does not re-register. If the new build requires a new
pairing, the agent logs `AGENT_UNAUTHORIZED`; create a new registration code, remove
`/var/lib/mindpanel-agent/state.json`, add the code to `/etc/mindpanel-agent/agent.env` and restart.

## Uninstall

```bash
sudo ./scripts/uninstall.sh
```

This removes the service, binaries, configuration and local state. It does not revoke the agent
credential; revoke it in MindPanel > Agent Management.

## Troubleshooting

```bash
systemctl status mindpanel-agent
journalctl -u mindpanel-agent -f
```

- **`AGENT_UNAUTHORIZED`** — the credential was revoked or the state file is invalid. Create a new
  registration code in MindPanel, remove `/var/lib/mindpanel-agent/state.json`, put the new code in
  the environment file and restart the service.
- **`REGISTRATION_CODE_INVALID` / `_EXPIRED` / `_USED`** — create a new code in MindPanel. Codes are
  single-use.
- **`STALE_MESSAGE`** — the server clock and agent clock differ too much, or a duplicate metrics
  snapshot was sent. Enable NTP on both hosts.
- **Connection errors** — verify outbound HTTPS access to `MINDPANEL_URL`; no inbound port is
  required on the monitored server.

## Protocol

All agent endpoints are under `/api/v1/agents` and use JSON.

| Endpoint          | Authentication              | Purpose                         |
| ----------------- | --------------------------- | ------------------------------- |
| `POST /register`  | One-time registration code  | Exchange code for agent token   |
| `POST /heartbeat` | `Authorization: Bearer ...` | Liveness and system information |
| `POST /metrics`   | `Authorization: Bearer ...` | Metrics and process snapshot    |

Every message includes `protocolVersion` (currently `1`). Registration and heartbeat messages carry
system information; metrics messages carry a `metrics` object (CPU, memory, swap, load, uptime,
disks, disk I/O, networks, process count) and a bounded `processes` array.

The authoritative field-level schemas live in
[`packages/shared/src/protocol.ts`](https://github.com/MindOfPersonal/MindPanel/blob/master/packages/shared/src/protocol.ts)
in the MindPanel repository and are shared by the agent and the server. This repository keeps a
vendored copy in [`src/protocol.ts`](src/protocol.ts) so it can be installed independently. When a
message shape changes, update both copies and bump `AGENT_PROTOCOL_VERSION` for
backwards-incompatible changes.

Error codes the agent handles: `AGENT_UNAUTHORIZED` (revoked/invalid credential, fatal),
`REGISTRATION_CODE_INVALID`, `REGISTRATION_CODE_EXPIRED`, `REGISTRATION_CODE_USED` (fatal during
pairing), `STALE_MESSAGE` and `INVALID_TIMESTAMP` (clock/duplicate issue, retried) and the generic
`VALIDATION_ERROR` for malformed payloads.

The registration code is never accepted as a permanent secret. MindPanel stores only SHA-256
hashes of registration codes and agent tokens. Revoking an agent invalidates its token immediately.
