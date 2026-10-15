// Host telemetry: hostname, OS label, CPU/RAM/uptime vitals, network interfaces.
import { execFile } from 'child_process';
import os from 'os';

import type { MacAddressEntry, MacAddressMap, NetworkInterface, Vitals } from '@showtrak/protocol';
import type { Result } from '../../types/client';

// A MAC of all zeroes is what the OS reports for interfaces that have no
// hardware address at all (VPN/tunnel adapters such as utun*, and loopback).
const ZERO_MAC = '00:00:00:00:00:00';

interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

let CPUUsage = 0.0;
let __prevCpuTimes: CpuTimesSnapshot | null = null;
const __cpuWindow: number[] = [];
const __CPU_WINDOW_SIZE = 3; // 2–3s smoothing

function snapshotCpuTimes(): CpuTimesSnapshot {
  const list = os.cpus();
  // Summarize times across all logical CPUs
  let idle = 0,
    total = 0;
  for (const c of list) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sampleCPU(): void {
  try {
    const curr = snapshotCpuTimes();
    if (__prevCpuTimes) {
      const idleDelta = curr.idle - __prevCpuTimes.idle;
      const totalDelta = curr.total - __prevCpuTimes.total;
      if (totalDelta > 0) {
        const usage = (1 - idleDelta / totalDelta) * 100;
        const clamped = Math.max(0, Math.min(100, usage));
        // Rolling average smoothing across last N samples
        __cpuWindow.push(clamped);
        if (__cpuWindow.length > __CPU_WINDOW_SIZE) __cpuWindow.shift();
        const avg = __cpuWindow.reduce((a, b) => a + b, 0) / __cpuWindow.length;
        CPUUsage = Number(avg.toFixed(2));
      }
    }
    __prevCpuTimes = curr;
  } catch (_error) {
    // Best-effort CPU sampling should never crash runtime flow.
  }
}

// Initialize snapshot and start a 1s sampler; this aligns with Task Manager more closely on Windows
__prevCpuTimes = snapshotCpuTimes();
setInterval(sampleCPU, 1000);

// --- macOS memory ------------------------------------------------------------
//
// On macOS `os.freemem()` is the kernel's free-page count, which excludes
// everything the OS keeps as reclaimable file cache. A Mac that has been up for
// a while has almost no truly free pages, so `total - free` read 90%+ on an idle
// machine and the RAM figure (and any alarm on it) was meaningless there.
//
// Activity Monitor's "Memory Used" is app memory + wired + compressed, which
// vm_stat exposes as page counts:
//   (Anonymous pages - Pages purgeable) + Pages wired down + Pages occupied by compressor
// Heartbeat reads vitals every second, so vm_stat is NOT run per call: a slow
// background sampler keeps the last figure, and GetVitals falls back to
// `total - free` until it has one (or whenever it fails).
const MAC_MEMORY_SAMPLE_INTERVAL_MS = 5000;
const MAC_MEMORY_TIMEOUT_MS = 4000;

let MacUsedMemory: number | null = null;
let MacMemorySampleInFlight = false;

/**
 * Bytes in use as Activity Monitor counts them, from `vm_stat` output, or null
 * when the output is not recognisably vm_stat's. The page size comes from the
 * header ("page size of 16384 bytes"): Apple silicon uses 16K pages and Intel
 * 4K, so assuming either would be wrong by a factor of four on the other.
 */
export function ParseVmStat(Output: unknown): number | null {
  const Text = String(Output ?? '');
  const PageSizeMatch = /page size of (\d+) bytes/i.exec(Text);
  const PageSize = PageSizeMatch ? Number(PageSizeMatch[1]) : NaN;
  if (!Number.isFinite(PageSize) || PageSize <= 0) return null;

  const Pages = (Label: string): number | null => {
    const Match = new RegExp(`^\\s*"?${Label}"?:\\s+(\\d+)\\.?\\s*$`, 'mi').exec(Text);
    return Match ? Number(Match[1]) : null;
  };
  const Anonymous = Pages('Anonymous pages');
  const Wired = Pages('Pages wired down');
  const Compressor = Pages('Pages occupied by compressor');
  // Purgeable is subtracted rather than required: it is absent on some older
  // releases, and counting it as zero only errs towards reading slightly high.
  const Purgeable = Pages('Pages purgeable') ?? 0;
  if (Anonymous === null || Wired === null || Compressor === null) return null;

  const Used = (Math.max(0, Anonymous - Purgeable) + Wired + Compressor) * PageSize;
  return Number.isFinite(Used) ? Used : null;
}

function sampleMacMemory(): void {
  if (MacMemorySampleInFlight) return;
  MacMemorySampleInFlight = true;
  try {
    execFile(
      'vm_stat',
      [],
      { timeout: MAC_MEMORY_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (Err, Stdout) => {
        MacMemorySampleInFlight = false;
        // Any failure drops back to `total - free` rather than holding on to a
        // figure that is getting older by the second.
        MacUsedMemory = Err ? null : ParseVmStat(Stdout);
      }
    );
  } catch (_error) {
    MacMemorySampleInFlight = false;
    MacUsedMemory = null;
  }
}

if (process.platform === 'darwin') {
  sampleMacMemory();
  const MacMemoryTimer = setInterval(sampleMacMemory, MAC_MEMORY_SAMPLE_INTERVAL_MS);
  // Never the reason the app cannot quit.
  if (MacMemoryTimer && typeof MacMemoryTimer.unref === 'function') MacMemoryTimer.unref();
}

/**
 * Used physical memory in bytes, clamped to [0, total]. `MacUsed` is the
 * vm_stat figure, honoured on macOS only; everywhere else (and on a Mac before
 * the first sample) this is `total - free`, exactly as before.
 */
export function ComputeUsedMemory(
  Total: number,
  Free: number,
  MacUsed: number | null,
  Platform: string = process.platform
): number {
  const Used = Platform === 'darwin' && MacUsed !== null ? MacUsed : Total - Free;
  return Math.min(Total, Math.max(0, Used));
}

// Format an uptime in seconds as HH:mm:ss, with an UNBOUNDED hours field.
//
// This used to go via `new Date(Uptime * 1000).toISOString().substr(11, 8)`,
// which is a time-of-day formatter, not a duration formatter: it wraps at 24h,
// so a machine up 25h01m30s reported "01:01:30". For an app whose whole job is
// monitoring long-lived show and arcade machines, that made the headline number
// silently wrong — and wrong in a way that looks entirely plausible, so nobody
// would ever report it as a bug.
//
// The server stores this as an opaque display string capped at 32 characters
// (see SocketValidation), so hours running past two digits is wire-safe.
export function FormatUptime(TotalSeconds: unknown): string {
  const Numeric = Number(TotalSeconds);
  const Safe = Number.isFinite(Numeric) && Numeric > 0 ? Math.floor(Numeric) : 0;
  const Hours = Math.floor(Safe / 3600);
  const Minutes = Math.floor((Safe % 3600) / 60);
  const Seconds = Safe % 60;
  const Pad = (Value: number) => String(Value).padStart(2, '0');
  return `${Pad(Hours)}:${Pad(Minutes)}:${Pad(Seconds)}`;
}

export const Manager = {
  Hostname: os.hostname(),

  OperatingSystem:
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',

  // Per-interface { ipv4, ipv6, mac } map, as consumed by the Server's
  // ClientManager.SystemInfo (it derives the Wake-on-LAN target set from the MAC
  // belonging to the client's active IPv4).
  //
  // Previously the `macaddress` package (last published 2020). Node's own
  // os.networkInterfaces() has reported `mac` reliably for years, and the loop
  // below is a faithful port of that package's networkinterfaces.js — the rules
  // are subtler than they look, and each one was verified against it:
  //
  //   - the filter is PER ADDRESS, not per interface. An interface is emitted
  //     if it has at least one non-internal address; its internal addresses are
  //     simply skipped. (Loopback has only internal ones, so it never appears.)
  //   - LAST WRITE WINS per family. An interface with both a link-local and a
  //     global IPv6 reports the last one listed, not the first — picking the
  //     first here produced fe80:: where the package reported the global
  //     address.
  //   - a MAC of all zeroes is omitted rather than reported, so tunnel adapters
  //     appear with their addresses but no `mac` key.
  //
  // Async purely to keep the call signature its callers already await.
  async GetMacAddresses(): Promise<Result<MacAddressMap>> {
    try {
      const nics = os.networkInterfaces();
      const results: MacAddressMap = {};

      for (const [name, addrs] of Object.entries(nics)) {
        if (!Array.isArray(addrs)) continue;

        const entry: MacAddressEntry = {};
        let hasAddresses = false;

        for (const addr of addrs) {
          if (!addr || addr.internal) continue;
          hasAddresses = true;
          // Node <18 reports family as 'IPv4'/'IPv6'; Node >=18 may report 4/6.
          // @types/node declares it as the string union only, so the numeric
          // case has to be reached through `unknown` rather than narrowed away.
          const rawFamily = addr.family as unknown;
          const family =
            typeof rawFamily === 'number'
              ? `ipv${rawFamily}`
              : String(rawFamily || '').toLowerCase();
          if (family === 'ipv4') entry.ipv4 = addr.address;
          else if (family === 'ipv6') entry.ipv6 = addr.address;
          if (addr.mac && addr.mac !== ZERO_MAC) entry.mac = addr.mac;
        }

        if (hasAddresses) results[name] = entry;
      }

      return [null, results];
    } catch (err) {
      return [err, null];
    }
  },

  async GetVitals(): Promise<Vitals> {
    const TotalMemory = os.totalmem();
    const UsedMemory = ComputeUsedMemory(TotalMemory, os.freemem(), MacUsedMemory);
    const Uptime = os.uptime();

    return {
      CPU: {
        UsagePercentage: CPUUsage,
      },
      Ram: {
        Total: TotalMemory,
        Used: UsedMemory,
        // Transmitted as a string by design — see RamVitals in @showtrak/protocol.
        UsagePercentage: ((UsedMemory / TotalMemory) * 100).toFixed(2),
      },
      Uptime: {
        Formatted: FormatUptime(Uptime),
        // Whole seconds alongside the display string, so the server can derive
        // a boot time without parsing "HH:mm:ss" back apart.
        Seconds: Math.max(0, Math.floor(Number(Uptime) || 0)),
      },
    };
  },

  // Network interfaces reporter
  // Returns an array of interfaces with their addresses (IPv4/IPv6)
  // [{ name, addresses: [{ family, address, netmask, cidr, mac, internal, scopeid }] }]
  async GetNetworkInterfaces(): Promise<Result<NetworkInterface[]>> {
    try {
      const nics = os.networkInterfaces();
      const results: NetworkInterface[] = [];
      for (const [name, addrs] of Object.entries(nics)) {
        if (!Array.isArray(addrs)) continue;
        results.push({
          name,
          addresses: addrs.map((a) => ({
            family: a.family,
            address: a.address,
            netmask: a.netmask,
            cidr: a.cidr || null,
            mac: a.mac,
            internal: !!a.internal,
            scopeid: typeof a.scopeid !== 'undefined' ? a.scopeid : null,
          })),
        });
      }
      return [null, results];
    } catch (err) {
      return [err, []];
    }
  },

  // Returns a de-duplicated list of the machine's non-internal IPv4 addresses.
  // Used by the identify overlay to show which LAN/VLAN IPs this client is on.
  GetLocalIPv4Addresses(): string[] {
    try {
      const nics = os.networkInterfaces();
      const seen = new Set<string>();
      const results: string[] = [];
      for (const addrs of Object.values(nics)) {
        if (!Array.isArray(addrs)) continue;
        for (const a of addrs) {
          // Node <18 reports family as 'IPv4'; Node >=18 may report the number 4.
          const isV4 = a && (a.family === 'IPv4' || (a.family as unknown) === 4);
          if (!isV4 || a.internal) continue;
          if (seen.has(a.address)) continue;
          seen.add(a.address);
          results.push(a.address);
        }
      }
      return results;
    } catch (_err) {
      return [];
    }
  },
};
