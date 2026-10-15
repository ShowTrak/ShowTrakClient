import type { CollectorStatus, TemperaturesSnapshot } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';
import { CreateListenerSet } from '../PowerMonitor/electron-power';
import {
  CollectTemperatures,
  DisposeTemperatureSamplers,
  type TemperatureCollection,
} from './samplers';

const Logger = CreateLogger('TemperatureMonitor');

// Temperatures move over tens of seconds, and the Windows read can touch four
// WMI providers, so this polls slowly; macOS's thermal pressure changes arrive
// as an Electron event the moment they happen.
const POLL_INTERVAL_MS = 30000;
// An unchanged snapshot is still re-sent at this interval, so a server that
// missed one (or restarted) converges without waiting for a sensor to move.
const KEEPALIVE_INTERVAL_MS = 60000;
// Sensors jitter by fractions of a degree on every read. A change smaller than
// this waits for the keepalive rather than being reported on its own.
const CHANGE_THRESHOLD_CELSIUS = 1;

// What an operator is told when nothing can be read, per platform. These are
// the "how do I get temperatures here" answers, not error text.
const UNSUPPORTED_MESSAGES: Record<string, string> = {
  win32:
    'No readable temperature sensors. Install LibreHardwareMonitor (running) to expose CPU/GPU temperatures.',
  linux: 'No readable temperature sensors. This machine exposes no hwmon or thermal-zone sensors.',
  darwin: 'macOS does not report temperatures or thermal pressure to this client.',
};
const MAC_THERMAL_STATE_MESSAGE = 'macOS reports thermal pressure only.';

let activeSocket: ShowTrakSocket | null = null;
let pollTimer: NodeJS.Timeout | null = null;
// The snapshot last actually reported: the change check compares sensor values
// against what the server has, so a slow drift still crosses the threshold.
let lastEmitted: TemperaturesSnapshot | null = null;
let lastEmitAt = 0;
let lastSnapshot: TemperaturesSnapshot | null = null;
let inFlight: Promise<void> | null = null;
// Bumped on every Start/Stop, so a sample that was already running when the
// connection changed can tell its result belongs to a session that has ended.
let generation = 0;

const Listeners = CreateListenerSet({
  // macOS only; Electron never fires it elsewhere.
  'thermal-state-change': () => {
    if (activeSocket) void RunSample({ Queue: true });
  },
});

export function BuildSnapshot(
  Collection: TemperatureCollection,
  Platform: string = process.platform,
  Now: number = Date.now()
): TemperaturesSnapshot {
  if (!Collection.Ok) {
    return {
      SampledAt: Now,
      Status: {
        State: 'error',
        Message: ErrorText(Collection.Error, 'Temperatures could not be read'),
        Platform,
        Backend: null,
      },
      Sensors: [],
      ThermalState: null,
    };
  }
  const { Sensors, ThermalState, Backend } = Collection.Reading;
  let Status: CollectorStatus;
  if (Sensors.length) {
    Status = { State: 'ok', Message: null, Platform, Backend };
  } else if (Platform === 'darwin' && ThermalState !== null) {
    Status = {
      State: 'ok',
      Message: MAC_THERMAL_STATE_MESSAGE,
      Platform,
      Backend: 'thermal-state',
    };
  } else {
    Status = {
      State: 'unsupported',
      Message:
        UNSUPPORTED_MESSAGES[Platform] || `Temperature monitoring is not available on ${Platform}`,
      Platform,
      Backend: null,
    };
  }
  return { SampledAt: Now, Status, Sensors, ThermalState };
}

/**
 * Whether `Next` is worth reporting before the keepalive: the status, the
 * thermal state or the set of sensors changed, or any sensor moved by at least
 * CHANGE_THRESHOLD_CELSIUS since it was last reported.
 */
export function HasMeaningfulChange(
  Previous: TemperaturesSnapshot | null,
  Next: TemperaturesSnapshot
): boolean {
  if (!Previous) return true;
  const StatusOf = (Snapshot: TemperaturesSnapshot) =>
    JSON.stringify([
      Snapshot.Status.State,
      Snapshot.Status.Message,
      Snapshot.Status.Backend,
      Snapshot.ThermalState,
    ]);
  if (StatusOf(Previous) !== StatusOf(Next)) return true;
  if (Previous.Sensors.length !== Next.Sensors.length) return true;
  const Before = new Map(Previous.Sensors.map((Sensor) => [Sensor.Name, Sensor]));
  for (const Sensor of Next.Sensors) {
    const Old = Before.get(Sensor.Name);
    if (!Old || Old.Kind !== Sensor.Kind) return true;
    if (Math.abs(Old.Celsius - Sensor.Celsius) >= CHANGE_THRESHOLD_CELSIUS) return true;
  }
  return false;
}

async function SampleAndReport(ForceEmit: boolean, Generation: number): Promise<void> {
  const Collection = await CollectTemperatures();
  if (Generation !== generation) return;
  if (!Collection.Ok) {
    Logger.warn(`Temperature sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
  }
  const Snapshot = BuildSnapshot(Collection);
  lastSnapshot = Snapshot;

  const Socket = activeSocket;
  if (!Socket || !Socket.connected) return;
  const Now = Date.now();
  if (
    !ForceEmit &&
    !HasMeaningfulChange(lastEmitted, Snapshot) &&
    Now - lastEmitAt < KEEPALIVE_INTERVAL_MS
  ) {
    return;
  }
  lastEmitted = Snapshot;
  lastEmitAt = Now;
  Socket.emit('Temperatures', Snapshot);
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
      Logger.warn(`Temperature sample threw: ${ErrorText(error, 'unknown error')}`);
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
    lastEmitted = null;
    lastEmitAt = 0;
    lastSnapshot = null;
    inFlight = null;
    // Idempotent: a reconnect or a service restart never stacks a second set.
    if (process.platform === 'darwin') Listeners.Attach();
    pollTimer = setInterval(() => {
      void RunSample();
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    // The server replaces its state from the first report of a connection.
    return RunSample({ ForceEmit: true, Queue: true });
  },

  /**
   * Stop reporting (the connection dropped). Unlike the power monitor's, the
   * thermal listener goes too: a thermal change nobody can be told about is not
   * worth remembering, and the next connection reads the current state anyway.
   */
  Stop(): void {
    ClearTimers();
    generation += 1;
    activeSocket = null;
    lastEmitted = null;
    lastEmitAt = 0;
    lastSnapshot = null;
    inFlight = null;
    Listeners.Detach();
    DisposeTemperatureSamplers();
  },

  /** Full teardown (service restart, quit). The same as Stop; kept for symmetry. */
  Dispose(): void {
    Manager.Stop();
  },

  GetLastSnapshot(): TemperaturesSnapshot | null {
    return lastSnapshot;
  },
};

export const _constants = { POLL_INTERVAL_MS, KEEPALIVE_INTERVAL_MS, CHANGE_THRESHOLD_CELSIUS };
export const _internal = { Listeners, UNSUPPORTED_MESSAGES, MAC_THERMAL_STATE_MESSAGE };
