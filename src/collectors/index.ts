import os from 'node:os';

import { LinuxCollector } from './linux.js';
import type { Collector } from './types.js';

export function createCollector(): Collector {
  if (os.platform() !== 'linux') {
    throw new Error(
      `The MindPanel agent currently supports Linux only (detected ${os.platform()}). ` +
        'Windows support is planned for a later phase.',
    );
  }
  return new LinuxCollector();
}

export type { Collector, MetricsSnapshot, SystemInfo } from './types.js';
