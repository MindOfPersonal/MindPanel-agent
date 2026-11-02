import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { LogLevel } from './logger.js';

const urlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute http(s) URL' },
);

const configSchema = z.object({
  MINDPANEL_URL: urlSchema,
  REGISTRATION_CODE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(20).optional(),
  ),
  AGENT_STATE_FILE: z.string().trim().min(1).default('./mindpanel-agent-state.json'),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  STATS_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(300).default(5),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(2).max(120).default(15),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface AgentConfig {
  mindpanelUrl: string;
  registrationCode?: string;
  stateFile: string;
  heartbeatIntervalMs: number;
  statsIntervalMs: number;
  requestTimeoutMs: number;
  logLevel: LogLevel;
}

async function loadConfigFile(): Promise<Record<string, unknown>> {
  const file = process.env.AGENT_CONFIG_FILE;
  if (!file) {
    return {};
  }
  const resolved = path.resolve(file);
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read AGENT_CONFIG_FILE ${resolved}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the file must contain a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `AGENT_CONFIG_FILE ${resolved} is not valid JSON: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  const fileValues = await loadConfigFile();
  const envValues = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = configSchema.safeParse({ ...fileValues, ...envValues });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid agent configuration:\n${issues}`);
  }

  const url = new URL(parsed.data.MINDPANEL_URL);
  return {
    mindpanelUrl: url.toString().replace(/\/$/, ''),
    ...(parsed.data.REGISTRATION_CODE ? { registrationCode: parsed.data.REGISTRATION_CODE } : {}),
    stateFile: path.resolve(parsed.data.AGENT_STATE_FILE),
    heartbeatIntervalMs: parsed.data.HEARTBEAT_INTERVAL_SECONDS * 1000,
    statsIntervalMs: parsed.data.STATS_INTERVAL_SECONDS * 1000,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_SECONDS * 1000,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
