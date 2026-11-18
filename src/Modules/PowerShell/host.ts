import { spawn, type ChildProcess } from 'child_process';

import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import { LowerChildPriority } from '../Utils/process-priority';

/**
 * A long-lived `powershell.exe` that evaluates scripts fed over stdin.
 *
 * Why this exists: a cold PowerShell start is ~300-800ms of CPU and ~40MB of
 * RSS before it runs a single statement. Keeping one host alive moves that cost
 * to once per session: later requests are a stdin write and a stdout read.
 *
 * Requests are QUEUED and run one at a time, in order. Every Windows sampler
 * used to own a host of its own (seven powershell.exe processes, plus a conhost
 * each, on a connected client) because a host refused a second concurrent
 * request; a queue lets a handful of samplers on unrelated timers share one.
 * A request's deadline starts when it is sent to PowerShell, not when it is
 * queued, so a slow neighbour delays a request but never times it out.
 *
 * Session setup (compiling a C# shim, defining a function) rides along as a
 * request's `Prelude`: it is sent once per powershell.exe, ahead of the first
 * request that needs it, rather than with every request.
 *
 * An idle host shuts itself down after `IdleMs` without a request, so a client
 * that lost its server stops holding the process — but one that reconnects
 * within that window (the common case: a switch reboot, a server restart) keeps
 * its warm session and compiled shims.
 *
 * The host is deliberately failure-tolerant rather than clever. Every call site
 * treats a failed Run() as "no sample this time" (see ./index.ts for the shared
 * fallback policy), so a host that dies, hangs or never starts degrades to the
 * old one-shot behaviour instead of blinding the monitor.
 */

// Emitted around each script so the reader can find the payload regardless of
// any banner, prompt or progress noise PowerShell decides to write. The tokens
// are deliberately unlikely to occur in a process name.
const BEGIN_TOKEN = '<<<ShowTrak:BEGIN>>>';
const END_TOKEN = '<<<ShowTrak:END>>>';
const ERROR_PREFIX = '<<<ShowTrak:ERROR>>>';

// Written once when the host starts. Without the encoding line, process names
// containing non-ASCII characters arrive mojibaked on any non-UTF-8 codepage.
const INIT_SCRIPT = [
  '$ProgressPreference = "SilentlyContinue"',
  '$ErrorActionPreference = "Continue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
].join('; ');

/** A cold powershell.exe spends this long starting before it reads its first line. */
const STARTUP_ALLOWANCE_MS = 10000;
/** Requests waiting beyond this many is a host that is not keeping up: refuse more. */
const MAX_QUEUED = 16;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/**
 * Set as `code` on the error a Run() resolves with when the script itself was the
 * problem — it ran past its deadline, or raised — rather than the host. A fresh
 * powershell.exe would only do the same again, so callers skip their one-shot
 * fallback for these.
 */
export const SCRIPT_TIMED_OUT = 'ETIMEDOUT';
export const SCRIPT_FAILED = 'ESCRIPT';
/** The queue is full. A one-shot spawn would only add to the load, so no fallback either. */
export const HOST_BUSY = 'EBUSY';

/** Whether a Run() error came from the script rather than the host. */
export function IsScriptFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return code === SCRIPT_TIMED_OUT || code === SCRIPT_FAILED;
}

/** Whether a fresh one-shot powershell.exe could be expected to do better than the host did. */
export function IsWorthFallingBack(error: unknown): boolean {
  if (IsScriptFailure(error)) return false;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return code !== HOST_BUSY;
}

function TaggedError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) Object.assign(error, { code });
  return error;
}

/** Session setup a script depends on. Sent once per powershell.exe. */
export interface PowerShellPrelude {
  /** Identifies the prelude; two requests with the same key share one send. */
  Key: string;
  /** One line of PowerShell. Its output is discarded and its errors are swallowed. */
  Script: string;
  /** Extra deadline for the request that carries it (a C# compile takes a second or two). */
  ExtraTimeoutMs?: number;
}

export interface RunOptions {
  TimeoutMs: number;
  Prelude?: PowerShellPrelude;
}

interface QueuedRequest {
  Script: string;
  Options: RunOptions;
  Resolve: (value: Result<string>) => void;
}

interface ActiveRequest {
  Resolve: (value: Result<string>) => void;
  Timer: NodeJS.Timeout | null;
}

export interface PowerShellHost {
  readonly Name: string;
  Run(Script: string, Options: RunOptions | number): Promise<Result<string>>;
  /** Stop the host now. Queued requests fail; the next Run() starts a fresh one. */
  Dispose(): void;
  /** Whether a powershell.exe is currently running for this host. */
  IsRunning(): boolean;
  /** Test seam: forget the "spawn failed" latch and stop the host. */
  _reset(): void;
}

export interface HostOptions {
  /** Shut down after this long without a request. 0 disables the idle shutdown. */
  IdleMs?: number;
  /** Extra deadline for the first request into a fresh powershell.exe. */
  StartupAllowanceMs?: number;
}

/** Create an independent host. Nothing is spawned until the first Run(). */
export function CreatePowerShellHost(
  Name = 'PowerShellHost',
  Options: HostOptions = {}
): PowerShellHost {
  const Logger = CreateLogger(Name);
  const IdleMs = Options.IdleMs ?? DEFAULT_IDLE_MS;
  const StartupAllowanceMs = Options.StartupAllowanceMs ?? STARTUP_ALLOWANCE_MS;

  let child: ChildProcess | null = null;
  let buffer = '';
  let active: ActiveRequest | null = null;
  const queue: QueuedRequest[] = [];
  /** Preludes already sent to the running powershell.exe. Reset with every spawn. */
  let preludes = new Set<string>();
  /** True until the running powershell.exe has answered once. */
  let cold = true;
  let idleTimer: NodeJS.Timeout | null = null;
  /**
   * Set when a spawn attempt fails outright (no powershell.exe on PATH, blocked by
   * policy). Once unavailable we stop retrying the spawn on every request — the
   * caller's one-shot fallback would fail for the same reason anyway, and retrying
   * a failing spawn every few seconds is its own performance problem.
   */
  let unavailable = false;

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(): void {
    clearIdle();
    if (!IdleMs || !child) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (active || queue.length) return;
      if (!child) return;
      killChild('PowerShell host idle');
      Logger.debug(`PowerShell host stopped after ${Math.round(IdleMs / 1000)}s idle`);
    }, IdleMs);
    // Never the reason the app cannot quit.
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function settle(result: Result<string>): void {
    const request = active;
    active = null;
    if (!request) return;
    if (request.Timer) clearTimeout(request.Timer);
    request.Resolve(result);
  }

  function killChild(reason: string, code?: string): void {
    const dying = child;
    child = null;
    buffer = '';
    preludes = new Set();
    cold = true;
    if (dying) {
      dying.removeAllListeners();
      if (dying.stdout) dying.stdout.removeAllListeners();
      if (dying.stderr) dying.stderr.removeAllListeners();
      try {
        dying.kill();
      } catch (_error) {
        // Already gone; nothing to do.
      }
    }
    settle([TaggedError(reason, code), null]);
  }

  /**
   * The host died or was killed under the active request. Requests still queued
   * were never sent, so they get a fresh powershell.exe rather than the error.
   */
  function failActive(reason: string, code?: string): void {
    killChild(reason, code);
    setImmediate(pump);
  }

  // Drain whole responses out of the rolling stdout buffer. Anything before a
  // BEGIN token is noise from the host itself and is discarded.
  function consumeBuffer(): void {
    for (;;) {
      const beginAt = buffer.indexOf(BEGIN_TOKEN);
      if (beginAt === -1) {
        // Keep only a token's worth of tail, so a BEGIN split across two chunks
        // still matches while the buffer cannot grow without bound.
        if (buffer.length > BEGIN_TOKEN.length) {
          buffer = buffer.slice(buffer.length - BEGIN_TOKEN.length);
        }
        return;
      }
      const endAt = buffer.indexOf(END_TOKEN, beginAt);
      if (endAt === -1) return; // Response still arriving.

      const body = buffer.slice(beginAt + BEGIN_TOKEN.length, endAt);
      buffer = buffer.slice(endAt + END_TOKEN.length);
      cold = false;

      const errorAt = body.indexOf(ERROR_PREFIX);
      if (errorAt !== -1) {
        const message = body.slice(errorAt + ERROR_PREFIX.length).trim();
        settle([TaggedError(message || 'PowerShell script failed', SCRIPT_FAILED), null]);
      } else {
        settle([null, body]);
      }
      pump();
    }
  }

  function ensureChild(): ChildProcess | null {
    if (child) return child;
    if (unavailable) return null;

    let spawned: ChildProcess;
    try {
      spawned = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (error) {
      unavailable = true;
      Logger.warn('Could not start the PowerShell host; falling back to one-shot samples', error);
      return null;
    }

    if (!spawned.stdin || !spawned.stdout) {
      unavailable = true;
      Logger.warn('PowerShell host started without usable pipes; falling back to one-shot samples');
      try {
        spawned.kill();
      } catch (_error) {
        // Nothing useful to do.
      }
      return null;
    }

    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      consumeBuffer();
    });
    // stderr is drained but not surfaced: PowerShell writes non-terminating error
    // records there, and the script's own try/catch already reports the failures
    // that matter. Leaving it unread would eventually block the child on a full pipe.
    if (spawned.stderr) spawned.stderr.resume();

    spawned.on('error', (error: Error) => {
      if (spawned !== child) return;
      // A spawn-time ENOENT lands here rather than as a throw. An error before
      // the host ever answered means it cannot start here; stop trying.
      if (cold) unavailable = true;
      failActive(`PowerShell host error: ${error.message}`);
    });
    spawned.on('exit', () => {
      // Not marked unavailable: an exit can be a one-off crash, and the next
      // request is allowed to try again.
      if (spawned === child) failActive('PowerShell host exited');
    });

    child = spawned;
    preludes = new Set();
    cold = true;
    // The samplers are background work; the show must win any contention for
    // the CPU. The client's own process keeps its priority, since the scripts it
    // launches inherit it.
    LowerChildPriority(spawned);
    try {
      spawned.stdin.write(`${INIT_SCRIPT}\n`);
    } catch (error) {
      killChild(`PowerShell host init failed: ${(error as Error).message}`);
      return null;
    }
    Logger.log('PowerShell host started');
    return spawned;
  }

  /** Send the next queued request, if the host is free. */
  function pump(): void {
    if (active) return;
    const next = queue.shift();
    if (!next) {
      armIdle();
      return;
    }
    clearIdle();

    const running = ensureChild();
    if (!running || !running.stdin) {
      next.Resolve([new Error('PowerShell host unavailable'), null]);
      // Everything else queued would meet the same fate; answer it now.
      setImmediate(pump);
      return;
    }

    const { Script, Options } = next;
    const prelude = Options.Prelude && !preludes.has(Options.Prelude.Key) ? Options.Prelude : null;
    const timeoutMs =
      Math.max(1, Number(Options.TimeoutMs) || 0) +
      (cold ? StartupAllowanceMs : 0) +
      (prelude ? Math.max(0, prelude.ExtraTimeoutMs || 0) : 0);

    const timer = setTimeout(() => {
      failActive(`PowerShell host timed out after ${timeoutMs}ms`, SCRIPT_TIMED_OUT);
    }, timeoutMs);
    // Do not hold the event loop open on a sampler's account; the app should
    // still be able to quit between samples.
    if (typeof timer.unref === 'function') timer.unref();
    active = { Resolve: next.Resolve, Timer: timer };

    // One line, so the host evaluates it as a single statement chunk. The
    // try/catch keeps a failing script from taking down a host we want to reuse.
    // A prelude's output is discarded and its failure swallowed: the script that
    // needs it checks for what it provides and says so when it is missing.
    const setup = prelude ? `try { $null = & { ${prelude.Script} } } catch { }; ` : '';
    const wrapped =
      `${setup}Write-Output '${BEGIN_TOKEN}'; ` +
      `try { ${Script} } catch { Write-Output ('${ERROR_PREFIX}' + $_.Exception.Message) }; ` +
      `Write-Output '${END_TOKEN}'\n`;

    if (prelude) preludes.add(prelude.Key);
    try {
      running.stdin.write(wrapped);
    } catch (error) {
      failActive(`PowerShell host write failed: ${(error as Error).message}`);
    }
  }

  return {
    Name,

    /**
     * Evaluate `Script` in the host and resolve with everything it wrote to stdout.
     *
     * Resolves `[error, null]` — never rejects — when the host is unavailable, the
     * script raised, the queue is full, or the deadline elapsed. A timeout also
     * tears the host down, on the assumption that a host which missed one deadline
     * is wedged; anything queued behind it runs in a fresh one.
     */
    Run(Script: string, Options: RunOptions | number): Promise<Result<string>> {
      const RunOptions_: RunOptions =
        typeof Options === 'number' ? { TimeoutMs: Options } : Options;
      if (unavailable && !child) {
        return Promise.resolve([new Error('PowerShell host unavailable'), null]);
      }
      if (queue.length >= MAX_QUEUED) {
        return Promise.resolve([TaggedError('PowerShell host is busy', HOST_BUSY), null]);
      }
      return new Promise<Result<string>>((resolve) => {
        queue.push({ Script, Options: RunOptions_, Resolve: resolve });
        pump();
      });
    },

    Dispose(): void {
      clearIdle();
      const pending = queue.splice(0);
      if (child) {
        killChild('PowerShell host disposed');
        Logger.log('PowerShell host stopped');
      }
      for (const request of pending) {
        request.Resolve([new Error('PowerShell host disposed'), null]);
      }
    },

    IsRunning(): boolean {
      return !!child;
    },

    _reset(): void {
      clearIdle();
      const pending = queue.splice(0);
      killChild('PowerShell host reset');
      for (const request of pending) {
        request.Resolve([new Error('PowerShell host reset'), null]);
      }
      unavailable = false;
    },
  };
}

export const _constants = { STARTUP_ALLOWANCE_MS, MAX_QUEUED, DEFAULT_IDLE_MS };
