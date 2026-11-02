import type { AgentMetricsPayload, AgentRegistrationRequest, ProcessMetric } from '../protocol.js';

export type SystemInfo = Omit<
  AgentRegistrationRequest,
  'registrationCode' | 'protocolVersion' | 'agentVersion'
>;

export interface MetricsSnapshot {
  metrics: AgentMetricsPayload;
  processes: ProcessMetric[];
}

export interface Collector {
  getSystemInfo(): Promise<SystemInfo>;
  sample(): Promise<MetricsSnapshot>;
}
