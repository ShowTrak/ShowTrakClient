import type { CollectorStatus, StorageSnapshot } from '@showtrak/protocol';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';
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

let activeSocket: ShowTrakSocket | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let hotplugTimer: NodeJS.Timeout | null = null;
let lastSignature: string | null = null;
let lastEmitAt = 0;
let lastSnapshot: StorageSnapshot | null = null;
let inFlight: Promise<void> | null = null;
// Bumped on every Start/Stop, so a sample that was already running when the
// connection changed can tell its result belongs to a session that has ended.
let generation = 0;

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

function Emit(Socket: ShowTrakSocket, Snapshot: StorageSnapshot): void {
  lastSignature = SnapshotSignature(Snapshot);
  lastEmitAt = Date.now();
  Socket.emit('StorageVolumes', Snapshot);
}

async function SampleAndReport(ForceEmit: boolean, Generation: number): Promise<void> {
  const Collection = await CollectStorage();
  if (Generation !== generation) return;
  if (!Collection.Ok && !Collection.Unsupported) {
    Logger.warn(`Storage sample failed: ${ErrorText(Collection.Error, 'unknown error')}`);
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
  Emit(Socket, Snapshot);
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
      Logger.warn(`Storage sample threw: ${ErrorText(error, 'unknown error')}`);
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
  if (hotplugTimer) clearTimeout(hotplugTimer);
  hotplugTimer = null;
}

export const Manager = {
  /** Begin reporting on a freshly connected socket. Resolves after the first report. */
  Start(Socket: ShowTrakSocket | null): Promise<void> {
    ClearTimers();
    generation += 1;
    activeSocket = Socket || null;
    lastSignature = null;
    lastEmitAt = 0;
    inFlight = null;
    pollTimer = setInterval(() => {
      void RunSample();
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    // The server replaces its state from the first report of a connection, so it
    // goes out even if nothing changed since the last one.
    return RunSample({ ForceEmit: true, Queue: true });
  },

  /** Stop reporting (the connection dropped, or the client is shutting down). */
  Stop(): void {
    ClearTimers();
    generation += 1;
    activeSocket = null;
    lastSignature = null;
    lastEmitAt = 0;
    inFlight = null;
    DisposeStorageSamplers();
  },

  /**
   * A USB device came or went: a drive may have been mounted or ejected, so
   * look again once the OS has had a moment to mount it.
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

  GetLastSnapshot(): StorageSnapshot | null {
    return lastSnapshot;
  },
};

export const _constants = {
  POLL_INTERVAL_MS,
  KEEPALIVE_INTERVAL_MS,
  HOTPLUG_SETTLE_MS,
  MIN_FREE_STEP_BYTES,
  MAX_FREE_STEP_BYTES,
};
