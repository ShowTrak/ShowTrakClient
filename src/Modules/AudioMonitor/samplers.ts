import type { AudioEndpoint } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CollectMacAudio, SetMacAudioLevel } from './macos';
import { CollectWindowsAudio, DisposeWindowsAudio, SetWindowsAudioLevel } from './windows';
import { CollectLinuxAudio, NoLinuxAudioStackError, SetLinuxAudioLevel } from './linux';
import type { AudioLevelChange, AudioSample } from './shared';

/** A sample, or why there is none. `Unsupported` means no backend exists here at all. */
export type AudioCollection =
  | { Ok: true; Sample: AudioSample & { Note?: string } }
  | { Ok: false; Unsupported: boolean; Error: unknown };

export async function CollectAudio(Platform: string = process.platform): Promise<AudioCollection> {
  let Outcome: Result<AudioSample & { Note?: string }>;
  if (Platform === 'darwin') Outcome = await CollectMacAudio();
  else if (Platform === 'win32') Outcome = await CollectWindowsAudio();
  else if (Platform === 'linux') Outcome = await CollectLinuxAudio();
  else {
    return {
      Ok: false,
      Unsupported: true,
      Error: new Error(`Audio monitoring is not available on ${Platform}`),
    };
  }
  const [Error_, Sample] = Outcome;
  if (!Error_ && Sample) return { Ok: true, Sample };
  return {
    Ok: false,
    Unsupported: Error_ instanceof NoLinuxAudioStackError,
    Error: Error_ || new Error('Audio sample failed'),
  };
}

export function SetAudioLevel(
  Endpoint: AudioEndpoint,
  Change: AudioLevelChange,
  Platform: string = process.platform
): Promise<Result<true>> {
  if (Platform === 'darwin') return SetMacAudioLevel(Endpoint, Change);
  if (Platform === 'win32') return SetWindowsAudioLevel(Endpoint, Change);
  if (Platform === 'linux') return SetLinuxAudioLevel(Endpoint, Change);
  return Promise.resolve([new Error(`Audio control is not available on ${Platform}`), null]);
}

/** Release resident sampler state (the Windows PowerShell host). */
export function DisposeAudioSamplers(): void {
  DisposeWindowsAudio();
}
