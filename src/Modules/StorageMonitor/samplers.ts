import type { StorageVolume } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CollectMacStorage } from './macos';
import { CollectLinuxStorage } from './linux';
import { CollectWindowsStorage, DisposeWindowsStorage } from './windows';

// Mounted volumes, per platform. Each reader answers the same questions — what
// is mounted, how big, how full, whether it is read-only, whether the drive
// says it is healthy — and answers null to the last two where it cannot tell.

/** What one successful read of the platform produced. */
export interface StorageReading {
  /** The facility that answered: "df+diskutil", "proc+df" or "wmi". */
  Backend: string;
  Volumes: StorageVolume[];
}

/** A reading, or why there is none. `Unsupported` means no reader exists here at all. */
export type StorageCollection =
  { Ok: true; Reading: StorageReading } | { Ok: false; Unsupported: boolean; Error: unknown };

const BACKENDS: Record<string, string> = {
  darwin: 'df+diskutil',
  linux: 'proc+df',
  win32: 'wmi',
};

/**
 * The boot volume first ("/" or the system drive), then everything else by
 * where it is mounted, so the list does not reorder between samples.
 */
export function SortVolumes(Volumes: StorageVolume[], SystemDrive?: string): StorageVolume[] {
  const Boot = (Volume: StorageVolume) =>
    Volume.MountPoint === '/' ||
    (!!SystemDrive && Volume.MountPoint.toUpperCase() === SystemDrive.toUpperCase());
  return [...Volumes].sort(
    (A, B) => Number(Boot(B)) - Number(Boot(A)) || A.MountPoint.localeCompare(B.MountPoint)
  );
}

export async function CollectStorage(
  Platform: string = process.platform
): Promise<StorageCollection> {
  let Outcome: Result<StorageVolume[]>;
  if (Platform === 'darwin') Outcome = await CollectMacStorage();
  else if (Platform === 'linux') Outcome = await CollectLinuxStorage();
  else if (Platform === 'win32') Outcome = await CollectWindowsStorage();
  else {
    return {
      Ok: false,
      Unsupported: true,
      Error: new Error(`Storage monitoring is not available on ${Platform}`),
    };
  }
  const [Error_, Volumes] = Outcome;
  if (Error_ || !Volumes) {
    return { Ok: false, Unsupported: false, Error: Error_ || new Error('Storage sample failed') };
  }
  return {
    Ok: true,
    Reading: {
      Backend: BACKENDS[Platform] || Platform,
      Volumes: SortVolumes(Volumes, process.env.SystemDrive),
    },
  };
}

/** Release resident sampler state (the Windows PowerShell host). */
export function DisposeStorageSamplers(): void {
  DisposeWindowsStorage();
}
