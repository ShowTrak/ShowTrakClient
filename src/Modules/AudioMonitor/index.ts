import type {
  AudioControlScope,
  AudioDevicesSnapshot,
  AudioLevelResult,
  AudioMonitorStatus,
} from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { CreateSnapshotReporter, SignatureChange, type SampleOptions } from '../SnapshotReporter';
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

// How often the audio stack is sampled. A USB hotplug triggers an immediate
// sample anyway (see RequestSample), and almost every professional interface
// arrives over USB or Thunderbolt, so the poll mostly catches level changes.
// macOS's level read is an osascript (~60ms of CPU), so it polls half as often;
// its device list (system_profiler) is cached for a minute on top of that.
// Windows' is a method call in a warm PowerShell host and Linux's a pactl.
const POLL_INTERVAL_MS = process.platform === 'darwin' ? 10000 : 5000;
// An unchanged snapshot is still re-sent at this interval. The server records a
// history point per report, so going silent between changes would thin a critical
// device's timeline down to nothing.
const KEEPALIVE_INTERVAL_MS = 20000;
// After a USB hotplug the OS takes a moment to publish the new audio device;
// sampling the instant the USB event fires would usually miss it.
const HOTPLUG_SETTLE_MS = 1500;

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

interface AudioRead {
  /** Re-read the device list, not just the levels (macOS caches it). */
  Refresh: boolean;
}

// A sample asked for because of a hotplug or a level change queues behind one
// already running (see SnapshotReporter): it must see the world AFTER the event.
const Reporter = CreateSnapshotReporter({
  Noun: 'Audio',
  Logger,
  PollIntervalMs: POLL_INTERVAL_MS,
  KeepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  Read: (Options: SampleOptions<AudioRead>) =>
    CollectAudio(process.platform, { Refresh: !!Options.Refresh }),
  Build(Collection: AudioCollection) {
    if (!Collection.Ok) {
      Logger.warn(`Audio sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
    }
    return BuildSnapshot(Collection);
  },
  Change: SignatureChange(SnapshotSignature),
  Emit(Socket, Snapshot) {
    Socket.emit('AudioDevices', Snapshot);
  },
});

function ScopeRefusal(Scope: AudioControlScope, What: string, Direction: string): string {
  const OS = PlatformLabel(Reporter.LastSnapshot()?.Status.Platform || process.platform);
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
    // The server replaces its state from the first report of a connection, so it
    // goes out even if this process sampled the same thing a moment ago.
    return Reporter.Start(Socket, { Refresh: true });
  },

  Stop(): void {
    Reporter.Stop();
    DisposeAudioSamplers();
  },

  /**
   * Re-sample soon, because something that can change the audio topology just
   * happened (a USB device came or went). Bursts coalesce into one sample.
   */
  RequestSample(): void {
    Reporter.SampleAfter(HOTPLUG_SETTLE_MS, { Queue: true, Refresh: true });
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

    if (!Reporter.LastSnapshot()) await Reporter.Sample({ Queue: true });
    const Snapshot = Reporter.LastSnapshot();
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
    await Reporter.Sample({ ForceEmit: true, Queue: true });
    return { Success: true, Error: null };
  },

  GetLastSnapshot(): AudioDevicesSnapshot | null {
    return Reporter.LastSnapshot();
  },
};

export const _constants = { POLL_INTERVAL_MS, KEEPALIVE_INTERVAL_MS, HOTPLUG_SETTLE_MS };
