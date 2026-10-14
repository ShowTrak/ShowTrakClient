// Default gateways (routers), per interface, read from the OS routing table.
//
// `os.networkInterfaces()` says nothing about routes, so this is its own read:
// `/proc/net/route` on Linux (a file — no process), `netstat -rn` on macOS and
// `route print` on Windows. IPv4 only: a router on a show network is an IPv4
// thing, and IPv6 default routes are link-local addresses no operator types.
//
// The parsers are pure and exported for tests; ReadGateways picks one by
// platform. A failed read is an error, never an empty map — "I could not read
// the routing table" must not be reported as "no interface has a router".
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { NetworkInterface } from '@showtrak/protocol';
import type { Result } from '../../types/client';

/** Interface name -> IPv4 default gateway. Interfaces without one are absent. */
export type GatewayMap = Map<string, string>;

const COMMAND_TIMEOUT_MS = 5000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function IsIPv4(Value: string): boolean {
  const Match = IPV4.exec(Value);
  return !!Match && Match.slice(1).every((Octet) => Number(Octet) <= 255);
}

/**
 * `/proc/net/route`: tab-separated, addresses as host-order hex. A default route
 * has Destination and Mask 00000000 and the RTF_GATEWAY flag; the lowest metric
 * wins when an interface has several.
 */
export function ParseLinuxRouteTable(Text: string): GatewayMap {
  const Best = new Map<string, { Gateway: string; Metric: number }>();
  const Lines = String(Text || '').split('\n');
  const Header = (Lines[0] || '').trim().split(/\s+/);
  const Column = (Name: string) => Header.indexOf(Name);
  const [IfaceCol, DestCol, GatewayCol, FlagsCol, MetricCol, MaskCol] = [
    Column('Iface'),
    Column('Destination'),
    Column('Gateway'),
    Column('Flags'),
    Column('Metric'),
    Column('Mask'),
  ];
  if ([IfaceCol, DestCol, GatewayCol, FlagsCol].some((Index) => Index === -1)) return new Map();
  for (const Line of Lines.slice(1)) {
    const Fields = Line.trim().split(/\s+/);
    if (Fields.length <= GatewayCol) continue;
    if (Fields[DestCol] !== '00000000') continue;
    if (MaskCol !== -1 && Fields[MaskCol] !== undefined && Fields[MaskCol] !== '00000000') continue;
    const Flags = parseInt(Fields[FlagsCol] || '0', 16);
    if (!(Flags & 0x2)) continue; // RTF_GATEWAY
    const Hex = Fields[GatewayCol] || '';
    if (!/^[0-9a-f]{8}$/i.test(Hex)) continue;
    // Host byte order, little-endian on every platform ShowTrak ships for.
    const Gateway = [6, 4, 2, 0].map((At) => parseInt(Hex.slice(At, At + 2), 16)).join('.');
    if (Gateway === '0.0.0.0') continue;
    const Iface = Fields[IfaceCol] || '';
    const Metric = MetricCol !== -1 ? Number(Fields[MetricCol]) || 0 : 0;
    const Current = Best.get(Iface);
    if (!Current || Metric < Current.Metric) Best.set(Iface, { Gateway, Metric });
  }
  return new Map(Array.from(Best, ([Iface, Entry]) => [Iface, Entry.Gateway]));
}

/**
 * `netstat -rn -f inet` on macOS. Columns are found from the header, since older
 * releases print Refs/Use between Flags and Netif. Routes are listed in order of
 * preference, so an interface's first default route is its router.
 */
export function ParseMacNetstat(Text: string): GatewayMap {
  const Gateways: GatewayMap = new Map();
  let GatewayCol = -1;
  let NetifCol = -1;
  for (const Line of String(Text || '').split('\n')) {
    const Fields = Line.trim().split(/\s+/);
    if (Fields[0] === 'Destination') {
      GatewayCol = Fields.indexOf('Gateway');
      NetifCol = Fields.indexOf('Netif');
      continue;
    }
    if (Fields[0] !== 'default' || GatewayCol === -1 || NetifCol === -1) continue;
    const Gateway = Fields[GatewayCol] || '';
    const Iface = Fields[NetifCol] || '';
    if (!Iface || !IsIPv4(Gateway) || Gateways.has(Iface)) continue;
    Gateways.set(Iface, Gateway);
  }
  return Gateways;
}

/**
 * `route print -4` on Windows. Its Interface column is the interface's own IPv4
 * address, not its name, so the name comes from the interface list. Routes that
 * are "On-link" (in whatever language) have no router and are skipped, as are
 * the persistent-route lines, which have no interface column.
 */
export function ParseWindowsRoutePrint(Text: string, Interfaces: NetworkInterface[]): GatewayMap {
  const NameByAddress = new Map<string, string>();
  for (const Iface of Array.isArray(Interfaces) ? Interfaces : []) {
    for (const Address of Array.isArray(Iface.addresses) ? Iface.addresses : []) {
      if (typeof Address.address === 'string' && IsIPv4(Address.address)) {
        NameByAddress.set(Address.address, Iface.name);
      }
    }
  }
  const Best = new Map<string, { Gateway: string; Metric: number }>();
  for (const Line of String(Text || '').split(/\r?\n/)) {
    const Match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(Line);
    if (!Match) continue;
    const [, Gateway = '', LocalAddress = '', MetricText = '0'] = Match;
    if (!IsIPv4(Gateway)) continue;
    const Iface = NameByAddress.get(LocalAddress);
    if (!Iface) continue;
    const Metric = Number(MetricText) || 0;
    const Current = Best.get(Iface);
    if (!Current || Metric < Current.Metric) Best.set(Iface, { Gateway, Metric });
  }
  return new Map(Array.from(Best, ([Iface, Entry]) => [Iface, Entry.Gateway]));
}

function RunCommand(Command: string, Args: string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile(
      Command,
      Args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (Error_, Stdout) => {
        if (Error_) return resolve([Error_, null]);
        return resolve([null, String(Stdout || '')]);
      }
    );
  });
}

async function ReadFile(Path: string): Promise<Result<string>> {
  try {
    return [null, await fs.readFile(Path, 'utf8')];
  } catch (Error_) {
    return [Error_, null];
  }
}

export interface GatewayReaders {
  RunCommand: (Command: string, Args: string[]) => Promise<Result<string>>;
  ReadFile: (Path: string) => Promise<Result<string>>;
}

const DEFAULT_READERS: GatewayReaders = { RunCommand, ReadFile };

/** Read this machine's default gateways. `Interfaces` names Windows' routes. */
export async function ReadGateways(
  Interfaces: NetworkInterface[],
  Platform: string = process.platform,
  Readers: GatewayReaders = DEFAULT_READERS
): Promise<Result<GatewayMap>> {
  if (Platform === 'linux') {
    const [Error_, Text] = await Readers.ReadFile('/proc/net/route');
    return Error_ || Text === null
      ? [Error_ || new Error('No route table'), null]
      : [null, ParseLinuxRouteTable(Text)];
  }
  if (Platform === 'darwin') {
    const [Error_, Text] = await Readers.RunCommand('netstat', ['-rn', '-f', 'inet']);
    return Error_ || Text === null
      ? [Error_ || new Error('No route table'), null]
      : [null, ParseMacNetstat(Text)];
  }
  if (Platform === 'win32') {
    const [Error_, Text] = await Readers.RunCommand('route', ['print', '-4']);
    return Error_ || Text === null
      ? [Error_ || new Error('No route table'), null]
      : [null, ParseWindowsRoutePrint(Text, Interfaces)];
  }
  return [new Error(`Reading routes is not available on ${Platform}`), null];
}
