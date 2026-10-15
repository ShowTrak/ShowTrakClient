import type {
  RunningApplicationItem,
  RunningApplicationsCapabilities,
  RunningApplicationsSnapshot,
} from '@showtrak/protocol';
import type { ProcessMonitorState, ProcessMonitorStatus } from '../../types/client';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as ServerCapabilities } from '../ServerCapabilities';
import { DiffByKey, IsEmptyDiff } from '../Utils';
import {
  collectRunningApplications,
  disposeSamplers,
  type ApplicationProcess,
  type ApplicationSample,
} from './samplers';

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
// Foreground and capabilities as last reported. Kept apart from the item
// signature because they change without the application set changing — focus
// moves far more often than anything starts or quits — and the delta path has
// to tell "only the focus moved" from "the list changed".
let lastExtrasSignature: string | null = null;
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
  /** Lower-cased name -> the Name its entry is reported under, before truncation. */
  NamesByKey: Map<string, string>;
}

/**
 * Fold a sampler's processes into one entry per application.
 *
 * `Responding` is only set when the platform can tell (`withResponding`); an
 * application is reported as not responding when ANY of its instances is hung,
 * since one frozen window is the fault an operator needs to see, and as null
 * (unknown) when none is hung but at least one could not be read.
 */
function normalizeNames(processes: unknown, withResponding = false): NormalizedNames {
  const counts = new Map<string, RunningApplicationItem>();
  const namesByKey = new Map<string, string>();
  for (const raw of Array.isArray(processes) ? processes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as ApplicationProcess;
    if (typeof entry.Name !== 'string') continue;
    const name = entry.Name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!namesByKey.has(key)) namesByKey.set(key, name);
    if (IGNORED_APPLICATION_NAMES.has(key)) continue;
    const responding =
      typeof entry.Responding === 'boolean' ? entry.Responding : (null as boolean | null);
    const current = counts.get(key);
    if (current) {
      current.Count += 1;
      if (withResponding && current.Responding !== false) {
        current.Responding = responding === false ? false : current.Responding && responding;
      }
      continue;
    }
    counts.set(key, {
      Name: name,
      Count: 1,
      ...(withResponding ? { Responding: responding } : {}),
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
    NamesByKey: namesByKey,
  };
}

/**
 * The focused application's name, spelled the way its `Items` entry is, so the
 * server can match the two directly. An application filtered out of the list (a
 * shell, Explorer, the desktop, ShowTrak itself) is still named: it really does
 * hold the focus, and that is exactly what "the show app is not in front" needs
 * to know.
 */
export function NormalizeForeground(
  raw: unknown,
  namesByKey: ReadonlyMap<string, string>
): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name) return null;
  return namesByKey.get(name.toLowerCase()) ?? name;
}

interface ApplicationsSnapshot {
  SampledAt: number;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationItem[];
  /** Absent when the platform cannot report it, as on the wire. */
  Foreground?: string | null;
  Capabilities: RunningApplicationsCapabilities;
  /** The item list's change signature. */
  Signature: string;
  /** Foreground + capabilities, which change independently of the list. */
  ExtrasSignature: string;
}

/** What identifies an item for change detection: a Responding flip is a change. */
function itemSignature(item: RunningApplicationItem): string {
  const responding = item.Responding === undefined ? '' : `:${String(item.Responding)}`;
  return `${item.Name}:${item.Count}${responding}`;
}

function buildSnapshot(sample: ApplicationSample | null | undefined): ApplicationsSnapshot {
  const capabilities: RunningApplicationsCapabilities = {
    Responding: !!sample?.Capabilities?.Responding,
    Foreground: !!sample?.Capabilities?.Foreground,
  };
  const normalized = normalizeNames(sample?.Processes, capabilities.Responding);
  const signature = normalized.Items.map(itemSignature).join('|');
  const foreground = capabilities.Foreground
    ? NormalizeForeground(sample?.Foreground, normalized.NamesByKey)
    : undefined;
  return {
    SampledAt: Date.now(),
    TotalCount: normalized.TotalCount,
    Truncated: normalized.Truncated,
    Items: normalized.Items,
    ...(foreground !== undefined ? { Foreground: foreground } : {}),
    Capabilities: capabilities,
    Signature: signature,
    ExtrasSignature: JSON.stringify([
      foreground === undefined ? '\u0000absent' : foreground,
      capabilities.Responding,
      capabilities.Foreground,
    ]),
  };
}

/** The wire fields every report carries about focus and what is reportable. */
function extrasOf(
  snapshot: ApplicationsSnapshot
): Pick<RunningApplicationsSnapshot, 'Foreground' | 'Capabilities'> {
  return {
    ...(snapshot.Foreground !== undefined ? { Foreground: snapshot.Foreground } : {}),
    Capabilities: snapshot.Capabilities,
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
  const [error, sample] = await collectRunningApplications();
  if (error || !sample) {
    Logger.warn('Failed to collect running applications');
    const status = classifyCollectionError(error);
    setStatus(status);
    lastEmitAt = Date.now();
    lastFullEmitAt = lastEmitAt;
    // Foreground and capabilities are left out: nothing was read, and the status
    // says why. The next good sample differs from this, so it is reported.
    lastExtrasSignature = null;
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
  const snapshot = buildSnapshot(sample);
  const itemsChanged = snapshot.Signature !== lastSignature;
  // A hung application or a focus change is news the moment it is seen, so both
  // count as a change here; the keepalive below never stands in for them.
  const extrasChanged = snapshot.ExtrasSignature !== lastExtrasSignature;
  const changed = itemsChanged || extrasChanged;
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
        ...extrasOf(snapshot),
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
        ...extrasOf(snapshot),
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
      itemSignature
    );
    // A focus change with the list untouched is still a delta: an empty one,
    // carrying the new Foreground, which every delta does.
    if (!IsEmptyDiff(delta) || !itemsChanged) {
      lastSignature = snapshot.Signature;
      lastExtrasSignature = snapshot.ExtrasSignature;
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
        ...extrasOf(snapshot),
      });
      return;
    }
  }

  lastSignature = snapshot.Signature;
  lastExtrasSignature = snapshot.ExtrasSignature;
  lastItems = snapshot.Items;
  lastEmitAt = now;
  lastFullEmitAt = now;
  activeSocket.emit('RunningApplications', {
    SampledAt: snapshot.SampledAt,
    TotalCount: snapshot.TotalCount,
    Truncated: snapshot.Truncated,
    Items: snapshot.Items,
    Status: currentStatus,
    ...extrasOf(snapshot),
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
    lastExtrasSignature = null;
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
    lastExtrasSignature = null;
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
