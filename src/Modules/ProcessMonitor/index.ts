import type { RunningApplicationItem } from '@showtrak/protocol';
import type { ProcessMonitorState, ProcessMonitorStatus } from '../../types/client';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as ServerCapabilities } from '../ServerCapabilities';
import { DiffByKey, IsEmptyDiff } from '../Utils';
import { collectRunningApplications, disposeSamplers } from './samplers';

const Logger = CreateLogger('ProcessMonitor');

// How often the application list is sampled. The samplers in ./samplers.ts cost
// single-digit milliseconds per call, which is what makes this affordable — the
// previous macOS sampler alone took ~1.2 seconds per sample and could not have
// been run at this rate.
const POLL_INTERVAL_MS = 3000;
// A sample that found no change still reports in at roughly the old poll rate.
// The server appends a monitoring-history point per received event, so going
// silent between changes would thin the history to the resync interval.
const KEEPALIVE_INTERVAL_MS = 20000;
// Unconditional full snapshot, so a server that missed an emit (or restarted)
// converges within a minute without waiting for the next application change.
const FULL_RESYNC_INTERVAL_MS = 60000;
const MAX_REPORTED_APPLICATIONS = 64;

/** The states setStatus is ever called with; anything else degrades to unknown. */
const KNOWN_STATES: ReadonlySet<string> = new Set<ProcessMonitorState>([
  'unknown',
  'ok',
  'error',
  'permission_denied',
]);

let monitorInterval: NodeJS.Timeout | null = null;
let activeSocket: ShowTrakSocket | null = null;
let lastSignature: string | null = null;
let lastStatusSignature: string | null = null;
// Timestamps of the last emit of any kind, and of the last emit that carried a
// full item list. Both drive the cadence rules described at the constants above.
let lastEmitAt = 0;
let lastFullEmitAt = 0;
// Last item list actually reported, and so the baseline the next delta is
// computed against.
let lastItems: RunningApplicationItem[] = [];
let currentStatus: ProcessMonitorStatus = {
  State: 'unknown',
  Message: null,
  Platform: process.platform,
};

const IGNORED_APPLICATION_NAMES = new Set([
  'bash',
  'cmd',
  'conhost',
  'dbus-daemon',
  'electron',
  'explorer',
  'fish',
  'gnome-shell',
  'init',
  'loginwindow',
  'node',
  'osascript',
  'powershell',
  'powershell_ise',
  'showtrak client',
  'showtrak-client',
  'sh',
  'systemd',
  'terminal',
  'windowserver',
  'zsh',
]);

function clearMonitorInterval(): void {
  if (!monitorInterval) return;
  clearInterval(monitorInterval);
  monitorInterval = null;
}

interface NormalizedNames {
  Items: RunningApplicationItem[];
  TotalCount: number;
  Truncated: boolean;
}

function normalizeNames(names: unknown): NormalizedNames {
  const counts = new Map<string, RunningApplicationItem>();
  for (const rawName of Array.isArray(names) ? names : []) {
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (IGNORED_APPLICATION_NAMES.has(key)) continue;
    const current = counts.get(key);
    if (current) {
      current.Count += 1;
      continue;
    }
    counts.set(key, {
      Name: name,
      Count: 1,
    });
  }

  const items = Array.from(counts.values()).sort((left, right) => {
    if (right.Count !== left.Count) return right.Count - left.Count;
    return left.Name.localeCompare(right.Name);
  });

  const totalCount = items.length;
  const limitedItems = items.slice(0, MAX_REPORTED_APPLICATIONS);
  return {
    Items: limitedItems,
    TotalCount: totalCount,
    Truncated: totalCount > limitedItems.length,
  };
}

interface ApplicationsSnapshot {
  SampledAt: number;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationItem[];
  Signature: string;
}

function buildSnapshot(names: unknown): ApplicationsSnapshot {
  const normalized = normalizeNames(names);
  const signature = normalized.Items.map((item) => `${item.Name}:${item.Count}`).join('|');
  return {
    SampledAt: Date.now(),
    TotalCount: normalized.TotalCount,
    Truncated: normalized.Truncated,
    Items: normalized.Items,
    Signature: signature,
  };
}

function normalizeStatus(status: { State?: unknown; Message?: unknown }): ProcessMonitorStatus {
  const rawState =
    typeof status?.State === 'string' && status.State.trim().length > 0
      ? status.State.trim().toLowerCase()
      : 'unknown';
  // Every internal call site passes one of KNOWN_STATES, so this narrowing is
  // a no-op at runtime; it exists so the state stays a closed union.
  const state = (KNOWN_STATES.has(rawState) ? rawState : 'unknown') as ProcessMonitorState;
  const message =
    typeof status?.Message === 'string' && status.Message.trim().length > 0
      ? status.Message.trim()
      : null;
  return {
    State: state,
    Message: message,
    Platform: process.platform,
  };
}

/** Returns whether the status actually changed, so a caller can force an emit. */
function setStatus(status: { State?: unknown; Message?: unknown }): boolean {
  const next = normalizeStatus(status);
  const signature = `${next.State}|${next.Message || ''}|${next.Platform}`;
  if (lastStatusSignature === signature) return false;
  lastStatusSignature = signature;
  currentStatus = next;
  BroadcastManager.emit('ProcessMonitorStatus', currentStatus);
  return true;
}

function classifyCollectionError(error: unknown): { State: ProcessMonitorState; Message: string } {
  const message = String(
    error && (error as Error).message
      ? (error as Error).message
      : error || 'Unknown process monitor error'
  );
  if (/-1743|not authorized|not permitted|automation|apple events|system events/i.test(message)) {
    return {
      State: 'permission_denied',
      Message:
        'macOS denied access to System Events. Allow automation permission for ShowTrak Client in System Settings > Privacy & Security > Automation.',
    };
  }
  return {
    State: 'error',
    Message: message,
  };
}

async function emitSnapshot(force = false): Promise<void> {
  if (!activeSocket || !activeSocket.connected) return;
  const [error, names] = await collectRunningApplications();
  if (error) {
    Logger.warn('Failed to collect running applications');
    const status = classifyCollectionError(error);
    setStatus(status);
    lastEmitAt = Date.now();
    lastFullEmitAt = lastEmitAt;
    activeSocket.emit('RunningApplications', {
      SampledAt: lastEmitAt,
      TotalCount: 0,
      Truncated: false,
      Items: [],
      Status: currentStatus,
    });
    return;
  }
  const statusChanged = setStatus({ State: 'ok', Message: null });
  const snapshot = buildSnapshot(names);
  const changed = snapshot.Signature !== lastSignature;
  const now = Date.now();

  if (!force && !changed && !statusChanged) {
    // Nothing moved. Report in anyway when a resync or a keepalive is due; stay
    // quiet otherwise, so a 3-second poll does not cost 7x today's socket
    // traffic for every client on the rig.
    if (now - lastFullEmitAt >= FULL_RESYNC_INTERVAL_MS) {
      lastEmitAt = now;
      lastFullEmitAt = now;
      activeSocket.emit('RunningApplications', {
        SampledAt: snapshot.SampledAt,
        TotalCount: snapshot.TotalCount,
        Truncated: snapshot.Truncated,
        Items: snapshot.Items,
        Status: currentStatus,
      });
      return;
    }
    if (now - lastEmitAt >= KEEPALIVE_INTERVAL_MS) {
      lastEmitAt = now;
      activeSocket.emit('RunningApplications', {
        SampledAt: now,
        TotalCount: snapshot.TotalCount,
        Truncated: snapshot.Truncated,
        Items: [],
        Status: currentStatus,
        NoChanges: true,
      });
    }
    return;
  }

  // Report the change only, when the server understands one and this is not the
  // periodic resync (which must carry the full list, since that is what the
  // server replaces its state from).
  if (!force && changed && ServerCapabilities.SupportsDeltas()) {
    const delta = DiffByKey(
      lastItems,
      snapshot.Items,
      (item) => (item && item.Name ? item.Name.toLowerCase() : null),
      (item) => `${item.Name}:${item.Count}`
    );
    if (!IsEmptyDiff(delta)) {
      lastSignature = snapshot.Signature;
      lastItems = snapshot.Items;
      lastEmitAt = now;
      activeSocket.emit('ApplicationDelta', {
        Started: delta.Added,
        Stopped: delta.Removed,
        Changed: delta.Changed,
        SampledAt: snapshot.SampledAt,
        TotalCount: snapshot.TotalCount,
        Truncated: snapshot.Truncated,
        Status: currentStatus,
      });
      return;
    }
  }

  lastSignature = snapshot.Signature;
  lastItems = snapshot.Items;
  lastEmitAt = now;
  lastFullEmitAt = now;
  activeSocket.emit('RunningApplications', {
    SampledAt: snapshot.SampledAt,
    TotalCount: snapshot.TotalCount,
    Truncated: snapshot.Truncated,
    Items: snapshot.Items,
    Status: currentStatus,
  });
}

// A sample that overruns the poll interval must not queue another behind it.
// At the old 20-second interval an overlap was near-impossible; at 3 seconds a
// slow Windows fallback (or a wedged host burning its timeout) would otherwise
// stack samples until the machine gave out.
let sampleInFlight = false;

async function pollOnce(force = false): Promise<void> {
  if (sampleInFlight) return;
  sampleInFlight = true;
  try {
    await emitSnapshot(force);
  } finally {
    sampleInFlight = false;
  }
}

export const Manager = {
  async Start(Socket: ShowTrakSocket | null): Promise<void> {
    activeSocket = Socket || null;
    clearMonitorInterval();
    lastSignature = null;
    lastEmitAt = 0;
    lastFullEmitAt = 0;
    lastItems = [];
    await pollOnce(true);
    monitorInterval = setInterval(() => {
      pollOnce(false).catch(() => {
        Logger.warn('Running applications poll failed');
      });
    }, POLL_INTERVAL_MS);
  },

  async Stop(): Promise<void> {
    clearMonitorInterval();
    activeSocket = null;
    lastSignature = null;
    lastEmitAt = 0;
    lastFullEmitAt = 0;
    lastItems = [];
    sampleInFlight = false;
    disposeSamplers();
    setStatus({ State: 'unknown', Message: null });
  },

  GetStatus(): ProcessMonitorStatus {
    return { ...currentStatus };
  },
};

export const _constants = {
  POLL_INTERVAL_MS,
  KEEPALIVE_INTERVAL_MS,
  FULL_RESYNC_INTERVAL_MS,
};
