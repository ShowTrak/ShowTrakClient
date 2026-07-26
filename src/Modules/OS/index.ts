// Host telemetry: hostname, OS label, CPU/RAM/uptime vitals, network interfaces.
import os from 'os';

import type { MacAddressMap, NetworkInterface, Vitals } from '@showtrak/protocol';
import type { Result } from '../../types/client';

// A MAC of all zeroes is what the OS reports for interfaces that have no
// hardware address at all (VPN/tunnel adapters such as utun*, and loopback).
const ZERO_MAC = '00:00:00:00:00:00';

// One interface's entry in the map GetMacAddresses returns.
//
// NOTE: @showtrak/protocol declares `MacAddressMap = Record<string, string>`,
// which does not match what is actually sent — the value is this object, not a
// bare MAC string, and the Server's ClientManager.SystemInfo reads `.ipv4` and
// `.mac` off it. The accurate shape is declared here and cast at the boundary;
// correcting MacAddressMap belongs in the protocol submodule.
interface MacAddressEntry {
  ipv4?: string;
  ipv6?: string;
  mac?: string;
}

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
      const results: Record<string, MacAddressEntry> = {};

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

      return [null, results as unknown as MacAddressMap];
    } catch (err) {
      return [err, null];
    }
  },

  async GetVitals(): Promise<Vitals> {
    const TotalMemory = os.totalmem();
    const FreeMemory = os.freemem();
    const Uptime = os.uptime();

    return {
      CPU: {
        UsagePercentage: CPUUsage,
      },
      Ram: {
        Total: TotalMemory,
        Used: TotalMemory - FreeMemory,
        // Transmitted as a string by design — see RamVitals in @showtrak/protocol.
        UsagePercentage: (((TotalMemory - FreeMemory) / TotalMemory) * 100).toFixed(2),
      },
      Uptime: {
        Formatted: FormatUptime(Uptime),
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
