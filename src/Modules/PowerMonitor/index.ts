import type { BatteryStatus, CollectorStatus, PowerStatusSnapshot } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';
import { CreateListenerSet, GetPowerMonitor } from './electron-power';
import { CollectPower, DisposePowerSamplers, type PowerCollection } from './samplers';
import { CreateSnapshotReporter, SignatureChange, type SampleOptions } from '../SnapshotReporter';

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
    if (Reporter.IsActive())
      void Reporter.Sample({ ForceEmit: true, Queue: true, ForceRead: true });
  },
  // A power-source change is also the moment a battery (a UPS) may have
  // appeared, so these read the platform even if it last said "no battery".
  'on-ac': () => {
    if (Reporter.IsActive()) void Reporter.Sample({ Queue: true, ForceRead: true });
  },
  'on-battery': () => {
    if (Reporter.IsActive()) void Reporter.Sample({ Queue: true, ForceRead: true });
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

interface PowerRead {
  /** Read the platform even if it recently reported no battery. */
  ForceRead: boolean;
}

/** Report the last reading with fresh timestamps, without sampling. */
function EmitImmediately(): void {
  if (!Reporter.IsConnected()) return;
  const OnBattery = ElectronOnBattery();
  const Last = Reporter.LastSnapshot();
  const Snapshot: PowerStatusSnapshot = Last
    ? {
        ...Last,
        SampledAt: Date.now(),
        OnBattery: OnBattery ?? Last.OnBattery,
        ...Timestamps(),
      }
    : {
        SampledAt: Date.now(),
        Status: { State: 'unknown', Message: null, Platform: process.platform, Backend: null },
        Battery: null,
        OnBattery,
        ...Timestamps(),
      };
  try {
    Reporter.Report(Snapshot);
  } catch (error) {
    Logger.warn(`Could not report power state: ${ErrorText(error, 'unknown error')}`);
  }
}

const Reporter = CreateSnapshotReporter({
  Noun: 'Power',
  Logger,
  PollIntervalMs: POLL_INTERVAL_MS,
  KeepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  Read: (Options: SampleOptions<PowerRead>) =>
    CollectPower(process.platform, { Force: !!Options.ForceRead }),
  Build(Collection: PowerCollection) {
    if (!Collection.Ok && !Collection.Unsupported) {
      Logger.warn(`Power sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
    }
    return BuildSnapshot(Collection, ElectronOnBattery(), Timestamps());
  },
  Change: SignatureChange(SnapshotSignature),
  Emit(Socket, Snapshot) {
    Socket.emit('PowerStatus', Snapshot);
  },
  // EmitImmediately reports from it, and a suspend can come before a new
  // connection's first sample has finished.
  KeepLastSnapshot: true,
});

export const Manager = {
  /** Begin reporting on a freshly connected socket. Resolves after the first report. */
  Start(Socket: ShowTrakSocket | null): Promise<void> {
    // Idempotent: a reconnect or a service restart never stacks a second set.
    Listeners.Attach();
    // The server replaces its state from the first report of a connection, so it
    // goes out even if nothing changed since the last one.
    return Reporter.Start(Socket);
  },

  /**
   * Stop reporting (the connection dropped). The powerMonitor listeners stay
   * attached so a sleep or wake while disconnected is still timestamped.
   */
  Stop(): void {
    Reporter.Stop();
    DisposePowerSamplers();
  },

  /** Full teardown (service restart, quit): also detach from powerMonitor. */
  Dispose(): void {
    Manager.Stop();
    Listeners.Detach();
  },

  GetLastSnapshot(): PowerStatusSnapshot | null {
    return Reporter.LastSnapshot();
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
    Reporter.ForgetLastSnapshot();
  },
};
