import { describe, expect, it } from 'vitest';

import { decodeMountField, parseBootTime, parseCpuTimes, parseProcessStat } from './linux.js';

describe('Linux collector parsing', () => {
  it('parses aggregate CPU times from /proc/stat', () => {
    expect(parseCpuTimes('cpu  100 0 50 800 20 0 0 0 0 0\ncpu0 1 2 3 4')).toEqual({
      total: 970,
      idle: 820,
    });
  });

  it('returns null when the aggregate CPU line is missing', () => {
    expect(parseCpuTimes('cpu0 1 2 3 4')).toBeNull();
  });

  it('parses the boot time from /proc/stat', () => {
    expect(parseBootTime('cpu 1 2 3 4\nbtime 1690000000\n')).toBe(1690000000);
  });

  it('parses process CPU ticks and start time, including parentheses in the name', () => {
    const raw =
      '123 (node ) worker) S 1 123 123 0 -1 4194560 1000 0 0 0 10 20 0 0 20 0 1 0 5000 123456 789';
    expect(parseProcessStat(raw)).toEqual({
      state: 'S',
      utime: 10,
      stime: 20,
      starttime: 5000,
    });
  });

  it('rejects truncated process statistics', () => {
    expect(parseProcessStat('123 (node) S 1 2')).toBeNull();
  });

  it('decodes escaped mountpoint characters', () => {
    expect(decodeMountField('/mnt/my\\040disk')).toBe('/mnt/my disk');
    expect(decodeMountField('/mnt/back\\134slash')).toBe('/mnt/back\\slash');
  });
});
