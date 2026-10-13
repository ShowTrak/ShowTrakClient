import type { AudioDirection, AudioEndpoint, AudioTransport } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import {
  COREAUDIO_CAPABILITIES,
  DisambiguateEndpointIDs,
  NormalizeVolume,
  PositiveInteger,
  RunCommand,
  Slugify,
  type AudioLevelChange,
  type AudioSample,
} from './shared';

// macOS reads devices through `system_profiler SPAudioDataType -json` and the
// default devices' levels through AppleScript's `get volume settings`. Measured
// on an M-series MacBook: ~230ms wall / ~70ms CPU and ~170ms wall / ~60ms CPU
// respectively. Neither needs a privacy permission — `volume settings` is a
// Standard Additions command, not an Apple Event to another application, so
// unlike the old System Events process query it never prompts for Automation.

/** One device as it appears in the system_profiler JSON. */
interface ProfilerDevice {
  _name?: unknown;
  coreaudio_device_input?: unknown;
  coreaudio_device_output?: unknown;
  coreaudio_device_manufacturer?: unknown;
  coreaudio_device_srate?: unknown;
  coreaudio_device_transport?: unknown;
  coreaudio_default_audio_input_device?: unknown;
  coreaudio_default_audio_output_device?: unknown;
  _items?: unknown;
}

/** `coreaudio_device_type_usb` -> `usb`. Anything unrecognised is `unknown`. */
const TRANSPORT_BY_SUFFIX: Record<string, AudioTransport> = {
  builtin: 'builtin',
  usb: 'usb',
  bluetooth: 'bluetooth',
  bluetoothle: 'bluetooth',
  hdmi: 'hdmi',
  displayport: 'displayport',
  thunderbolt: 'thunderbolt',
  firewire: 'firewire',
  pci: 'pci',
  avb: 'network',
  virtual: 'virtual',
  aggregate: 'aggregate',
  autoaggregate: 'aggregate',
  airplay: 'airplay',
};

export function MapMacTransport(Value: unknown): AudioTransport {
  const Raw = String(Value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^coreaudio_device_type_/, '');
  return TRANSPORT_BY_SUFFIX[Raw] || 'unknown';
}

const IsYes = (Value: unknown) => String(Value ?? '').toLowerCase() === 'spaudio_yes';

/**
 * Walk the profiler tree for device records. The devices sit under
 * `SPAudioDataType[0]._items` today; walking rather than indexing keeps an older
 * or reshuffled layout from silently reporting no devices.
 */
function CollectProfilerDevices(Node: unknown, Out: ProfilerDevice[] = []): ProfilerDevice[] {
  if (Array.isArray(Node)) {
    for (const Child of Node) CollectProfilerDevices(Child, Out);
    return Out;
  }
  if (!Node || typeof Node !== 'object') return Out;
  const Record_ = Node as ProfilerDevice & Record<string, unknown>;
  const IsDevice =
    Record_.coreaudio_device_input !== undefined || Record_.coreaudio_device_output !== undefined;
  if (IsDevice) Out.push(Record_);
  for (const Value of Object.values(Record_)) {
    if (Value && typeof Value === 'object') CollectProfilerDevices(Value, Out);
  }
  return Out;
}

/**
 * Turn the profiler JSON into endpoints, one per direction per device. Levels are
 * filled in afterwards from `volume settings`, which only covers the defaults.
 *
 * macOS does not expose a device UID to anything the client can run, so ids are
 * built from direction + manufacturer + name, disambiguated by enumeration order.
 */
export function ParseSystemProfilerAudio(Json: string): AudioEndpoint[] {
  const Parsed: unknown = JSON.parse(Json);
  const Endpoints: AudioEndpoint[] = [];
  for (const Device of CollectProfilerDevices(Parsed)) {
    const Name = String(Device._name ?? '').trim() || 'Audio Device';
    const Manufacturer = String(Device.coreaudio_device_manufacturer ?? '').trim() || null;
    const Transport = MapMacTransport(Device.coreaudio_device_transport);
    const SampleRate = PositiveInteger(Device.coreaudio_device_srate);
    const Directions: Array<[AudioDirection, unknown, unknown]> = [
      ['input', Device.coreaudio_device_input, Device.coreaudio_default_audio_input_device],
      ['output', Device.coreaudio_device_output, Device.coreaudio_default_audio_output_device],
    ];
    for (const [Direction, RawChannels, RawDefault] of Directions) {
      const Channels = PositiveInteger(RawChannels);
      if (!Channels) continue;
      Endpoints.push({
        EndpointID: `coreaudio:${Direction}:${Slugify(Manufacturer) || 'unknown'}:${Slugify(Name) || 'device'}`,
        Direction,
        Name,
        Manufacturer,
        Transport,
        Channels,
        SampleRate,
        IsDefault: IsYes(RawDefault),
        Volume: null,
        Muted: null,
      });
    }
  }
  return DisambiguateEndpointIDs(Endpoints);
}

export interface MacVolumeSettings {
  OutputVolume: number | null;
  InputVolume: number | null;
  OutputMuted: boolean | null;
}

/**
 * Parse `output volume:44, input volume:71, alert volume:100, output muted:false`.
 * A default device with no software volume (HDMI, most interfaces) reads as
 * `missing value`, which becomes null rather than zero.
 */
export function ParseVolumeSettings(Text: string): MacVolumeSettings {
  const Read = (Key: string): string | null => {
    const Match = new RegExp(`${Key}\\s*:\\s*([^,\\n]+)`, 'i').exec(Text);
    return Match && Match[1] ? Match[1].trim() : null;
  };
  const Muted = (Read('output muted') || '').toLowerCase();
  return {
    OutputVolume: NormalizeVolume(Read('output volume')),
    InputVolume: NormalizeVolume(Read('input volume')),
    OutputMuted: Muted === 'true' ? true : Muted === 'false' ? false : null,
  };
}

/** Attach the default devices' levels to their endpoints. */
export function ApplyVolumeSettings(
  Endpoints: AudioEndpoint[],
  Settings: MacVolumeSettings
): AudioEndpoint[] {
  return Endpoints.map((Endpoint) => {
    if (!Endpoint.IsDefault) return Endpoint;
    if (Endpoint.Direction === 'output') {
      return { ...Endpoint, Volume: Settings.OutputVolume, Muted: Settings.OutputMuted };
    }
    return { ...Endpoint, Volume: Settings.InputVolume };
  });
}

export async function CollectMacAudio(): Promise<Result<AudioSample>> {
  const [ProfilerError, Json] = await RunCommand('system_profiler', ['SPAudioDataType', '-json']);
  if (ProfilerError || Json === null) return [ProfilerError || new Error('No output'), null];
  let Endpoints: AudioEndpoint[];
  try {
    Endpoints = ParseSystemProfilerAudio(Json);
  } catch (error) {
    return [error, null];
  }
  // A failed level read still leaves a useful device list, so it degrades to
  // "level unknown" rather than failing the whole sample.
  const [VolumeError, VolumeText] = await RunCommand('osascript', ['-e', 'get volume settings']);
  if (!VolumeError && VolumeText !== null) {
    Endpoints = ApplyVolumeSettings(Endpoints, ParseVolumeSettings(VolumeText));
  }
  return [null, { Backend: 'coreaudio', Endpoints, Capabilities: COREAUDIO_CAPABILITIES }];
}

/**
 * The AppleScript statements that apply a change. Exported for tests; the values
 * are numbers and booleans the caller has already validated, so nothing here is
 * built from text a device or server supplied.
 */
export function BuildMacLevelScripts(
  Endpoint: Pick<AudioEndpoint, 'Direction'>,
  Change: AudioLevelChange
): Result<string[]> {
  const Scripts: string[] = [];
  if (typeof Change.Volume === 'number') {
    const Level = Math.max(0, Math.min(100, Math.round(Change.Volume)));
    Scripts.push(`set volume ${Endpoint.Direction} volume ${Level}`);
  }
  if (typeof Change.Muted === 'boolean') {
    if (Endpoint.Direction === 'input') {
      return [
        new Error('macOS does not offer an input mute; set the input level to 0 instead'),
        null,
      ];
    }
    Scripts.push(`set volume output muted ${Change.Muted ? 'true' : 'false'}`);
  }
  return [null, Scripts];
}

export async function SetMacAudioLevel(
  Endpoint: AudioEndpoint,
  Change: AudioLevelChange
): Promise<Result<true>> {
  if (!Endpoint.IsDefault) {
    return [
      new Error(
        `macOS can only change the level of the default ${Endpoint.Direction}. Make "${Endpoint.Name}" the default first.`
      ),
      null,
    ];
  }
  const [BuildError, Scripts] = BuildMacLevelScripts(Endpoint, Change);
  if (BuildError || !Scripts) return [BuildError, null];
  for (const Script of Scripts) {
    const [Error_] = await RunCommand('osascript', ['-e', Script]);
    if (Error_) return [Error_, null];
  }
  return [null, true];
}
