import type { AudioDirection, AudioEndpoint, AudioTransport } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import {
  ALSA_CAPABILITIES,
  ErrorText,
  IsMissingCommand,
  NormalizeVolume,
  PositiveInteger,
  PULSEAUDIO_CAPABILITIES,
  RunCommand,
  type AudioLevelChange,
  type AudioSample,
} from './shared';

// Linux reads audio through `pactl`, which speaks to PulseAudio and to PipeWire
// (via pipewire-pulse) alike, so one parser covers every current desktop. Its
// plain-text output is parsed rather than `--format=json`, which only exists from
// pactl 16 — Ubuntu 22.04 ships 15.99. The text is localised, so every call runs
// under the C locale; without that a German desktop reports "Stummschalten: nein".
//
// With no sound server running (a kiosk with no desktop session, or the client
// installed as a system service), `pactl` cannot connect, and the monitor falls
// back to ALSA's `aplay -l` / `arecord -l`: which devices exist, and nothing else.

const C_LOCALE: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

/** One `Sink #n` / `Source #n` block of `pactl list`. */
export interface PactlBlock {
  Name: string;
  Description: string | null;
  SampleSpec: string | null;
  Mute: string | null;
  Volume: string | null;
  MonitorOf: string | null;
  ActivePort: string | null;
  Properties: Record<string, string>;
}

const BLOCK_HEADER = /^(?:Sink|Source) #\d+\s*$/;
const FIELD = /^\t([A-Za-z][A-Za-z ]*):\s?(.*)$/;
const PROPERTY = /^\t\t([\w.-]+) = "(.*)"\s*$/;

export function ParsePactlList(Text: string): PactlBlock[] {
  const Blocks: PactlBlock[] = [];
  let Current: PactlBlock | null = null;
  let Section: string | null = null;
  for (const Line of String(Text || '').split(/\r?\n/)) {
    if (BLOCK_HEADER.test(Line)) {
      Current = {
        Name: '',
        Description: null,
        SampleSpec: null,
        Mute: null,
        Volume: null,
        MonitorOf: null,
        ActivePort: null,
        Properties: {},
      };
      Blocks.push(Current);
      Section = null;
      continue;
    }
    if (!Current) continue;
    const Property = PROPERTY.exec(Line);
    if (Property && Section === 'Properties') {
      Current.Properties[Property[1] as string] = Property[2] as string;
      continue;
    }
    const Field = FIELD.exec(Line);
    if (!Field) continue;
    const Key = (Field[1] as string).trim();
    const Value = (Field[2] as string).trim();
    Section = Key;
    if (Key === 'Name') Current.Name = Value;
    else if (Key === 'Description') Current.Description = Value || null;
    else if (Key === 'Sample Specification') Current.SampleSpec = Value || null;
    else if (Key === 'Mute') Current.Mute = Value || null;
    else if (Key === 'Volume') Current.Volume = Value || null;
    else if (Key === 'Monitor of Sink') Current.MonitorOf = Value && Value !== 'n/a' ? Value : null;
    else if (Key === 'Active Port') Current.ActivePort = Value || null;
  }
  return Blocks.filter((Block) => Block.Name);
}

/** `s16le 2ch 44100Hz` -> channels and rate. */
export function ParseSampleSpec(Spec: string | null): {
  Channels: number | null;
  SampleRate: number | null;
} {
  const Text = String(Spec || '');
  const Channels = /(\d+)ch\b/.exec(Text);
  const Rate = /(\d+)Hz\b/.exec(Text);
  return {
    Channels: PositiveInteger(Channels && Channels[1]),
    SampleRate: PositiveInteger(Rate && Rate[1]),
  };
}

/** The mean of every channel's percentage — what the desktop's own slider shows. */
export function ParsePactlVolume(Volume: string | null): number | null {
  const Percentages = [...String(Volume || '').matchAll(/(\d+)%/g)].map((Match) =>
    Number(Match[1])
  );
  if (!Percentages.length) return null;
  return NormalizeVolume(Percentages.reduce((Sum, Value) => Sum + Value, 0) / Percentages.length);
}

export function MapPactlTransport(Block: PactlBlock): AudioTransport {
  const Props = Block.Properties;
  const Bus = String(Props['device.bus'] || '').toLowerCase();
  const Haystack = [Block.Name, Block.Description, Block.ActivePort, Props['device.profile.name']]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (Bus === 'bluetooth' || Block.Name.startsWith('bluez_')) return 'bluetooth';
  if (Haystack.includes('hdmi')) return 'hdmi';
  if (Haystack.includes('displayport')) return 'displayport';
  if (Bus === 'usb') return 'usb';
  if (Bus === 'firewire' || Bus === 'ieee1394') return 'firewire';
  if (Bus === 'thunderbolt') return 'thunderbolt';
  if (String(Props['device.form_factor'] || '').toLowerCase() === 'internal') return 'builtin';
  if (Bus === 'pci') return 'pci';
  if (
    Props['device.class'] === 'abstract' ||
    Block.Name.startsWith('null') ||
    /module-null-sink|null-audio-sink/.test(String(Props['factory.name'] || ''))
  ) {
    return 'virtual';
  }
  if (/tunnel|rtp|raop|roc|aes67/.test(Haystack)) return 'network';
  return 'unknown';
}

/** Endpoint ids name the sink/source, which is stable for as long as the device is. */
export function PulseEndpointID(Direction: AudioDirection, Name: string): string {
  return `pulse:${Direction}:${Name}`;
}

export function ParsePulseDefaults(Info: string): { Sink: string | null; Source: string | null } {
  const Read = (Key: string) => {
    const Match = new RegExp(`^${Key}:\\s*(.+)$`, 'm').exec(String(Info || ''));
    return Match && Match[1] ? Match[1].trim() : null;
  };
  return { Sink: Read('Default Sink'), Source: Read('Default Source') };
}

export function BuildPulseEndpoints(
  Sinks: PactlBlock[],
  Sources: PactlBlock[],
  Defaults: { Sink: string | null; Source: string | null }
): AudioEndpoint[] {
  const ToEndpoint = (Block: PactlBlock, Direction: AudioDirection): AudioEndpoint => {
    const { Channels, SampleRate } = ParseSampleSpec(Block.SampleSpec);
    const Mute = String(Block.Mute || '').toLowerCase();
    return {
      EndpointID: PulseEndpointID(Direction, Block.Name),
      Direction,
      Name: Block.Description || Block.Properties['device.description'] || Block.Name,
      Manufacturer: Block.Properties['device.vendor.name'] || null,
      Transport: MapPactlTransport(Block),
      Channels,
      SampleRate,
      IsDefault: Block.Name === (Direction === 'output' ? Defaults.Sink : Defaults.Source),
      Volume: ParsePactlVolume(Block.Volume),
      Muted: Mute === 'yes' ? true : Mute === 'no' ? false : null,
    };
  };
  // PulseAudio and PipeWire create a "Monitor of <output>" source for EVERY sink:
  // a loopback that records whatever is played to that output. It is not a
  // device, cannot be unplugged, and exists exactly when its sink does — so it
  // can never tell an operator anything the sink has not, and listing it would
  // double every output. Real inputs, including virtual ones such as a Dante or
  // AES67 receiver, are kept.
  return [
    ...Sinks.map((Block) => ToEndpoint(Block, 'output')),
    ...Sources.filter((Block) => !IsMonitorSource(Block)).map((Block) =>
      ToEndpoint(Block, 'input')
    ),
  ];
}

/** Whether a source is the loopback monitor of a sink rather than an input of its own. */
export function IsMonitorSource(Block: PactlBlock): boolean {
  return !!Block.MonitorOf || Block.Properties['device.class'] === 'monitor';
}

const ALSA_LINE = /^card (\d+): (\S+) \[(.*?)\], device (\d+): (.*?) \[(.*?)\]/;

/** Parse `aplay -l` / `arecord -l`. */
export function ParseAlsaList(Text: string, Direction: AudioDirection): AudioEndpoint[] {
  const Endpoints: AudioEndpoint[] = [];
  for (const Line of String(Text || '').split(/\r?\n/)) {
    const Match = ALSA_LINE.exec(Line.trim());
    if (!Match) continue;
    const [, , CardID, CardName, Device, DeviceShort, DeviceName] = Match;
    const Card = (CardName || CardID || '').trim();
    const Pcm = (DeviceName || DeviceShort || '').trim();
    Endpoints.push({
      EndpointID: `alsa:${Direction}:${CardID}:${Device}`,
      Direction,
      Name: Pcm && Pcm !== Card ? `${Card}: ${Pcm}` : Card || 'ALSA Device',
      Manufacturer: null,
      Transport: null,
      Channels: null,
      SampleRate: null,
      IsDefault: false,
      Volume: null,
      Muted: null,
    });
  }
  return Endpoints;
}

async function CollectPulse(): Promise<Result<AudioSample>> {
  const [[SinkError, SinkText], [SourceError, SourceText], [InfoError, InfoText]] =
    await Promise.all([
      RunCommand('pactl', ['list', 'sinks'], C_LOCALE),
      RunCommand('pactl', ['list', 'sources'], C_LOCALE),
      RunCommand('pactl', ['info'], C_LOCALE),
    ]);
  const Error_ = SinkError || SourceError || InfoError;
  if (Error_) return [Error_, null];
  const Endpoints = BuildPulseEndpoints(
    ParsePactlList(SinkText || ''),
    ParsePactlList(SourceText || ''),
    ParsePulseDefaults(InfoText || '')
  );
  return [null, { Backend: 'pulseaudio', Endpoints, Capabilities: PULSEAUDIO_CAPABILITIES }];
}

async function CollectAlsa(): Promise<Result<AudioSample>> {
  const [[PlaybackError, Playback], [CaptureError, Capture]] = await Promise.all([
    RunCommand('aplay', ['-l'], C_LOCALE),
    RunCommand('arecord', ['-l'], C_LOCALE),
  ]);
  const Error_ = PlaybackError || CaptureError;
  if (Error_) return [Error_, null];
  return [
    null,
    {
      Backend: 'alsa',
      Endpoints: [
        ...ParseAlsaList(Playback || '', 'output'),
        ...ParseAlsaList(Capture || '', 'input'),
      ],
      Capabilities: ALSA_CAPABILITIES,
    },
  ];
}

/** Reported when neither pactl nor the ALSA tools exist on the machine. */
export class NoLinuxAudioStackError extends Error {
  constructor() {
    super(
      'No supported audio system found. Install pulseaudio-utils (pactl) or alsa-utils (aplay) on this client.'
    );
    this.name = 'NoLinuxAudioStackError';
  }
}

export async function CollectLinuxAudio(): Promise<Result<AudioSample & { Note?: string }>> {
  const [PulseError, Pulse] = await CollectPulse();
  if (!PulseError && Pulse) return [null, Pulse];

  const [AlsaError, Alsa] = await CollectAlsa();
  if (!AlsaError && Alsa) {
    // Say why the reading is so thin: the operator can usually fix this.
    const Reason = IsMissingCommand(PulseError)
      ? 'pactl is not installed'
      : `PulseAudio/PipeWire is not reachable (${ErrorText(PulseError, 'unknown error')})`;
    return [null, { ...Alsa, Note: `${Reason}, so only ALSA device presence can be reported.` }];
  }
  if (IsMissingCommand(PulseError) && IsMissingCommand(AlsaError)) {
    return [new NoLinuxAudioStackError(), null];
  }
  return [PulseError, null];
}

/**
 * The pactl invocations that apply a change, as argument arrays (no shell). The
 * leading `--` ends option parsing, so a sink name can never read as a flag.
 */
export function BuildPactlCommands(
  Endpoint: Pick<AudioEndpoint, 'Direction' | 'EndpointID'>,
  Change: AudioLevelChange
): Result<string[][]> {
  const Prefix = `pulse:${Endpoint.Direction}:`;
  if (!Endpoint.EndpointID.startsWith(Prefix)) {
    return [
      new Error('This device can only be listed, not controlled, without PulseAudio/PipeWire'),
      null,
    ];
  }
  const Name = Endpoint.EndpointID.slice(Prefix.length);
  const Kind = Endpoint.Direction === 'output' ? 'sink' : 'source';
  const Commands: string[][] = [];
  if (typeof Change.Volume === 'number') {
    const Level = Math.max(0, Math.min(100, Math.round(Change.Volume)));
    Commands.push(['--', `set-${Kind}-volume`, Name, `${Level}%`]);
  }
  if (typeof Change.Muted === 'boolean') {
    Commands.push(['--', `set-${Kind}-mute`, Name, Change.Muted ? '1' : '0']);
  }
  return [null, Commands];
}

export async function SetLinuxAudioLevel(
  Endpoint: AudioEndpoint,
  Change: AudioLevelChange
): Promise<Result<true>> {
  const [BuildError, Commands] = BuildPactlCommands(Endpoint, Change);
  if (BuildError || !Commands) return [BuildError, null];
  for (const Args of Commands) {
    const [Error_] = await RunCommand('pactl', Args, C_LOCALE);
    if (Error_) return [Error_, null];
  }
  return [null, true];
}
