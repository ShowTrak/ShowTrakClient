// The client's PowerShell, in one place.
//
// Every Windows sampler reads through PowerShell, and each used to own a
// persistent powershell.exe of its own — seven of them, ~40-80MB each plus a
// conhost, on every connected client — and its own copy of the "host, else a
// one-shot spawn" wrapper, with subtly different fallback rules. They now share
// two hosts and one policy:
//
//   Desktop  user32 and Core Audio calls through compiled C# shims: the running
//            applications (every 3s) and the audio endpoints. Answers in
//            milliseconds once warm, so nothing slow is ever queued in front of
//            the 3-second sampler.
//   WMI      CIM queries: power, temperatures, storage, USB device state and
//            display identity. Some of these take seconds (a cold WMI provider,
//            the Storage module), which is exactly why they are kept apart from
//            the Desktop host.
//
// Both shut down after five idle minutes, so a client that lost its server
// stops holding them, while one that reconnects inside that window — the common
// case — keeps its warm session and compiled shims.
import { execFile } from 'child_process';

import type { Result } from '../../types/client';
import { LowerChildPriority } from '../Utils/process-priority';
import {
  CreatePowerShellHost,
  IsWorthFallingBack,
  type PowerShellHost,
  type PowerShellPrelude,
} from './host';

export {
  CreatePowerShellHost,
  HOST_BUSY,
  IsScriptFailure,
  IsWorthFallingBack,
  SCRIPT_FAILED,
  SCRIPT_TIMED_OUT,
} from './host';
export type { PowerShellHost, PowerShellPrelude, RunOptions } from './host';

const IDLE_MS = 5 * 60 * 1000;

export const Hosts = {
  Desktop: CreatePowerShellHost('PowerShell:Desktop', { IdleMs: IDLE_MS }),
  Wmi: CreatePowerShellHost('PowerShell:WMI', { IdleMs: IDLE_MS }),
};

export const ONE_SHOT_TIMEOUT_MS = 8000;

/**
 * Run a script in a fresh, short-lived powershell.exe. The fallback for a host
 * that is unavailable or died under a request. `$ErrorActionPreference = 'Stop'`
 * so a failing cmdlet fails the run rather than printing to stderr and exiting 0.
 */
export function RunOneShot(
  Script: string,
  TimeoutMs: number = ONE_SHOT_TIMEOUT_MS
): Promise<Result<string>> {
  return new Promise((resolve) => {
    let Child: unknown;
    try {
      Child = execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$ErrorActionPreference = 'Stop'; ${Script}`,
        ],
        { timeout: TimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (Error_, Stdout) => {
          if (Error_) return resolve([Error_, null]);
          return resolve([null, String(Stdout || '')]);
        }
      );
    } catch (Error_) {
      resolve([Error_, null]);
      return;
    }
    LowerChildPriority(Child);
  });
}

export interface PowerShellRequest {
  /** Deadline once the request reaches PowerShell. */
  TimeoutMs: number;
  /** Session setup the script needs; sent once per host process. */
  Prelude?: PowerShellPrelude;
  /**
   * What a one-shot fallback runs. Defaults to the prelude (if any) and the
   * script; `false` disables the fallback.
   */
  Fallback?: string | false;
  /** Deadline for the fallback. */
  FallbackTimeoutMs?: number;
}

/**
 * Run `Script` in `Host`, falling back to a one-shot powershell.exe only when the
 * host itself could not run it (unavailable, crashed, died mid-request). A script
 * that raised or ran past its deadline would do the same again in a fresh
 * process — and pay a cold start to do it — so those are returned as they are.
 */
export async function RunPowerShell(
  Host: PowerShellHost,
  Script: string,
  Request: PowerShellRequest
): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, {
    TimeoutMs: Request.TimeoutMs,
    ...(Request.Prelude ? { Prelude: Request.Prelude } : {}),
  });
  if (!HostError && Output !== null) return [null, Output];
  if (Request.Fallback === false || !IsWorthFallingBack(HostError)) return [HostError, null];
  const Fallback =
    Request.Fallback ?? (Request.Prelude ? `${Request.Prelude.Script}; ${Script}` : Script);
  return RunOneShot(Fallback, Request.FallbackTimeoutMs ?? ONE_SHOT_TIMEOUT_MS);
}

/**
 * What a script printed, through `Parse`. A run that failed or printed nothing,
 * and output that `Parse` throws on, are errors.
 */
export function ParseOutput<T>(Outcome: Result<string>, Parse: (Output: string) => T): Result<T> {
  const [Error_, Output] = Outcome;
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [null, Parse(Output)];
  } catch (error) {
    return [error, null];
  }
}

/** Stop both hosts now (the app is quitting). Each restarts on its next request. */
export function DisposeAll(): void {
  Hosts.Desktop.Dispose();
  Hosts.Wmi.Dispose();
}

/**
 * The rows of a list-valued property in PowerShell's JSON. Three shapes reach us:
 * an array; one bare object, where a single-element list was unrolled; and, from
 * Windows PowerShell 5.1, `{"value":[...],"Count":n}` when the array was wrapped
 * in a PSObject on its way into the property — a long-standing ConvertTo-Json
 * quirk that would otherwise read as one malformed row.
 */
export function JsonRows(Value: unknown): unknown[] {
  if (Array.isArray(Value)) return Value;
  if (!Value || typeof Value !== 'object') return [];
  const Wrapped = (Value as { value?: unknown }).value;
  return Array.isArray(Wrapped) ? Wrapped : [Value];
}

/**
 * The last line of a script's output that is a JSON value of the given kind.
 * Anything before it is PowerShell noise (a warning, a progress record).
 */
export function LastJsonLine(Output: string, Kinds: Array<'{' | '['> = ['{', '[']): string | null {
  const Lines = String(Output || '')
    .split(/\r?\n/)
    .map((Entry) => Entry.trim());
  for (let Index = Lines.length - 1; Index >= 0; Index -= 1) {
    const Line = Lines[Index]!;
    for (const Kind of Kinds) {
      const Close = Kind === '{' ? '}' : ']';
      if (Line.startsWith(Kind) && Line.endsWith(Close)) return Line;
    }
  }
  return null;
}
