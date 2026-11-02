import { describe, expect, it } from 'vitest';

import {
  decodeMountField,
  isPhysicalDiskDevice,
  parseBootTime,
  parseCpuTimes,
  parseDiskStats,
  parseProcessStat,
} from './linux.js';

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

  it('parses disk counters in 512-byte sectors', () => {
    const raw = [
      '   8       0 sda 100 0 2048 10 50 0 1024 20 0 40 0',
      '   8       1 sda1 10 0 100 5 5 0 50 5 0 20 0',
      '   7       0 loop0 1 0 2 0 1 0 2 0 0 0 0',
      '259       0 nvme0n1 5 0 1000 1 6 0 3000 1 0 10 0',
      '259       1 nvme0n1p1 1 0 100 1 1 0 100 1 0 10 0',
    ].join('\n');

    const totals = parseDiskStats(raw);

    expect(totals.get('sda')).toEqual({
      readBytesTotal: 2048 * 512,
      writeBytesTotal: 1024 * 512,
    });
    expect(totals.has('sda1')).toBe(false);
    expect(totals.has('loop0')).toBe(false);
    expect(totals.get('nvme0n1')).toEqual({
      readBytesTotal: 1000 * 512,
      writeBytesTotal: 3000 * 512,
    });
    expect(totals.has('nvme0n1p1')).toBe(false);
  });

  it('recognises whole disks and rejects partitions', () => {
    expect(isPhysicalDiskDevice('sda')).toBe(true);
    expect(isPhysicalDiskDevice('vdb')).toBe(true);
    expect(isPhysicalDiskDevice('nvme0n1')).toBe(true);
    expect(isPhysicalDiskDevice('mmcblk0')).toBe(true);
    expect(isPhysicalDiskDevice('sda1')).toBe(false);
    expect(isPhysicalDiskDevice('nvme0n1p1')).toBe(false);
    expect(isPhysicalDiskDevice('loop0')).toBe(false);
    expect(isPhysicalDiskDevice('dm-0')).toBe(false);
  });
});
