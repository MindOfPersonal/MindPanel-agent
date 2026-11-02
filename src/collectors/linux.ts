import { readFile, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DiskIoMetric, DiskMetric, NetworkMetric, ProcessMetric } from '../protocol.js';

import type { Collector, MetricsSnapshot, SystemInfo } from './types.js';

const CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_PAGE_SIZE = 4096;
const MAX_DISKS = 50;
const MAX_DISK_IO_DEVICES = 20;
const MAX_NETWORKS = 50;
const TOP_PROCESS_LIMIT = 50;
const MAX_PROCESSES = 100;
/** /proc/diskstats always reports sectors in 512-byte units. */
const DISK_SECTOR_SIZE = 512;

const REAL_FILESYSTEMS = new Set([
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'f2fs',
  'vfat',
  'exfat',
  'ntfs',
  'ntfs3',
  'fuseblk',
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'overlay',
  'jfs',
  'reiserfs',
]);

export interface CpuTimes {
  total: number;
  idle: number;
}

export interface ProcessTicks {
  utime: number;
  stime: number;
}

interface NetworkTotals {
  rx: number;
  tx: number;
}

export interface DiskIoTotals {
  readBytesTotal: number;
  writeBytesTotal: number;
}

export function decodeMountField(value: string): string {
  return value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function parseKeyValueBlock(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) {
      continue;
    }
    values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return values;
}

function numberFrom(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value.split(/\s+/)[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Physical block devices only: whole disks are reported, partitions are not,
 * because a partition is already part of its parent device.
 */
export function isPhysicalDiskDevice(name: string): boolean {
  if (/^nvme\d+n\d+$/.test(name)) {
    return true;
  }
  if (/^mmcblk\d+$/.test(name)) {
    return true;
  }
  if (/^(sd|vd|xvd|hd)[a-z]*$/.test(name)) {
    return !/\d$/.test(name);
  }
  return false;
}

/**
 * Parses /proc/diskstats into cumulative byte counters per device. Sectors are
 * always 512 bytes, independent of the device's logical block size.
 */
export function parseDiskStats(raw: string): Map<string, DiskIoTotals> {
  const totals = new Map<string, DiskIoTotals>();

  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      continue;
    }
    const name = fields[2];
    if (!name || !isPhysicalDiskDevice(name)) {
      continue;
    }
    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) {
      continue;
    }
    totals.set(name, {
      readBytesTotal: Math.max(0, sectorsRead) * DISK_SECTOR_SIZE,
      writeBytesTotal: Math.max(0, sectorsWritten) * DISK_SECTOR_SIZE,
    });
  }

  return totals;
}

export function parseCpuTimes(raw: string): CpuTimes | null {
  const line = raw.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) {
    return null;
  }
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number(value));
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  return { total, idle };
}

export function parseBootTime(raw: string): number | null {
  const line = raw.split('\n').find((entry) => entry.startsWith('btime '));
  if (!line) {
    return null;
  }
  const value = Number(line.split(/\s+/)[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseProcessStat(
  raw: string,
): (ProcessTicks & { state: string; starttime: number }) | null {
  const closing = raw.lastIndexOf(')');
  if (closing === -1) {
    return null;
  }
  const fields = raw
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) {
    return null;
  }
  const state = fields[0] ?? '?';
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const starttime = Number(fields[19]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(starttime)) {
    return null;
  }
  return { state, utime, stime, starttime };
}

function parseStatus(raw: string): Map<string, string> {
  return parseKeyValueBlock(raw);
}

function processUserName(uid: string | undefined, users: Map<string, string>): string {
  if (!uid) {
    return 'unknown';
  }
  return users.get(uid) ?? uid;
}

function firstNonInternalIpv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        return address.address;
      }
    }
  }
  return undefined;
}

function readOsRelease(raw: string | null): { osName?: string; osVersion?: string } {
  if (!raw) {
    return {};
  }
  const values = parseKeyValueBlock(raw);
  const pretty = values.get('PRETTY_NAME')?.replace(/^"|"$/g, '');
  if (pretty) {
    return { osName: pretty };
  }
  const name = values.get('NAME')?.replace(/^"|"$/g, '');
  const version = values.get('VERSION')?.replace(/^"|"$/g, '');
  return {
    ...(name ? { osName: name } : {}),
    ...(version ? { osVersion: version } : {}),
  };
}

async function loadUsers(): Promise<Map<string, string>> {
  const raw = await readText('/etc/passwd');
  const users = new Map<string, string>();
  if (!raw) {
    return users;
  }
  for (const line of raw.split('\n')) {
    const parts = line.split(':');
    if (parts.length >= 3 && parts[0] && parts[2]) {
      users.set(parts[2], parts[0]);
    }
  }
  return users;
}

export class LinuxCollector implements Collector {
  private previousCpu: CpuTimes | null = null;

  private previousProcessTicks = new Map<number, ProcessTicks>();

  private previousNetwork = new Map<string, NetworkTotals>();

  private previousNetworkAt: number | null = null;

  private previousDiskIo = new Map<string, DiskIoTotals>();

  private previousDiskIoAt: number | null = null;

  private users: Map<string, string> | null = null;

  private bootTime: number | null = null;

  async getSystemInfo(): Promise<SystemInfo> {
    const [meminfoRaw, osReleaseRaw] = await Promise.all([
      readText('/proc/meminfo'),
      readText('/etc/os-release'),
    ]);
    const meminfo = meminfoRaw ? parseKeyValueBlock(meminfoRaw) : new Map<string, string>();
    const totalMemoryKb = numberFrom(meminfo.get('MemTotal'));
    const cpus = os.cpus();
    const release = readOsRelease(osReleaseRaw);

    return {
      hostname: os.hostname(),
      ...(release.osName ? { osName: release.osName } : {}),
      ...(release.osVersion ? { osVersion: release.osVersion } : {}),
      kernelVersion: os.release(),
      architecture: os.arch(),
      ...(cpus[0]?.model ? { cpuModel: cpus[0].model.trim() } : {}),
      cpuCores: Math.max(1, cpus.length),
      totalMemoryBytes: totalMemoryKb
        ? Math.round(totalMemoryKb * 1024)
        : Math.round(os.totalmem()),
      ...(firstNonInternalIpv4() ? { primaryIp: firstNonInternalIpv4() } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async sample(): Promise<MetricsSnapshot> {
    const [statRaw, meminfoRaw, loadavgRaw, uptimeRaw] = await Promise.all([
      readText('/proc/stat'),
      readText('/proc/meminfo'),
      readText('/proc/loadavg'),
      readText('/proc/uptime'),
    ]);

    if (!statRaw || !meminfoRaw) {
      throw new Error('Unable to read /proc/stat or /proc/meminfo.');
    }

    if (this.bootTime === null) {
      this.bootTime = parseBootTime(statRaw);
    }

    const cpu = parseCpuTimes(statRaw);
    if (!cpu) {
      throw new Error('Unable to parse CPU statistics from /proc/stat.');
    }
    const cpuDelta = this.previousCpu ? Math.max(0, cpu.total - this.previousCpu.total) : 0;
    const idleDelta = this.previousCpu ? Math.max(0, cpu.idle - this.previousCpu.idle) : 0;
    const cpuPercent = cpuDelta > 0 ? clamp(((cpuDelta - idleDelta) / cpuDelta) * 100, 0, 100) : 0;
    this.previousCpu = cpu;

    const meminfo = parseKeyValueBlock(meminfoRaw);
    const memoryTotalBytes = Math.round((numberFrom(meminfo.get('MemTotal')) ?? 0) * 1024);
    const memoryAvailableBytes = Math.round(
      (numberFrom(meminfo.get('MemAvailable')) ?? numberFrom(meminfo.get('MemFree')) ?? 0) * 1024,
    );
    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);
    const swapTotalBytes = Math.round((numberFrom(meminfo.get('SwapTotal')) ?? 0) * 1024);
    const swapFreeBytes = Math.round((numberFrom(meminfo.get('SwapFree')) ?? 0) * 1024);
    const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

    const load = loadavgRaw?.trim().split(/\s+/) ?? [];
    const uptimeSeconds = Math.round(Number(uptimeRaw?.trim().split(/\s+/)[0] ?? os.uptime()));

    const [disks, diskIo, networks, processSnapshot] = await Promise.all([
      this.collectDisks(),
      this.collectDiskIo(),
      this.collectNetworks(),
      this.collectProcesses(cpuDelta, memoryTotalBytes),
    ]);

    return {
      metrics: {
        cpuPercent: round(cpuPercent),
        memoryUsedBytes,
        memoryTotalBytes,
        swapUsedBytes,
        swapTotalBytes,
        load1: load[0] !== undefined ? Number(load[0]) : undefined,
        load5: load[1] !== undefined ? Number(load[1]) : undefined,
        load15: load[2] !== undefined ? Number(load[2]) : undefined,
        uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : 0,
        disks,
        diskIo,
        networks,
        processCount: processSnapshot.processCount,
      },
      processes: processSnapshot.processes,
    };
  }

  private async collectDiskIo(): Promise<DiskIoMetric[]> {
    const raw = await readText('/proc/diskstats');
    if (!raw) {
      return [];
    }

    const now = Date.now();
    const elapsedSeconds =
      this.previousDiskIoAt === null ? 0 : Math.max(0, (now - this.previousDiskIoAt) / 1000);
    const totals = parseDiskStats(raw);
    const metrics: DiskIoMetric[] = [];

    for (const [device, current] of totals) {
      const previous = this.previousDiskIo.get(device);
      const readBytesPerSecond =
        previous && elapsedSeconds > 0
          ? Math.max(0, (current.readBytesTotal - previous.readBytesTotal) / elapsedSeconds)
          : 0;
      const writeBytesPerSecond =
        previous && elapsedSeconds > 0
          ? Math.max(0, (current.writeBytesTotal - previous.writeBytesTotal) / elapsedSeconds)
          : 0;

      metrics.push({
        device,
        readBytesPerSecond: Math.round(readBytesPerSecond),
        writeBytesPerSecond: Math.round(writeBytesPerSecond),
        readBytesTotal: Math.round(current.readBytesTotal),
        writeBytesTotal: Math.round(current.writeBytesTotal),
      });
    }

    this.previousDiskIo = totals;
    this.previousDiskIoAt = now;

    return metrics
      .sort(
        (left, right) =>
          right.readBytesPerSecond +
          right.writeBytesPerSecond -
          (left.readBytesPerSecond + left.writeBytesPerSecond),
      )
      .slice(0, MAX_DISK_IO_DEVICES);
  }

  private async collectDisks(): Promise<DiskMetric[]> {
    const raw = await readText('/proc/mounts');
    if (!raw) {
      return [];
    }

    const disks: DiskMetric[] = [];
    const seen = new Set<string>();

    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      const filesystem = parts[2];
      const mountpoint = decodeMountField(parts[1] ?? '');
      if (!filesystem || !mountpoint || !REAL_FILESYSTEMS.has(filesystem) || seen.has(mountpoint)) {
        continue;
      }
      seen.add(mountpoint);

      try {
        const stats = await statfs(mountpoint);
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        if (totalBytes <= 0) {
          continue;
        }
        const usedBytes = Math.max(0, totalBytes - freeBytes);
        disks.push({
          mountpoint,
          filesystem,
          totalBytes: Math.round(totalBytes),
          usedBytes: Math.round(usedBytes),
          freeBytes: Math.round(freeBytes),
          usedPercent: round((usedBytes / totalBytes) * 100),
        });
      } catch {
        // Unreadable mountpoints (permissions, stale NFS) are skipped.
      }

      if (disks.length >= MAX_DISKS) {
        break;
      }
    }

    return disks;
  }

  private async collectNetworks(): Promise<NetworkMetric[]> {
    const raw = await readText('/proc/net/dev');
    if (!raw) {
      return [];
    }

    const now = Date.now();
    const elapsedSeconds =
      this.previousNetworkAt === null ? 0 : Math.max(0, (now - this.previousNetworkAt) / 1000);
    const interfaces = os.networkInterfaces();
    const nextTotals = new Map<string, NetworkTotals>();
    const networks: NetworkMetric[] = [];

    for (const line of raw.split('\n').slice(2)) {
      const separator = line.indexOf(':');
      if (separator === -1) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      const fields = line
        .slice(separator + 1)
        .trim()
        .split(/\s+/)
        .map((value) => Number(value));
      if (!name || name === 'lo' || fields.length < 9) {
        continue;
      }
      const rxBytesTotal = fields[0] ?? 0;
      const txBytesTotal = fields[8] ?? 0;
      if (!Number.isFinite(rxBytesTotal) || !Number.isFinite(txBytesTotal)) {
        continue;
      }

      const previous = this.previousNetwork.get(name);
      const rxBytesPerSecond =
        previous && elapsedSeconds > 0
          ? Math.max(0, (rxBytesTotal - previous.rx) / elapsedSeconds)
          : 0;
      const txBytesPerSecond =
        previous && elapsedSeconds > 0
          ? Math.max(0, (txBytesTotal - previous.tx) / elapsedSeconds)
          : 0;

      nextTotals.set(name, { rx: rxBytesTotal, tx: txBytesTotal });

      const addresses = (interfaces[name] ?? [])
        .filter((address) => !address.internal)
        .map((address) => address.address);
      const operstate = await readText(path.join('/sys/class/net', name, 'operstate'));

      networks.push({
        interface: name,
        addresses: addresses.slice(0, 20),
        rxBytesPerSecond: Math.round(rxBytesPerSecond),
        txBytesPerSecond: Math.round(txBytesPerSecond),
        rxBytesTotal: Math.round(rxBytesTotal),
        txBytesTotal: Math.round(txBytesTotal),
        isUp: operstate ? operstate.trim() !== 'down' : true,
      });

      if (networks.length >= MAX_NETWORKS) {
        break;
      }
    }

    this.previousNetwork = nextTotals;
    this.previousNetworkAt = now;
    return networks;
  }

  private async collectProcesses(
    cpuDelta: number,
    memoryTotalBytes: number,
  ): Promise<{ processes: ProcessMetric[]; processCount: number }> {
    const entries = await readdir('/proc', { withFileTypes: true });
    const pids = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name));

    if (!this.users) {
      this.users = await loadUsers();
    }
    const users = this.users;
    const cpuCount = Math.max(1, os.cpus().length);
    const nextTicks = new Map<number, ProcessTicks>();
    const processes: ProcessMetric[] = [];
    const pageSize = DEFAULT_PAGE_SIZE;

    for (const pid of pids) {
      const statRaw = await readText(`/proc/${pid}/stat`);
      const statusRaw = await readText(`/proc/${pid}/status`);
      if (!statRaw || !statusRaw) {
        continue;
      }
      const stat = parseProcessStat(statRaw);
      if (!stat) {
        continue;
      }
      const status = parseStatus(statusRaw);
      const ticks = stat.utime + stat.stime;
      nextTicks.set(pid, { utime: stat.utime, stime: stat.stime });

      const previous = this.previousProcessTicks.get(pid);
      const processDelta = previous ? Math.max(0, ticks - (previous.utime + previous.stime)) : 0;
      const cpuPercent =
        cpuDelta > 0 && previous ? clamp((processDelta / cpuDelta) * 100 * cpuCount, 0, 10_000) : 0;

      const name = status.get('Name') ?? `pid-${pid}`;
      const state = (status.get('State') ?? stat.state).split(/\s+/)[0] ?? '?';
      const uid = status.get('Uid')?.split(/\s+/)[0];
      const rssKb = numberFrom(status.get('VmRSS')) ?? 0;
      const memoryBytes = Math.max(0, Math.round(rssKb * 1024));
      const startedAt =
        this.bootTime !== null
          ? new Date((this.bootTime + stat.starttime / CLOCK_TICKS_PER_SECOND) * 1000)
          : null;
      const cmdlineRaw = await readText(`/proc/${pid}/cmdline`);
      const commandLine = cmdlineRaw
        ? cmdlineRaw.replace(/\0/g, ' ').trim().slice(0, 512)
        : undefined;

      // `rss` from /proc/pid/stat is a fallback when VmRSS is unavailable.
      const fallbackRss = Number(
        statRaw
          .slice(statRaw.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/)[21],
      );
      const effectiveMemory =
        memoryBytes > 0
          ? memoryBytes
          : Number.isFinite(fallbackRss)
            ? Math.max(0, fallbackRss * pageSize)
            : 0;
      const memoryPercent =
        memoryTotalBytes > 0 ? clamp((effectiveMemory / memoryTotalBytes) * 100, 0, 100) : 0;

      processes.push({
        pid,
        name: name.slice(0, 128),
        user: processUserName(uid, users),
        cpuPercent: round(cpuPercent),
        memoryBytes: effectiveMemory,
        memoryPercent: round(memoryPercent),
        state: state.slice(0, 16),
        ...(startedAt && !Number.isNaN(startedAt.getTime())
          ? { startedAt: startedAt.toISOString() }
          : {}),
        ...(commandLine ? { commandLine } : {}),
      });
    }

    this.previousProcessTicks = nextTicks;

    const byCpu = [...processes].sort((left, right) => right.cpuPercent - left.cpuPercent);
    const byMemory = [...processes].sort((left, right) => right.memoryBytes - left.memoryBytes);
    const selected = new Map<number, ProcessMetric>();
    for (const process of [
      ...byCpu.slice(0, TOP_PROCESS_LIMIT),
      ...byMemory.slice(0, TOP_PROCESS_LIMIT),
    ]) {
      selected.set(process.pid, process);
    }

    return {
      processes: [...selected.values()].slice(0, MAX_PROCESSES),
      processCount: pids.length,
    };
  }
}
