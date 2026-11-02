export class AgentApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export interface PostOptions {
  baseUrl: string;
  path: string;
  body: unknown;
  token?: string;
  timeoutMs: number;
}

export async function postJson<T>(options: PostOptions): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'mindpanel-agent/0.1.0',
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${options.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new AgentApiError(
      `Could not reach MindPanel: ${(error as Error).message}`,
      0,
      'NETWORK_ERROR',
    );
  }

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = body as ErrorBody | null;
    const code =
      typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'REQUEST_FAILED';
    const message =
      typeof errorBody?.error?.message === 'string'
        ? errorBody.error.message
        : `MindPanel returned HTTP ${response.status}.`;
    throw new AgentApiError(message, response.status, code);
  }

  return body as T;
}
