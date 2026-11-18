// Batches a running script's console output for the server's console view.
//
// Output arrives in whatever pieces the OS hands over; sending each one as its
// own socket event would flood the connection for a chatty script. Instead the
// streamer collects output for FLUSH_MS (or until a batch is BATCH_CHARS big),
// merging consecutive writes to the same stream, and sends one
// `ScriptExecutionOutput` per batch.
//
// Bounded: after MAX_RUN_CHARS of output in one run it stops sending and marks
// the last batch `truncated`, so the server can say why the console stops. The
// script itself is unaffected; its output is still read and kept locally.
//
// Only used when the server advertised `ExecutionOutput` (older servers would
// drop the event). Flush() must be called before the run's result is sent so
// the console is complete by the time the server records the outcome.

import type { ScriptOutputChunk } from '@showtrak/protocol';

export const FLUSH_MS = 250;
/** Send early once a batch holds this much. */
export const BATCH_CHARS = 64 * 1024;
/** The server's per-chunk limit; longer text is split into several chunks. */
export const MAX_CHUNK_CHARS = 32 * 1024;
/** Stop sending after this much output in one run. */
export const MAX_RUN_CHARS = 1024 * 1024;

export type OutputSender = (Chunks: ScriptOutputChunk[], Truncated: boolean) => void;

export interface OutputStreamer {
  Write(Stream: 'stdout' | 'stderr', Text: string): void;
  /** Send whatever is pending now. */
  Flush(): void;
  /** Flush and stop (no timer is left behind). */
  Close(): void;
}

export function CreateOutputStreamer(
  Send: OutputSender,
  Options: { FlushMs?: number; MaxRunChars?: number } = {}
): OutputStreamer {
  const FlushMs = Options.FlushMs ?? FLUSH_MS;
  const MaxRunChars = Options.MaxRunChars ?? MAX_RUN_CHARS;
  let Pending: ScriptOutputChunk[] = [];
  let PendingChars = 0;
  let SentChars = 0;
  let Truncated = false;
  let TruncationSent = false;
  let Closed = false;
  let Timer: ReturnType<typeof setTimeout> | null = null;

  const Flush = () => {
    if (Timer) {
      clearTimeout(Timer);
      Timer = null;
    }
    const MustReportTruncation = Truncated && !TruncationSent;
    if (!Pending.length && !MustReportTruncation) return;
    // Split anything longer than the server accepts in one chunk.
    const Chunks: ScriptOutputChunk[] = [];
    for (const Chunk of Pending) {
      for (let At = 0; At < Chunk.Text.length; At += MAX_CHUNK_CHARS) {
        Chunks.push({ Stream: Chunk.Stream, Text: Chunk.Text.slice(At, At + MAX_CHUNK_CHARS) });
      }
    }
    Pending = [];
    PendingChars = 0;
    if (MustReportTruncation) TruncationSent = true;
    try {
      Send(Chunks, MustReportTruncation);
    } catch {
      // A dropped batch only costs the console view some lines.
    }
  };

  return {
    Write(Stream, Text) {
      if (Closed || Truncated || !Text) return;
      let Value = String(Text);
      const Room = MaxRunChars - SentChars;
      if (Value.length >= Room) {
        Value = Value.slice(0, Math.max(0, Room));
        Truncated = true;
      }
      if (Value) {
        SentChars += Value.length;
        const Last = Pending[Pending.length - 1];
        if (Last && Last.Stream === Stream) Last.Text += Value;
        else Pending.push({ Stream, Text: Value });
        PendingChars += Value.length;
      }
      if (Truncated || PendingChars >= BATCH_CHARS) {
        Flush();
        return;
      }
      if (!Timer) {
        Timer = setTimeout(Flush, FlushMs);
        if (typeof Timer.unref === 'function') Timer.unref();
      }
    },
    Flush,
    Close() {
      if (Closed) return;
      Flush();
      Closed = true;
    },
  };
}
