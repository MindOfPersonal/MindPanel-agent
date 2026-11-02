import os from 'node:os';

import type {
  AgentHeartbeatResponse,
  AgentMetricsRequest,
  AgentMetricsResponse,
  AgentRegistrationResponse,
} from './protocol.js';
import { AGENT_PROTOCOL_VERSION } from './protocol.js';

import { AgentApiError, postJson } from './api-client.js';
import { createCollector } from './collectors/index.js';
import type { SystemInfo } from './collectors/index.js';
import { loadConfig } from './config.js';
import type { AgentConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { loadState, saveState } from './state.js';
import type { AgentState } from './state.js';

const AGENT_VERSION = '0.2.0';
const MAX_RETRY_DELAY_MS = 60_000;

class FatalAgentError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number, baseMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.min(attempt, 6), MAX_RETRY_DELAY_MS);
  return exponential + Math.floor(Math.random() * 1000);
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AgentApiError)) {
    return true;
  }
  if (error.status === 0 || error.status === 429 || error.status >= 500) {
    return true;
  }
  return false;
}

async function registerAgent(config: AgentConfig, systemInfo: SystemInfo): Promise<AgentState> {
  if (!config.registrationCode) {
    throw new FatalAgentError(
      'No agent state found and REGISTRATION_CODE is not set. ' +
        'Create a server in MindPanel and install the agent with its one-time registration code.',
    );
  }

  let attempt = 0;
  for (;;) {
    try {
      logger.info('Registering agent with MindPanel', { url: config.mindpanelUrl });
      const result = await postJson<AgentRegistrationResponse>({
        baseUrl: config.mindpanelUrl,
        path: '/api/v1/agents/register',
        timeoutMs: config.requestTimeoutMs,
        body: {
          ...systemInfo,
          registrationCode: config.registrationCode,
          protocolVersion: AGENT_PROTOCOL_VERSION,
          agentVersion: AGENT_VERSION,
        },
      });

      const state: AgentState = {
        agentId: result.agentId,
        agentToken: result.agentToken,
        serverId: result.serverId,
        serverName: result.serverName,
        protocolVersion: result.protocolVersion,
        registeredAt: new Date().toISOString(),
        heartbeatIntervalSeconds: result.heartbeatIntervalSeconds,
        statsIntervalSeconds: result.statsIntervalSeconds,
      };
      await saveState(config.stateFile, state);
      logger.info('Agent registered successfully', {
        serverId: result.serverId,
        serverName: result.serverName,
        heartbeatIntervalSeconds: result.heartbeatIntervalSeconds,
        statsIntervalSeconds: result.statsIntervalSeconds,
      });
      return state;
    } catch (error) {
      if (error instanceof AgentApiError && isRetryable(error)) {
        attempt += 1;
        const delay = retryDelay(attempt, 2000);
        logger.warn('Agent registration failed, retrying', {
          status: error.status,
          code: error.code,
          message: error.message,
          retryInMs: delay,
        });
        await sleep(delay);
        continue;
      }
      if (error instanceof AgentApiError) {
        throw new FatalAgentError(
          `Agent registration was rejected (${error.code}): ${error.message}. ` +
            'Create a new registration code in MindPanel and try again.',
        );
      }
      throw error;
    }
  }
}

function heartbeatBody(systemInfo: SystemInfo): Record<string, unknown> {
  return {
    ...systemInfo,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    sentAt: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.round(os.uptime())),
  };
}

function metricsBody(snapshot: {
  metrics: AgentMetricsRequest['metrics'];
  processes: AgentMetricsRequest['processes'];
}): AgentMetricsRequest {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    sentAt: new Date().toISOString(),
    metrics: snapshot.metrics,
    processes: snapshot.processes,
  };
}

interface LoopOptions {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  onFatal: (error: Error) => void;
}

function startLoop(options: LoopOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      await options.task();
      failures = 0;
      schedule(options.intervalMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AgentApiError && (error.status === 401 || error.status === 403)) {
        options.onFatal(
          new FatalAgentError(
            'MindPanel rejected the agent credential. The agent was revoked or the state file is invalid. ' +
              'Create a new registration code in MindPanel, remove the state file and register again.',
          ),
        );
        return;
      }
      failures += 1;
      const delay = retryDelay(failures, options.intervalMs);
      logger.warn(`${options.name} failed, retrying`, {
        message,
        retryInMs: delay,
        ...(error instanceof AgentApiError ? { status: error.status, code: error.code } : {}),
      });
      schedule(delay);
    }
  };

  void run();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function main(): Promise<void> {
  const config = await loadConfig();
  setLogLevel(config.logLevel);
  logger.info('Starting MindPanel agent', {
    version: AGENT_VERSION,
    url: config.mindpanelUrl,
    platform: os.platform(),
    architecture: os.arch(),
    configuredHeartbeatIntervalSeconds: config.heartbeatIntervalMs / 1000,
    configuredStatsIntervalSeconds: config.statsIntervalMs / 1000,
  });

  const collector = createCollector();
  const systemInfo = await collector.getSystemInfo();

  const existing = await loadState(config.stateFile);
  const state = existing ?? (await registerAgent(config, systemInfo));

  if (existing) {
    logger.info('Loaded existing agent state', {
      serverId: existing.serverId,
      serverName: existing.serverName,
    });
  }

  const heartbeatIntervalMs =
    (state.heartbeatIntervalSeconds ?? config.heartbeatIntervalMs / 1000) * 1000;
  const statsIntervalMs = (state.statsIntervalSeconds ?? config.statsIntervalMs / 1000) * 1000;
  logger.info('Agent collection intervals active', {
    heartbeatIntervalSeconds: heartbeatIntervalMs / 1000,
    statsIntervalSeconds: statsIntervalMs / 1000,
  });

  const stopLoops: Array<() => void> = [];
  let shuttingDown = false;

  const shutdown = (code: number, reason?: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const stop of stopLoops) {
      stop();
    }
    logger.info('MindPanel agent stopped', reason ? { reason } : undefined);
    process.exit(code);
  };

  const onFatal = (error: Error): void => {
    logger.error('Fatal agent error', { message: error.message });
    shutdown(1, error.message);
  };

  stopLoops.push(
    startLoop({
      name: 'Heartbeat',
      intervalMs: heartbeatIntervalMs,
      onFatal,
      task: async () => {
        const response = await postJson<AgentHeartbeatResponse>({
          baseUrl: config.mindpanelUrl,
          path: '/api/v1/agents/heartbeat',
          token: state.agentToken,
          timeoutMs: config.requestTimeoutMs,
          body: heartbeatBody(systemInfo),
        });
        logger.debug('Heartbeat accepted', {
          serverId: response.serverId,
          status: response.status,
        });
      },
    }),
  );

  stopLoops.push(
    startLoop({
      name: 'Metrics collection',
      intervalMs: statsIntervalMs,
      onFatal,
      task: async () => {
        const snapshot = await collector.sample();
        const response = await postJson<AgentMetricsResponse>({
          baseUrl: config.mindpanelUrl,
          path: '/api/v1/agents/metrics',
          token: state.agentToken,
          timeoutMs: config.requestTimeoutMs,
          body: metricsBody(snapshot),
        });
        logger.debug('Metrics accepted', {
          serverId: response.serverId,
          processCount: snapshot.metrics.processCount,
        });
      },
    }),
  );

  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
}

void main().catch((error: unknown) => {
  logger.error('MindPanel agent failed to start', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
