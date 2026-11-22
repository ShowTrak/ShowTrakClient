import type { CollectorStatus, StorageSnapshot } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';
import { CreateSnapshotReporter, SignatureChange, type SampleOptions } from '../SnapshotReporter';
import { CollectStorage, DisposeStorageSamplers, type StorageCollection } from './samplers';

const Logger = CreateLogger('StorageMonitor');

// Volumes come and go with USB hotplugs (see RequestSample) and share mounts,
// and free space moves with whatever is writing; this catches both soon enough
// for a recording drive filling at a gigabyte a minute.
const POLL_INTERVAL_MS = 20000;
// An unchanged snapshot is still re-sent at this interval, so a server that
// missed one (or restarted) converges, and a monitored volume's timeline keeps
// its points while nothing changes.
const KEEPALIVE_INTERVAL_MS = 60000;
// After a USB hotplug the OS takes a moment to mount what was plugged in;
// sampling the instant the USB event fires would usually miss it.
const HOTPLUG_SETTLE_MS = 3000;
// Free space is compared in steps of this size — a hundredth of the volume,
// between 64 MB and 1 GB — so a disk being written to is reported as it fills
// rather than on every sample. The value sent is still exact.
const MIN_FREE_STEP_BYTES = 64 * 1024 * 1024;
const MAX_FREE_STEP_BYTES = 1024 * 1024 * 1024;

export function BuildSnapshot(
  Collection: StorageCollection,
  Platform: string = process.platform,
  Now: number = Date.now()
): StorageSnapshot {
  if (Collection.Ok) {
    return {
      SampledAt: Now,
      Status: { State: 'ok', Message: null, Platform, Backend: Collection.Reading.Backend },
      Volumes: Collection.Reading.Volumes,
    };
  }
  const Status: CollectorStatus = Collection.Unsupported
    ? {
        State: 'unsupported',
        Message: ErrorText(
          Collection.Error,
          'Storage monitoring is not available on this platform'
        ),
        Platform,
        Backend: null,
      }
    : {
        State: 'error',
        Message: ErrorText(Collection.Error, 'Volumes could not be read'),
        Platform,
        Backend: null,
      };
  return { SampledAt: Now, Status, Volumes: [] };
}

function FreeStep(TotalBytes: number): number {
  return Math.min(MAX_FREE_STEP_BYTES, Math.max(MIN_FREE_STEP_BYTES, TotalBytes / 100));
}

/**
 * Everything that matters in a snapshot, so only a real change is reported
 * early. Free space is bucketed (see MIN_FREE_STEP_BYTES).
 */
export function SnapshotSignature(Snapshot: StorageSnapshot): string {
  return JSON.stringify([
    Snapshot.Status.State,
    Snapshot.Status.Message,
    Snapshot.Volumes.map((Volume) => [
      Volume.MountPoint,
      Volume.Name,
      Volume.FileSystem,
      Volume.Kind,
      Volume.TotalBytes,
      Math.floor(Volume.FreeBytes / FreeStep(Volume.TotalBytes)),
      Volume.ReadOnly,
      Volume.Health,
    ]),
  ]);
}

interface StorageRead {
  /** List the volumes afresh rather than refreshing a recent listing (Windows). */
  Relist: boolean;
}

const Reporter = CreateSnapshotReporter({
  Noun: 'Storage',
  Logger,
  PollIntervalMs: POLL_INTERVAL_MS,
  KeepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  Read: (Options: SampleOptions<StorageRead>) =>
    CollectStorage(process.platform, { Force: !!Options.Relist }),
  Build(Collection: StorageCollection) {
    if (!Collection.Ok && !Collection.Unsupported) {
      Logger.warn(`Storage sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
    }
    return BuildSnapshot(Collection);
  },
  Change: SignatureChange(SnapshotSignature),
  Emit(Socket, Snapshot) {
    Socket.emit('StorageVolumes', Snapshot);
  },
  KeepLastSnapshot: true,
});

export const Manager = {
  /** Begin reporting on a freshly connected socket. Resolves after the first report. */
  Start(Socket: ShowTrakSocket | null): Promise<void> {
    // The server replaces its state from the first report of a connection, so it
    // goes out even if nothing changed since the last one.
    return Reporter.Start(Socket, { Relist: true });
  },

  /** Stop reporting (the connection dropped, or the client is shutting down). */
  Stop(): void {
    Reporter.Stop();
    DisposeStorageSamplers();
  },

  /**
   * A USB device came or went: a drive may have been mounted or ejected, so
   * look again once the OS has had a moment to mount it.
   */
  RequestSample(): void {
    Reporter.SampleAfter(HOTPLUG_SETTLE_MS, { Queue: true, Relist: true });
  },

  GetLastSnapshot(): StorageSnapshot | null {
    return Reporter.LastSnapshot();
  },
};

export const _constants = {
  POLL_INTERVAL_MS,
  KEEPALIVE_INTERVAL_MS,
  HOTPLUG_SETTLE_MS,
  MIN_FREE_STEP_BYTES,
  MAX_FREE_STEP_BYTES,
};
