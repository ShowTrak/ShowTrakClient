import type { NetworkInterface } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as OS } from '../OS';

const Logger = CreateLogger('NetworkMonitor');

let _timer: NodeJS.Timeout | null = null;
let _lastSignature: string | null = null;
let _socket: ShowTrakSocket | null = null;
let _inFlight = false;

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
    const norm = normalize(interfaces);
    const sig = signature(norm);
    if (sig !== _lastSignature) {
      _lastSignature = sig;
      if (_socket && _socket.connected) {
        try {
          _socket.emit('NetworkInterfaces', norm);
          Logger.debug(`Emitted NetworkInterfaces (${norm.length} interfaces)`);
        } catch (e) {
          Logger.error('Emit NetworkInterfaces failed', e);
        }
      }
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
    await sampleAndMaybeEmit();
    // Check every 10 seconds; only emits on change
    _timer = setInterval(sampleAndMaybeEmit, 10000);
    Logger.log('NetworkMonitor started');
  },

  async Stop(): Promise<void> {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _socket = null;
    _inFlight = false;
    Logger.log('NetworkMonitor stopped');
  },
};
