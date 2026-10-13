import type {
  AudioControlScope,
  AudioDevicesSnapshot,
  AudioLevelResult,
  AudioMonitorStatus,
} from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import {
  CollectAudio,
  DisposeAudioSamplers,
  SetAudioLevel,
  type AudioCollection,
} from './samplers';
import {
  ErrorText,
  MuteScope,
  NO_CAPABILITIES,
  ScopeReaches,
  VolumeScope,
  type AudioLevelChange,
} from './shared';

const Logger = CreateLogger('AudioMonitor');

// How often the audio stack is sampled. The macOS sample is the expensive one —
// ~130ms of CPU across system_profiler and osascript — which is why this is not
// the 3s the application sampler runs at. A USB hotplug triggers an immediate
// sample anyway (see RequestSample), and almost every professional interface
// arrives over USB or Thunderbolt, so the poll mostly catches level changes.
const POLL_INTERVAL_MS = 5000;
// An unchanged snapshot is still re-sent at this interval. The server records a
// history point per report, so going silent between changes would thin a critical
// device's timeline down to nothing.
const KEEPALIVE_INTERVAL_MS = 20000;
// After a USB hotplug the OS takes a moment to publish the new audio device;
// sampling the instant the USB event fires would usually miss it.
const HOTPLUG_SETTLE_MS = 1500;

let activeSocket: ShowTrakSocket | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let hotplugTimer: NodeJS.Timeout | null = null;
let lastSignature: string | null = null;
let lastEmitAt = 0;
let lastSnapshot: AudioDevicesSnapshot | null = null;
let inFlight: Promise<void> | null = null;
// Bumped on every Start/Stop, so a sample that was already running when the
// connection changed can tell its result belongs to a session that has ended.
let generation = 0;

/** "macOS" rather than "darwin" in anything an operator reads. */
export function PlatformLabel(Platform: string): string {
  if (Platform === 'darwin') return 'macOS';
  if (Platform === 'win32') return 'Windows';
  if (Platform === 'linux') return 'Linux';
  return Platform;
}

export function BuildSnapshot(
  Collection: AudioCollection,
  Platform: string = process.platform,
  Now: number = Date.now()
): AudioDevicesSnapshot {
  if (Collection.Ok) {
    return {
      SampledAt: Now,
      Endpoints: Collection.Sample.Endpoints,
      Status: {
        State: 'ok',
        Message: Collection.Sample.Note || null,
        Platform,
        Backend: Collection.Sample.Backend,
      },
      Capabilities: Collection.Sample.Capabilities,
    };
  }
  return {
    SampledAt: Now,
    Endpoints: [],
    Status: {
      State: Collection.Unsupported ? 'unsupported' : 'error',
      Message: ErrorText(Collection.Error, 'Audio devices could not be read'),
      Platform,
      Backend: null,
    },
    Capabilities: NO_CAPABILITIES,
  };
}

/** Everything that matters in a snapshot, so only a real change is reported early. */
export function SnapshotSignature(Snapshot: AudioDevicesSnapshot): string {
  const Status: AudioMonitorStatus = Snapshot.Status;
  return JSON.stringify([
    Snapshot.Endpoints,
    Status.State,
    Status.Message,
    Status.Backend,
    Snapshot.Capabilities,
  ]);
}

async function SampleAndReport(ForceEmit: boolean, Generation: number): Promise<void> {
  const Collection = await CollectAudio();
  if (Generation !== generation) return;
  if (!Collection.Ok) {
    Logger.warn(`Audio sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
  }
  const Snapshot = BuildSnapshot(Collection);
  lastSnapshot = Snapshot;

  const Socket = activeSocket;
  if (!Socket || !Socket.connected) return;
  const Signature = SnapshotSignature(Snapshot);
  const Now = Date.now();
  if (!ForceEmit && Signature === lastSignature && Now - lastEmitAt < KEEPALIVE_INTERVAL_MS) {
    return;
  }
  lastSignature = Signature;
  lastEmitAt = Now;
  Socket.emit('AudioDevices', Snapshot);
}

interface SampleOptions {
  /** Report even if nothing changed. */
  ForceEmit?: boolean;
  /**
   * Run a fresh sample after any in-flight one rather than sharing its result.
   * The periodic poll shares (a sample already running is as fresh as it needs);
   * a hotplug or a level change must see the world AFTER the event.
   */
  Queue?: boolean;
}

function RunSample(Options: SampleOptions = {}): Promise<void> {
  if (inFlight) {
    if (!Options.Queue) return inFlight;
    return inFlight.then(() => RunSample(Options));
  }
  const Current = SampleAndReport(!!Options.ForceEmit, generation)
    .catch((error: unknown) => {
      Logger.warn(`Audio sample threw: ${ErrorText(error, 'unknown error')}`);
    })
    .finally(() => {
      if (inFlight === Current) inFlight = null;
    });
  inFlight = Current;
  return Current;
}

function ClearTimers(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (hotplugTimer) clearTimeout(hotplugTimer);
  pollTimer = null;
  hotplugTimer = null;
}

function ScopeRefusal(Scope: AudioControlScope, What: string, Direction: string): string {
  const OS = PlatformLabel(lastSnapshot?.Status.Platform || process.platform);
  if (Scope === 'default') return `${OS} can only change the ${What} of the default ${Direction}`;
  return `Changing the ${What} of this device is not available on ${OS}`;
}

/** Validate a request off the wire into a change, or say what is wrong with it. */
export function ParseLevelRequest(
  Request: unknown
): { EndpointID: string; Change: AudioLevelChange } | { Error: string } {
  if (!Request || typeof Request !== 'object') return { Error: 'Invalid audio level request' };
  const Raw = Request as Record<string, unknown>;
  const EndpointID = typeof Raw.EndpointID === 'string' ? Raw.EndpointID.trim() : '';
  if (!EndpointID || EndpointID.length > 512) return { Error: 'An audio device is required' };
  const Change: AudioLevelChange = {};
  if (Raw.Volume !== undefined && Raw.Volume !== null) {
    if (typeof Raw.Volume !== 'number' || !Number.isFinite(Raw.Volume)) {
      return { Error: 'Level must be a number' };
    }
    if (Raw.Volume < 0 || Raw.Volume > 100) return { Error: 'Level must be between 0 and 100' };
    Change.Volume = Math.round(Raw.Volume);
  }
  if (Raw.Muted !== undefined && Raw.Muted !== null) {
    if (typeof Raw.Muted !== 'boolean') return { Error: 'Mute must be true or false' };
    Change.Muted = Raw.Muted;
  }
  if (Change.Volume === undefined && Change.Muted === undefined) {
    return { Error: 'Nothing to change' };
  }
  return { EndpointID, Change };
}

export const Manager = {
  /** Begin reporting on a freshly connected socket. Resolves after the first report. */
  Start(Socket: ShowTrakSocket | null): Promise<void> {
    ClearTimers();
    generation += 1;
    activeSocket = Socket || null;
    lastSignature = null;
    lastEmitAt = 0;
    lastSnapshot = null;
    inFlight = null;
    pollTimer = setInterval(() => {
      void RunSample();
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    // The server replaces its state from the first report of a connection, so it
    // goes out even if this process sampled the same thing a moment ago.
    return RunSample({ ForceEmit: true, Queue: true });
  },

  Stop(): void {
    ClearTimers();
    generation += 1;
    activeSocket = null;
    lastSignature = null;
    lastEmitAt = 0;
    lastSnapshot = null;
    inFlight = null;
    DisposeAudioSamplers();
  },

  /**
   * Re-sample soon, because something that can change the audio topology just
   * happened (a USB device came or went). Bursts coalesce into one sample.
   */
  RequestSample(): void {
    if (!activeSocket) return;
    if (hotplugTimer) clearTimeout(hotplugTimer);
    hotplugTimer = setTimeout(() => {
      hotplugTimer = null;
      void RunSample({ Queue: true });
    }, HOTPLUG_SETTLE_MS);
    if (typeof hotplugTimer.unref === 'function') hotplugTimer.unref();
  },

  /**
   * Apply a level/mute change the server asked for, then report the result.
   *
   * The server can only name an endpoint this client itself reported: the id is
   * looked up in the last snapshot and the backend acts on the endpoint found
   * there, never on the id as given. So a request cannot reach a device the
   * client has not enumerated, nor smuggle text into a command line.
   */
  async SetLevel(Request: unknown): Promise<AudioLevelResult> {
    const Parsed = ParseLevelRequest(Request);
    if ('Error' in Parsed) return { Success: false, Error: Parsed.Error };

    if (!lastSnapshot) await RunSample({ Queue: true });
    const Snapshot = lastSnapshot as AudioDevicesSnapshot | null;
    if (!Snapshot || Snapshot.Status.State !== 'ok') {
      return {
        Success: false,
        Error: Snapshot?.Status.Message || 'Audio devices are not available on this client',
      };
    }
    const Endpoint = Snapshot.Endpoints.find((Entry) => Entry.EndpointID === Parsed.EndpointID);
    if (!Endpoint) {
      return { Success: false, Error: 'That audio device is no longer present on this client' };
    }

    const Capabilities = Snapshot.Capabilities;
    if (Parsed.Change.Volume !== undefined) {
      const Scope = VolumeScope(Capabilities, Endpoint.Direction);
      if (!ScopeReaches(Scope, Endpoint)) {
        return { Success: false, Error: ScopeRefusal(Scope, 'level', Endpoint.Direction) };
      }
    }
    if (Parsed.Change.Muted !== undefined) {
      const Scope = MuteScope(Capabilities, Endpoint.Direction);
      if (!ScopeReaches(Scope, Endpoint)) {
        return { Success: false, Error: ScopeRefusal(Scope, 'mute', Endpoint.Direction) };
      }
    }

    Logger.log(
      `Setting audio on "${Endpoint.Name}" (${Endpoint.Direction}): ${JSON.stringify(Parsed.Change)}`
    );
    const [Error_] = await SetAudioLevel(Endpoint, Parsed.Change);
    if (Error_) {
      const Message = ErrorText(Error_, 'The audio level could not be changed');
      Logger.warn(`Audio level change failed: ${Message}`);
      return { Success: false, Error: Message };
    }
    // Report the new state before acknowledging, so the server never shows a
    // "done" against a snapshot that still carries the old level.
    await RunSample({ ForceEmit: true, Queue: true });
    return { Success: true, Error: null };
  },

  GetLastSnapshot(): AudioDevicesSnapshot | null {
    return lastSnapshot;
  },
};

export const _constants = { POLL_INTERVAL_MS, KEEPALIVE_INTERVAL_MS, HOTPLUG_SETTLE_MS };
