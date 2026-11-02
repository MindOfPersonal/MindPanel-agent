import { z } from 'zod';

/**
 * Wire protocol shared with the MindPanel server.
 *
 * This file is a vendored copy of the agent-facing parts of
 * `packages/shared/src/protocol.ts` and `packages/shared/src/servers.ts` in the
 * MindPanel repository. The server copy is authoritative. When either side
 * changes a message shape, update both copies and bump
 * `AGENT_PROTOCOL_VERSION` for backwards-incompatible changes.
 */

/**
 * Agent protocol version. Bump this whenever a message shape changes in a
 * backwards-incompatible way; the server rejects agents that do not match.
 */
export const AGENT_PROTOCOL_VERSION = 1;

const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const percentage = z.number().min(0).max(100);
const nonNegativeNumber = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const isoDateTime = z.string().datetime({ offset: true });

const systemInfoSchema = z.object({
  hostname: z.string().trim().min(1).max(255),
  osName: optionalText(128),
  osVersion: optionalText(128),
  kernelVersion: optionalText(128),
  architecture: optionalText(64),
  cpuModel: optionalText(255),
  cpuCores: z.number().int().min(1).max(4096).optional(),
  totalMemoryBytes: byteCount.optional(),
  primaryIp: optionalText(45),
  timezone: optionalText(64),
});

export const agentRegistrationSchema = systemInfoSchema.extend({
  registrationCode: z.string().trim().min(20).max(200),
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  agentVersion: z.string().trim().min(1).max(32),
});

export const agentHeartbeatSchema = systemInfoSchema.partial().extend({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  sentAt: isoDateTime,
  agentVersion: z.string().trim().min(1).max(32),
  uptimeSeconds: byteCount,
});

export const diskMetricSchema = z.object({
  mountpoint: z.string().trim().min(1).max(255),
  filesystem: z.string().trim().max(64),
  totalBytes: byteCount,
  usedBytes: byteCount,
  freeBytes: byteCount,
  usedPercent: percentage,
});

export const diskIoMetricSchema = z.object({
  device: z.string().trim().min(1).max(64),
  readBytesPerSecond: nonNegativeNumber,
  writeBytesPerSecond: nonNegativeNumber,
  readBytesTotal: byteCount,
  writeBytesTotal: byteCount,
});

export const networkMetricSchema = z.object({
  interface: z.string().trim().min(1).max(64),
  addresses: z.array(z.string().trim().max(64)).max(20),
  rxBytesPerSecond: nonNegativeNumber,
  txBytesPerSecond: nonNegativeNumber,
  rxBytesTotal: byteCount,
  txBytesTotal: byteCount,
  isUp: z.boolean(),
});

export const processMetricSchema = z.object({
  pid: z.number().int().min(1).max(2_147_483_647),
  name: z.string().trim().min(1).max(128),
  user: z.string().trim().max(64),
  cpuPercent: z.number().min(0).max(10_000),
  memoryBytes: byteCount,
  memoryPercent: percentage,
  state: z.string().trim().max(16),
  startedAt: isoDateTime.optional(),
  commandLine: z.string().max(512).optional(),
});

export const agentMetricsSchema = z.object({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  sentAt: isoDateTime,
  agentVersion: z.string().trim().min(1).max(32),
  metrics: z.object({
    cpuPercent: percentage,
    memoryUsedBytes: byteCount,
    memoryTotalBytes: byteCount,
    swapUsedBytes: byteCount,
    swapTotalBytes: byteCount,
    load1: nonNegativeNumber.optional(),
    load5: nonNegativeNumber.optional(),
    load15: nonNegativeNumber.optional(),
    uptimeSeconds: byteCount,
    disks: z.array(diskMetricSchema).max(50),
    diskIo: z.array(diskIoMetricSchema).max(50).optional(),
    networks: z.array(networkMetricSchema).max(50),
    processCount: z.number().int().min(0).max(1_000_000),
  }),
  processes: z.array(processMetricSchema).max(1_000),
});

export type AgentRegistrationRequest = z.infer<typeof agentRegistrationSchema>;
export type AgentHeartbeatRequest = z.infer<typeof agentHeartbeatSchema>;
export type AgentMetricsRequest = z.infer<typeof agentMetricsSchema>;
export type DiskMetric = z.infer<typeof diskMetricSchema>;
export type DiskIoMetric = z.infer<typeof diskIoMetricSchema>;
export type NetworkMetric = z.infer<typeof networkMetricSchema>;
export type ProcessMetric = z.infer<typeof processMetricSchema>;
export type AgentMetricsPayload = AgentMetricsRequest['metrics'];

// Response types mirrored from `packages/shared/src/servers.ts`.

export type ServerStatus = 'pending' | 'connecting' | 'online' | 'offline';

export interface AgentRegistrationResponse {
  agentId: string;
  agentToken: string;
  serverId: string;
  serverName: string;
  protocolVersion: number;
  heartbeatIntervalSeconds: number;
  statsIntervalSeconds: number;
}

export interface AgentHeartbeatResponse {
  ok: true;
  serverId: string;
  status: ServerStatus;
  heartbeatIntervalSeconds: number;
  statsIntervalSeconds: number;
  serverTime: string;
}

export interface AgentMetricsResponse {
  ok: true;
  serverId: string;
  status: ServerStatus;
  statsIntervalSeconds: number;
  serverTime: string;
}
