export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEYS = new Set([
  'token',
  'agentToken',
  'registrationCode',
  'authorization',
  'agentId',
  'password',
]);

let minimumLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

function sanitize(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEYS.has(key)) {
      result[key] = '[redacted]';
    } else if (value instanceof Error) {
      result[key] = { name: value.name, message: value.message };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) {
    return;
  }
  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    level,
    component: 'mindpanel-agent',
    msg: message,
    ...sanitize(fields),
  })}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
