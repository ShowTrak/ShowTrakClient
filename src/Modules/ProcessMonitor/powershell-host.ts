import { spawn, type ChildProcess } from 'child_process';

import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('PowerShellHost');

/**
 * A single long-lived `powershell.exe` that evaluates scripts fed over stdin.
 *
 * Why this exists: the running-application sampler used to spawn a fresh
 * powershell.exe per sample. A cold PowerShell start is ~300-800ms of CPU and
 * ~40MB of RSS before it runs a single statement, which is affordable at the old
 * 20-second poll and emphatically is not at the 3-second poll this module now
 * runs. Keeping one host alive moves that cost to once per session: subsequent
 * samples are a stdin write and a stdout read.
 *
 * The host is deliberately failure-tolerant rather than clever. Every call site
 * treats a rejected Run() as "no sample this tick" and ProcessMonitor falls back
 * to a one-shot spawn, so a host that dies, hangs or never starts degrades to the
 * old behaviour instead of blinding the monitor.
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

interface PendingRequest {
  resolve: (value: Result<string>) => void;
  timer: NodeJS.Timeout | null;
}

let child: ChildProcess | null = null;
let buffer = '';
let pending: PendingRequest | null = null;
/**
 * Set when a spawn attempt fails outright (no powershell.exe on PATH, blocked by
 * policy). Once unavailable we stop retrying the spawn on every sample — the
 * caller's one-shot fallback would fail for the same reason anyway, and retrying
 * a failing spawn every 3 seconds is its own performance problem.
 */
let unavailable = false;

function settle(result: Result<string>): void {
  const request = pending;
  pending = null;
  if (!request) return;
  if (request.timer) clearTimeout(request.timer);
  request.resolve(result);
}

/** Tear the host down, failing any in-flight request. Safe to call repeatedly. */
function destroy(reason: string): void {
  const dying = child;
  child = null;
  buffer = '';
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
  settle([new Error(reason), null]);
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

    const errorAt = body.indexOf(ERROR_PREFIX);
    if (errorAt !== -1) {
      const message = body.slice(errorAt + ERROR_PREFIX.length).trim();
      settle([new Error(message || 'PowerShell script failed'), null]);
      continue;
    }
    settle([null, body]);
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
    // A spawn-time ENOENT lands here rather than as a throw.
    if (spawned === child) unavailable = true;
    destroy(`PowerShell host error: ${error.message}`);
  });
  spawned.on('exit', () => {
    // Not marked unavailable: an exit can be a one-off crash, and the next
    // sample is allowed to try again.
    if (spawned === child) destroy('PowerShell host exited');
  });

  child = spawned;
  try {
    spawned.stdin.write(`${INIT_SCRIPT}\n`);
  } catch (error) {
    destroy(`PowerShell host init failed: ${(error as Error).message}`);
    return null;
  }
  Logger.log('PowerShell host started');
  return spawned;
}

export const Manager = {
  /**
   * Evaluate `script` in the host and resolve with everything it wrote to stdout.
   *
   * Resolves `[error, null]` — never rejects — when the host is unavailable, the
   * script raised, or `timeoutMs` elapsed. A timeout also tears the host down, on
   * the assumption that a host which missed one deadline is wedged.
   */
  Run(script: string, timeoutMs: number): Promise<Result<string>> {
    if (pending) {
      return Promise.resolve([new Error('PowerShell host is busy'), null]);
    }
    const active = ensureChild();
    if (!active || !active.stdin) {
      return Promise.resolve([new Error('PowerShell host unavailable'), null]);
    }

    return new Promise<Result<string>>((resolve) => {
      const timer = setTimeout(() => {
        destroy(`PowerShell host timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      // Do not hold the event loop open on the sampler's account; the app should
      // still be able to quit between samples.
      if (typeof timer.unref === 'function') timer.unref();
      pending = { resolve, timer };

      // One line, so the host evaluates it as a single statement chunk. The
      // try/catch keeps a failing script from taking down a host we want to reuse.
      const wrapped =
        `Write-Output '${BEGIN_TOKEN}'; ` +
        `try { ${script} } catch { Write-Output ('${ERROR_PREFIX}' + $_.Exception.Message) }; ` +
        `Write-Output '${END_TOKEN}'\n`;

      try {
        active.stdin!.write(wrapped);
      } catch (error) {
        destroy(`PowerShell host write failed: ${(error as Error).message}`);
      }
    });
  },

  /** Stop the host. The next Run() starts a fresh one. */
  Dispose(): void {
    if (!child) return;
    destroy('PowerShell host disposed');
    Logger.log('PowerShell host stopped');
  },

  /** Test seam: forget the "spawn failed" latch. */
  _reset(): void {
    destroy('PowerShell host reset');
    unavailable = false;
  },
};
