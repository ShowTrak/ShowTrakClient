// The sample -> compare -> report loop the snapshot monitors share.
//
// Power, temperatures, storage and audio each read the platform on a timer and
// report one whole snapshot to the server: always on a fresh connection (the
// server replaces its state from that first report), at once when something
// worth reporting changed, and otherwise at a keepalive, so a server that missed
// a report, or restarted, converges without waiting for the next change. This is
// that loop, written once. Each monitor brings what is its own: how to read the
// platform, how a reading becomes a snapshot, what counts as a change, and the
// event the snapshot is reported as.
//
// One sample runs at a time. The periodic poll shares a sample already in
// flight, which is as fresh as it needs to be; a sample asked for because of an
// event (a hotplug, a power-source change) queues behind it instead, because it
// must see the world after the event. Every Start and Stop begins a new session,
// so a sample still running from one that has ended cannot report into the next.
import type { ShowTrakSocket } from '../../types/socket';
import type { Logger } from '../Logger';
import { ErrorText } from '../AudioMonitor/shared';

/** How a sample is compared with what the server was last told. */
export interface ChangeCheck<TSnapshot, TReported> {
  /** What is kept of each snapshot reported, for later samples to be compared with. */
  Remember(Snapshot: TSnapshot): TReported;
  /** Whether `Next` should be reported now rather than waiting for the keepalive. */
  Changed(Reported: TReported, Next: TSnapshot): boolean;
}

/** The usual check: any difference in the snapshot's signature is a change. */
export function SignatureChange<TSnapshot>(
  Signature: (Snapshot: TSnapshot) => string
): ChangeCheck<TSnapshot, string> {
  return { Remember: Signature, Changed: (Reported, Next) => Signature(Next) !== Reported };
}

/** What a sample is asked to do: the monitor's own read options, plus these two. */
export type SampleOptions<TRead extends object> = Partial<TRead> & {
  /** Report even if nothing changed. */
  ForceEmit?: boolean;
  /** Run a fresh sample after any in-flight one rather than sharing its result. */
  Queue?: boolean;
};

export interface SnapshotReporterOptions<TRead extends object, TReading, TSnapshot, TReported> {
  /** Names the monitor in the log line for a sample that threw. */
  Noun: string;
  Logger: Pick<Logger, 'warn'>;
  PollIntervalMs: number;
  /** How often an unchanged snapshot is reported anyway. */
  KeepaliveIntervalMs: number;
  /** Read the platform. */
  Read(Options: SampleOptions<TRead>): Promise<TReading>;
  /** Turn a reading into a snapshot. Only called for a reading from the current session. */
  Build(Reading: TReading): TSnapshot;
  Change: ChangeCheck<TSnapshot, TReported>;
  /** Send a snapshot to the server. */
  Emit(Socket: ShowTrakSocket, Snapshot: TSnapshot): void;
  /**
   * Keep the last snapshot across sessions rather than forgetting it with the
   * rest of a session's state when one starts or stops.
   */
  KeepLastSnapshot?: boolean;
}

export function CreateSnapshotReporter<TRead extends object, TReading, TSnapshot, TReported>(
  Options: SnapshotReporterOptions<TRead, TReading, TSnapshot, TReported>
) {
  let activeSocket: ShowTrakSocket | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let delayTimer: NodeJS.Timeout | null = null;
  // What the server was last told, and when; null until this session reports.
  let lastReported: { Value: TReported } | null = null;
  let lastEmitAt = 0;
  let lastSnapshot: TSnapshot | null = null;
  let inFlight: Promise<void> | null = null;
  // Bumped on every Start/Stop, so a sample that was already running when the
  // connection changed can tell its result belongs to a session that has ended.
  let generation = 0;

  function Emit(Socket: ShowTrakSocket, Snapshot: TSnapshot, Now: number = Date.now()): void {
    lastReported = { Value: Options.Change.Remember(Snapshot) };
    lastEmitAt = Now;
    Options.Emit(Socket, Snapshot);
  }

  async function SampleAndReport(Request: SampleOptions<TRead>, Generation: number): Promise<void> {
    const Reading = await Options.Read(Request);
    if (Generation !== generation) return;
    const Snapshot = Options.Build(Reading);
    lastSnapshot = Snapshot;

    const Socket = activeSocket;
    if (!Socket || !Socket.connected) return;
    const Now = Date.now();
    if (
      !Request.ForceEmit &&
      lastReported &&
      !Options.Change.Changed(lastReported.Value, Snapshot) &&
      Now - lastEmitAt < Options.KeepaliveIntervalMs
    ) {
      return;
    }
    Emit(Socket, Snapshot, Now);
  }

  /** Sample now, or share (or queue behind) the sample already running. */
  function Sample(Request: SampleOptions<TRead> = {}): Promise<void> {
    if (inFlight) {
      if (!Request.Queue) return inFlight;
      return inFlight.then(() => Sample(Request));
    }
    const Current = SampleAndReport(Request, generation)
      .catch((error: unknown) => {
        Options.Logger.warn(`${Options.Noun} sample threw: ${ErrorText(error, 'unknown error')}`);
      })
      .finally(() => {
        if (inFlight === Current) inFlight = null;
      });
    inFlight = Current;
    return Current;
  }

  function BeginSession(Socket: ShowTrakSocket | null): void {
    if (pollTimer) clearInterval(pollTimer);
    if (delayTimer) clearTimeout(delayTimer);
    pollTimer = null;
    delayTimer = null;
    generation += 1;
    activeSocket = Socket;
    lastReported = null;
    lastEmitAt = 0;
    if (!Options.KeepLastSnapshot) lastSnapshot = null;
    inFlight = null;
  }

  return {
    /**
     * Begin reporting on a freshly connected socket. The first sample (read with
     * `First`) is always reported; this resolves once it has been.
     */
    Start(Socket: ShowTrakSocket | null, First: SampleOptions<TRead> = {}): Promise<void> {
      BeginSession(Socket || null);
      pollTimer = setInterval(() => {
        void Sample();
      }, Options.PollIntervalMs);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      return Sample({ ...First, ForceEmit: true, Queue: true });
    },

    /** Stop reporting: the connection dropped, or the client is shutting down. */
    Stop(): void {
      BeginSession(null);
    },

    Sample,

    /**
     * Sample `DelayMs` from now, because something that may have changed the
     * reading just happened. A burst coalesces into one sample after the last of
     * it. Ignored while stopped.
     */
    SampleAfter(DelayMs: number, Request: SampleOptions<TRead>): void {
      if (!activeSocket) return;
      if (delayTimer) clearTimeout(delayTimer);
      delayTimer = setTimeout(() => {
        delayTimer = null;
        void Sample(Request);
      }, DelayMs);
      if (typeof delayTimer.unref === 'function') delayTimer.unref();
    },

    /** Whether a session is running (started, and not stopped since). */
    IsActive(): boolean {
      return activeSocket !== null;
    },

    IsConnected(): boolean {
      return !!activeSocket && activeSocket.connected;
    },

    LastSnapshot(): TSnapshot | null {
      return lastSnapshot;
    },

    ForgetLastSnapshot(): void {
      lastSnapshot = null;
    },

    /**
     * Report a snapshot made outside the poll, at once, to the connected socket;
     * nothing happens without one. It becomes the last snapshot, and the
     * baseline later samples are compared with.
     */
    Report(Snapshot: TSnapshot): void {
      const Socket = activeSocket;
      if (!Socket || !Socket.connected) return;
      lastSnapshot = Snapshot;
      Emit(Socket, Snapshot);
    },
  };
}
