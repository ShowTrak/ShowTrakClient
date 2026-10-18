import { execFile } from 'child_process';

import type {
  AudioBackend,
  AudioCapabilities,
  AudioDirection,
  AudioEndpoint,
  AudioLevelRequest,
  AudioTransport,
} from '@showtrak/protocol';
import type { Result } from '../../types/client';

/** What one successful read of the platform's audio stack produced. */
export interface AudioSample {
  Backend: AudioBackend;
  Endpoints: AudioEndpoint[];
  Capabilities: AudioCapabilities;
}

/** The level/mute change a backend is asked to apply to one endpoint. */
export type AudioLevelChange = Pick<AudioLevelRequest, 'Volume' | 'Muted'>;

// What each backend can report. These are facts about the OS facility, not about
// a particular machine, which is why they are fixed tables: the client sends them
// with every snapshot so the server can say "not available on this operating
// system" from the client's own word.

/**
 * macOS. `system_profiler` names every device and reports its channel counts,
 * nominal rate, transport and the defaults; but the level is only reachable
 * through AppleScript's `volume settings`, which speaks for the DEFAULT input and
 * output alone, and has no input mute at all. Reading per-device levels needs the
 * CoreAudio C API, which nothing in the client can call without a native module.
 */
export const COREAUDIO_CAPABILITIES: AudioCapabilities = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: true,
  InputVolume: 'default',
  OutputVolume: 'default',
  InputMute: 'none',
  OutputMute: 'default',
};

/**
 * Windows Core Audio (MMDevice + IAudioEndpointVolume): per-endpoint everything,
 * except how the device is attached — the endpoint property store does not say,
 * and guessing from the adapter name would be wrong often enough to mislead.
 */
export const WASAPI_CAPABILITIES: AudioCapabilities = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: false,
  InputVolume: 'device',
  OutputVolume: 'device',
  InputMute: 'device',
  OutputMute: 'device',
};

/** PulseAudio / PipeWire (through pipewire-pulse), read with `pactl`. */
export const PULSEAUDIO_CAPABILITIES: AudioCapabilities = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: true,
  InputVolume: 'device',
  OutputVolume: 'device',
  InputMute: 'device',
  OutputMute: 'device',
};

/**
 * Bare ALSA (`aplay -l` / `arecord -l`): which cards and PCM devices exist, and
 * nothing else. Used when no sound server is running — a kiosk machine with no
 * desktop session, or the client running as a system service.
 */
export const ALSA_CAPABILITIES: AudioCapabilities = {
  DefaultDevice: false,
  Channels: false,
  SampleRate: false,
  Transport: false,
  InputVolume: 'none',
  OutputVolume: 'none',
  InputMute: 'none',
  OutputMute: 'none',
};

/** Nothing could be read at all. */
export const NO_CAPABILITIES: AudioCapabilities = { ...ALSA_CAPABILITIES };

/** Which scope governs this endpoint's level, for its direction. */
export function VolumeScope(Capabilities: AudioCapabilities, Direction: AudioDirection) {
  return Direction === 'input' ? Capabilities.InputVolume : Capabilities.OutputVolume;
}

/** Which scope governs this endpoint's mute, for its direction. */
export function MuteScope(Capabilities: AudioCapabilities, Direction: AudioDirection) {
  return Direction === 'input' ? Capabilities.InputMute : Capabilities.OutputMute;
}

/**
 * Whether a scope reaches this particular endpoint. A `default` scope reaches
 * only the endpoint that is currently the default for its direction.
 */
export function ScopeReaches(
  Scope: AudioCapabilities['InputVolume'],
  Endpoint: Pick<AudioEndpoint, 'IsDefault'>
): boolean {
  if (Scope === 'device') return true;
  if (Scope === 'default') return !!Endpoint.IsDefault;
  return false;
}

/**
 * A level as reported: a finite, non-negative whole number. PulseAudio allows
 * boost above 100%, which is reported as-is rather than clamped, because a
 * reading of 100 for a source at 150% would hide exactly the thing being checked.
 */
export function NormalizeVolume(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Number_ = typeof Value === 'number' ? Value : Number(Value);
  if (!Number.isFinite(Number_)) return null;
  return Math.max(0, Math.round(Number_));
}

/** A positive whole number (channel count, sample rate), or null. */
export function PositiveInteger(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Parsed = typeof Value === 'number' ? Value : parseInt(String(Value), 10);
  if (!Number.isFinite(Parsed) || Parsed <= 0) return null;
  return Math.round(Parsed);
}

/** A lower-case, punctuation-free token for building identifiers out of names. */
export function Slugify(Value: unknown): string {
  return String(Value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Give every endpoint a unique id. A backend whose ids are derived from names can
 * produce the same id for two identical devices; the second and later get an
 * ordinal suffix in enumeration order. That is the best a name can do — two
 * identical interfaces may swap ids if the first is unplugged — and it is why
 * real hardware ids are used wherever the platform offers one.
 */
export function DisambiguateEndpointIDs(Endpoints: AudioEndpoint[]): AudioEndpoint[] {
  const Seen = new Map<string, number>();
  return Endpoints.map((Endpoint) => {
    const Count = (Seen.get(Endpoint.EndpointID) || 0) + 1;
    Seen.set(Endpoint.EndpointID, Count);
    return Count === 1 ? Endpoint : { ...Endpoint, EndpointID: `${Endpoint.EndpointID}#${Count}` };
  });
}

/** Known transports; anything else a backend produces is reported as unknown. */
const TRANSPORTS: ReadonlySet<string> = new Set<AudioTransport>([
  'builtin',
  'usb',
  'bluetooth',
  'hdmi',
  'displayport',
  'thunderbolt',
  'firewire',
  'pci',
  'network',
  'virtual',
  'aggregate',
  'airplay',
  'unknown',
]);

export function NormalizeTransport(Value: unknown): AudioTransport {
  const Lower = String(Value ?? '')
    .trim()
    .toLowerCase();
  return (TRANSPORTS.has(Lower) ? Lower : 'unknown') as AudioTransport;
}

/** The message off anything thrown or reported, for status lines. */
export function ErrorText(Error_: unknown, Fallback: string): string {
  if (Error_ && typeof Error_ === 'object' && 'message' in Error_) {
    const Message = String((Error_ as { message?: unknown }).message || '').trim();
    if (Message) return Message;
  }
  if (typeof Error_ === 'string' && Error_.trim()) return Error_.trim();
  return Fallback;
}

/** Whether a failed spawn means the command does not exist on this machine. */
export function IsMissingCommand(Error_: unknown): boolean {
  return !!Error_ && typeof Error_ === 'object' && (Error_ as { code?: unknown }).code === 'ENOENT';
}

export const COMMAND_TIMEOUT_MS = 8000;

/**
 * Run a command without a shell and collect its stdout. Arguments are passed as
 * an array, so nothing a device or a server request names can be interpreted by
 * a shell.
 */
export function RunCommand(
  Command: string,
  Args: string[],
  Env?: NodeJS.ProcessEnv
): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile(
      Command,
      Args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(Env ? { env: Env } : {}),
      },
      (Error_, Stdout) => {
        if (Error_) return resolve([Error_, null]);
        return resolve([null, String(Stdout || '')]);
      }
    );
  });
}
