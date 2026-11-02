import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const stateSchema = z.object({
  agentId: z.string().uuid(),
  agentToken: z.string().min(20),
  serverId: z.string().uuid(),
  serverName: z.string().min(1),
  protocolVersion: z.number().int().min(1),
  registeredAt: z.string().datetime({ offset: true }),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).optional(),
  statsIntervalSeconds: z.number().int().min(2).max(300).optional(),
});

export type AgentState = z.infer<typeof stateSchema>;

export async function loadState(file: string): Promise<AgentState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Unable to read agent state ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Agent state ${file} is not valid JSON. Remove it and register again.`);
  }

  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Agent state ${file} is invalid. Remove it and register the agent again with a new code.`,
    );
  }
  return result.data;
}

export async function saveState(file: string, state: AgentState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}
