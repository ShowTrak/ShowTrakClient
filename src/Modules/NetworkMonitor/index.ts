import type { NetworkInterface } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as OS } from '../OS';
import { Manager as ServerCapabilities } from '../ServerCapabilities';
import { DiffByKey, IsEmptyDiff } from '../Utils';
import { ReadGateways, type GatewayMap } from './gateways';

const Logger = CreateLogger('NetworkMonitor');

// `os.networkInterfaces()` is a pure syscall — measured at 0.03ms median /
// 0.05ms p95 on a warm process, i.e. about 0.003% of one core at this rate.
// That is what makes a one-second poll the cheapest real-time signal the client
// has; the previous ten-second poll was conservative for no measured reason.
const POLL_INTERVAL_MS = 1000;
// Resend the full list on a fixed cadence even when nothing changed, so a server
// that missed an emit or restarted converges without waiting for the next NIC
// change (which on a fixed installation may never come).
const FULL_RESYNC_INTERVAL_MS = 60000;

let _timer: NodeJS.Timeout | null = null;
let _lastSignature: string | null = null;
let _socket: ShowTrakSocket | null = null;
let _inFlight = false;
let _lastEmitAt = 0;
// Last list actually reported, and so the baseline the next delta is computed
// against. Distinct from _lastSignature, which only answers "did anything move".
let _lastInterfaces: NetworkInterface[] = [];

// Routers come from the routing table, which costs a process on macOS and
// Windows — too much for the one-second poll. They are refreshed on their own
// slower cadence, and at once when the interface list changes, in the
// background: after the first, the poll never waits for one — it merges the
// latest it has.
const GATEWAY_REFRESH_INTERVAL_MS = 5000;
// Null until the routing table has been read once. Until then interfaces carry
// no `gateway` at all, which the server reads as "unknown" rather than "none";
// after a failed refresh the last good map is kept for the same reason.
let _gateways: GatewayMap | null = null;
let _gatewaysReadAt = 0;
let _gatewayRead: Promise<void> | null = null;
let _interfacesSignature: string | null = null;
let _gatewaysTried = false;

function normalize(interfaces: NetworkInterface[] | null | undefined): NetworkInterface[] {
  try {
    const arr = Array.isArray(interfaces) ? interfaces : [];
    const norm = arr.map((iface) => ({
      name: iface && iface.name ? String(iface.name) : 'unknown',
      addresses: Array.isArray(iface && iface.addresses)
        ? [...iface.addresses]
            .map((a) => ({
              family: a.family,
              address: a.address,
              netmask: a.netmask || null,
              cidr: a.cidr || null,
              mac: a.mac ? String(a.mac).toUpperCase() : null,
              internal: !!a.internal,
              scopeid: typeof a.scopeid !== 'undefined' ? a.scopeid : null,
            }))
            .sort((a, b) => {
              const fa = String(a.family || '');
              const fb = String(b.family || '');
              if (fa !== fb) return fa.localeCompare(fb);
              const aa = String(a.address || '');
              const ab = String(b.address || '');
              return aa.localeCompare(ab);
            })
        : [],
    }));
    // Sort interfaces by name for stable signature
    norm.sort((a, b) => a.name.localeCompare(b.name));
    return norm;
  } catch (e) {
    Logger.error('Failed to normalize interfaces', e);
    return [];
  }
}

function withGateways(norm: NetworkInterface[]): NetworkInterface[] {
  const gateways = _gateways;
  if (!gateways) return norm;
  return norm.map((iface) => ({ ...iface, gateway: gateways.get(iface.name) ?? null }));
}

function refreshGateways(interfaces: NetworkInterface[]): Promise<void> {
  if (_gatewayRead) return _gatewayRead;
  _gatewaysReadAt = Date.now();
  _gatewayRead = ReadGateways(interfaces)
    .then(([err, gateways]) => {
      if (err || !gateways) {
        Logger.debug('Reading default gateways failed', err);
        return;
      }
      _gateways = gateways;
    })
    .catch((e) => Logger.debug('Reading default gateways failed', e))
    .finally(() => {
      _gatewayRead = null;
    });
  return _gatewayRead;
}

function signature(norm: NetworkInterface[]): string {
  try {
    return JSON.stringify(norm);
  } catch {
    return '';
  }
}

async function sampleAndMaybeEmit(): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const [err, interfaces] = await OS.GetNetworkInterfaces();
    if (err) {
      Logger.error('GetNetworkInterfaces failed', err);
      return;
    }
    const bare = normalize(interfaces);
    const bareSig = signature(bare);
    if (
      bareSig !== _interfacesSignature ||
      Date.now() - _gatewaysReadAt >= GATEWAY_REFRESH_INTERVAL_MS
    ) {
      _interfacesSignature = bareSig;
      const read = refreshGateways(bare);
      // The very first read is waited for, so a fresh connection's first full
      // list carries its routers rather than following up a second later.
      if (!_gatewaysTried) {
        _gatewaysTried = true;
        await read;
      }
    }
    const norm = withGateways(bare);
    const sig = signature(norm);
    const changed = sig !== _lastSignature;
    const resyncDue = Date.now() - _lastEmitAt >= FULL_RESYNC_INTERVAL_MS;
    if (!changed && !resyncDue) return;
    if (!_socket || !_socket.connected) return;

    // A change goes out as a delta when the server understands one. The resync
    // always sends the full list: it is what the server replaces its state from,
    // and so what corrects any drift a delta left behind.
    if (changed && !resyncDue && ServerCapabilities.SupportsDeltas()) {
      const delta = DiffByKey(
        _lastInterfaces,
        norm,
        (iface) => (iface && iface.name ? iface.name : null),
        (iface) => signature([iface])
      );
      if (!IsEmptyDiff(delta)) {
        try {
          _socket.emit('NetworkInterfaceDelta', delta);
          _lastSignature = sig;
          _lastInterfaces = norm;
          Logger.debug(
            `Emitted NetworkInterfaceDelta (+${delta.Added.length} -${delta.Removed.length} ~${delta.Changed.length})`
          );
        } catch (e) {
          Logger.error('Emit NetworkInterfaceDelta failed', e);
        }
        return;
      }
    }

    try {
      _socket.emit('NetworkInterfaces', norm);
      _lastSignature = sig;
      _lastInterfaces = norm;
      _lastEmitAt = Date.now();
      Logger.debug(
        `Emitted NetworkInterfaces (${norm.length} interfaces, ${changed ? 'changed' : 'resync'})`
      );
    } catch (e) {
      Logger.error('Emit NetworkInterfaces failed', e);
    }
  } finally {
    _inFlight = false;
  }
}

export const Manager = {
  async Start(Socket: ShowTrakSocket): Promise<void> {
    _socket = Socket;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _lastSignature = null; // force first emit
    _lastEmitAt = 0;
    _lastInterfaces = [];
    await sampleAndMaybeEmit();
    // Sampled every second; emits on change, plus a periodic full resync.
    _timer = setInterval(sampleAndMaybeEmit, POLL_INTERVAL_MS);
    Logger.log('NetworkMonitor started');
  },

  async Stop(): Promise<void> {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _socket = null;
    _inFlight = false;
    _lastEmitAt = 0;
    _lastInterfaces = [];
    _interfacesSignature = null;
    Logger.log('NetworkMonitor stopped');
  },
};
