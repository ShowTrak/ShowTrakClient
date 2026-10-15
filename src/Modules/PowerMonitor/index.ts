import type { BatteryStatus, CollectorStatus, PowerStatusSnapshot } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';
import { CreateListenerSet, GetPowerMonitor } from './electron-power';
import { CollectPower, DisposePowerSamplers, type PowerCollection } from './samplers';

const Logger = CreateLogger('PowerMonitor');

// Battery charge moves by a percent every few minutes at most, and mains/battery
// switches arrive as Electron events the moment they happen, so the poll only has
// to catch the slow drift of the charge.
const POLL_INTERVAL_MS = 30000;
// An unchanged snapshot is still re-sent at this interval, so a server that
// missed one (or restarted) converges without waiting for the battery to move.
const KEEPALIVE_INTERVAL_MS = 60000;
// Windows and Linux re-estimate the runtime on every read, and it wanders by
// minutes with the load. Reporting every wobble would turn a laptop on battery
// into a constant stream of "changes", so the change check compares it in
// buckets of this many minutes; the value sent is still the exact estimate.
const TIME_REMAINING_BUCKET_MINUTES = 5;

let activeSocket: ShowTrakSocket | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastSignature: string | null = null;
let lastEmitAt = 0;
let lastSnapshot: PowerStatusSnapshot | null = null;
let inFlight: Promise<void> | null = null;
// Bumped on every Start/Stop, so a sample that was already running when the
// connection changed can tell its result belongs to a session that has ended.
let generation = 0;

// When the machine last slept and woke, for the life of this process. These are
// deliberately NOT reset when the connection drops: sleeping is usually what
// drops it, and the server learns of the wake by diffing these values in the
// first snapshot after the client reconnects.
let lastSuspendAt: number | null = null;
let lastResumeAt: number | null = null;

const Listeners = CreateListenerSet({
  suspend: () => {
    lastSuspendAt = Date.now();
    Logger.log('System is suspending');
    // Best effort: the socket may already be on its way down, and the process
    // is about to be frozen, so this reports what is known right now rather than
    // starting a sample that would never finish.
    EmitImmediately();
  },
  resume: () => {
    lastResumeAt = Date.now();
    Logger.log('System resumed');
    if (activeSocket) void RunSample({ ForceEmit: true, Queue: true });
  },
  'on-ac': () => {
    if (activeSocket) void RunSample({ Queue: true });
  },
  'on-battery': () => {
    if (activeSocket) void RunSample({ Queue: true });
  },
});

/** Electron's answer to "on battery?", which it has for every platform. */
function ElectronOnBattery(): boolean | null {
  const Monitor = GetPowerMonitor();
  if (!Monitor || typeof Monitor.isOnBatteryPower !== 'function') return null;
  try {
    return !!Monitor.isOnBatteryPower();
  } catch (_error) {
    return null;
  }
}

export interface PowerTimestamps {
  LastSuspendAt: number | null;
  LastResumeAt: number | null;
}

/**
 * A snapshot from a platform reading, Electron's on-battery verdict and the
 * sleep timestamps. Electron's verdict wins where it has one; the platform's own
 * reading stands in where it does not (outside Electron, or before it is ready).
 */
export function BuildSnapshot(
  Collection: PowerCollection,
  ElectronOnBatteryValue: boolean | null,
  Timestamps: PowerTimestamps,
  Platform: string = process.platform,
  Now: number = Date.now()
): PowerStatusSnapshot {
  if (Collection.Ok) {
    const OnBattery = ElectronOnBatteryValue ?? Collection.Reading.OnBattery;
    let Battery: BatteryStatus | null = Collection.Reading.Battery;
    // Runtime left is only meaningful while draining the battery.
    if (Battery && (OnBattery === false || Battery.Charging === true)) {
      Battery = { ...Battery, TimeRemainingMinutes: null };
    }
    return {
      SampledAt: Now,
      Status: { State: 'ok', Message: null, Platform, Backend: Collection.Reading.Backend },
      Battery,
      OnBattery,
      ...Timestamps,
    };
  }

  let Status: CollectorStatus;
  if (Collection.Unsupported && ElectronOnBatteryValue === null) {
    Status = {
      State: 'unsupported',
      Message: ErrorText(Collection.Error, 'Power status is not available on this platform'),
      Platform,
      Backend: null,
    };
  } else if (Collection.Unsupported) {
    // No battery reader for this platform, but Electron still knows whether the
    // machine is on mains — which is something, so not "unsupported".
    Status = {
      State: 'ok',
      Message: 'Battery details are not available on this platform',
      Platform,
      Backend: 'electron',
    };
  } else {
    Status = {
      State: 'error',
      Message: ErrorText(Collection.Error, 'Power status could not be read'),
      Platform,
      Backend: null,
    };
  }
  return {
    SampledAt: Now,
    Status,
    Battery: null,
    OnBattery: ElectronOnBatteryValue,
    ...Timestamps,
  };
}

/**
 * Everything that matters in a snapshot, so only a real change is reported
 * early. The runtime estimate is bucketed (see TIME_REMAINING_BUCKET_MINUTES).
 */
export function SnapshotSignature(Snapshot: PowerStatusSnapshot): string {
  const Battery = Snapshot.Battery;
  const Remaining =
    Battery && Battery.TimeRemainingMinutes !== null
      ? Math.round(Battery.TimeRemainingMinutes / TIME_REMAINING_BUCKET_MINUTES)
      : null;
  return JSON.stringify([
    Snapshot.Status.State,
    Snapshot.Status.Message,
    Snapshot.Status.Backend,
    Battery ? [Battery.Percent, Battery.Charging, Remaining] : null,
    Snapshot.OnBattery,
    Snapshot.LastSuspendAt,
    Snapshot.LastResumeAt,
  ]);
}

function Timestamps(): PowerTimestamps {
  return { LastSuspendAt: lastSuspendAt, LastResumeAt: lastResumeAt };
}

function Emit(Socket: ShowTrakSocket, Snapshot: PowerStatusSnapshot): void {
  lastSignature = SnapshotSignature(Snapshot);
  lastEmitAt = Date.now();
  Socket.emit('PowerStatus', Snapshot);
}

/** Report the last reading with fresh timestamps, without sampling. */
function EmitImmediately(): void {
  const Socket = activeSocket;
  if (!Socket || !Socket.connected) return;
  const OnBattery = ElectronOnBattery();
  const Snapshot: PowerStatusSnapshot = lastSnapshot
    ? {
        ...lastSnapshot,
        SampledAt: Date.now(),
        OnBattery: OnBattery ?? lastSnapshot.OnBattery,
        ...Timestamps(),
      }
    : {
        SampledAt: Date.now(),
        Status: { State: 'unknown', Message: null, Platform: process.platform, Backend: null },
        Battery: null,
        OnBattery,
        ...Timestamps(),
      };
  lastSnapshot = Snapshot;
  try {
    Emit(Socket, Snapshot);
  } catch (error) {
    Logger.warn(`Could not report power state: ${ErrorText(error, 'unknown error')}`);
  }
}

async function SampleAndReport(ForceEmit: boolean, Generation: number): Promise<void> {
  const Collection = await CollectPower();
  if (Generation !== generation) return;
  if (!Collection.Ok && !Collection.Unsupported) {
    Logger.warn(`Power sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
  }
  const Snapshot = BuildSnapshot(Collection, ElectronOnBattery(), Timestamps());
  lastSnapshot = Snapshot;

  const Socket = activeSocket;
  if (!Socket || !Socket.connected) return;
  const Signature = SnapshotSignature(Snapshot);
  const Now = Date.now();
  if (!ForceEmit && Signature === lastSignature && Now - lastEmitAt < KEEPALIVE_INTERVAL_MS) {
    return;
  }
  Emit(Socket, Snapshot);
}

interface SampleOptions {
  /** Report even if nothing changed. */
  ForceEmit?: boolean;
  /** Run a fresh sample after any in-flight one rather than sharing its result. */
  Queue?: boolean;
}

function RunSample(Options: SampleOptions = {}): Promise<void> {
  if (inFlight) {
    if (!Options.Queue) return inFlight;
    return inFlight.then(() => RunSample(Options));
  }
  const Current = SampleAndReport(!!Options.ForceEmit, generation)
    .catch((error: unknown) => {
      Logger.warn(`Power sample threw: ${ErrorText(error, 'unknown error')}`);
    })
    .finally(() => {
      if (inFlight === Current) inFlight = null;
    });
  inFlight = Current;
  return Current;
}

function ClearTimers(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export const Manager = {
  /** Begin reporting on a freshly connected socket. Resolves after the first report. */
  Start(Socket: ShowTrakSocket | null): Promise<void> {
    ClearTimers();
    generation += 1;
    activeSocket = Socket || null;
    lastSignature = null;
    lastEmitAt = 0;
    inFlight = null;
    // Idempotent: a reconnect or a service restart never stacks a second set.
    Listeners.Attach();
    pollTimer = setInterval(() => {
      void RunSample();
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    // The server replaces its state from the first report of a connection, so it
    // goes out even if nothing changed since the last one.
    return RunSample({ ForceEmit: true, Queue: true });
  },

  /**
   * Stop reporting (the connection dropped). The powerMonitor listeners stay
   * attached so a sleep or wake while disconnected is still timestamped.
   */
  Stop(): void {
    ClearTimers();
    generation += 1;
    activeSocket = null;
    lastSignature = null;
    lastEmitAt = 0;
    inFlight = null;
    DisposePowerSamplers();
  },

  /** Full teardown (service restart, quit): also detach from powerMonitor. */
  Dispose(): void {
    Manager.Stop();
    Listeners.Detach();
  },

  GetLastSnapshot(): PowerStatusSnapshot | null {
    return lastSnapshot;
  },
};

export const _constants = {
  POLL_INTERVAL_MS,
  KEEPALIVE_INTERVAL_MS,
  TIME_REMAINING_BUCKET_MINUTES,
};
export const _internal = {
  Listeners,
  /** Test seam: forget the process-lifetime sleep timestamps. */
  ResetTimestamps(): void {
    lastSuspendAt = null;
    lastResumeAt = null;
    lastSnapshot = null;
  },
};
