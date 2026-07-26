import { execFile } from 'child_process';
import os from 'os';

import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import { Manager as PowerShellHost } from './powershell-host';

const Logger = CreateLogger('ProcessMonitor');

const COMMAND_TIMEOUT_MS = 8000;
// The host answers in single-digit milliseconds once warm, so a short deadline
// still leaves room for a first call that has to pay the cold start.
const HOST_TIMEOUT_MS = 5000;

export function execFileAsync(command: string, args: string[]): Promise<[unknown, string]> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve([error, '']);
        return resolve([null, String(stdout || '')]);
      }
    );
  });
}

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Foreground applications are those owning a top-level window. MainWindowHandle
// is the same discriminator the one-shot sampler used, so switching to the
// persistent host does not change which processes are reported.
const WINDOWS_QUERY =
  'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName } ' +
  '| Select-Object -ExpandProperty ProcessName';

export async function collectWindowsApplications(): Promise<Result<string[]>> {
  const [hostError, stdout] = await PowerShellHost.Run(WINDOWS_QUERY, HOST_TIMEOUT_MS);
  if (!hostError && stdout !== null) return [null, splitLines(stdout)];

  // The host is unavailable or wedged. Fall back to the pre-existing one-shot
  // spawn so a broken host costs latency rather than the whole signal.
  Logger.debug('PowerShell host sample failed; falling back to a one-shot spawn');
  const [error, oneShot] = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${WINDOWS_QUERY}`,
  ]);
  if (error) return [error, null];
  return [null, splitLines(oneShot)];
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

// `lsappinfo visibleProcessList` returns one line of
//   ASN:0x0-0x64d04ca-"Code": ASN:0x0-0x654b545-"GitHub_Desktop": ...
// Names in that listing have spaces replaced with underscores, so the embedded
// name is only a fallback; the real one is resolved per ASN and cached.
const ASN_PATTERN = /(ASN:0x[0-9a-f]+-0x[0-9a-f]+)-"([^"]*)"/gi;
const DISPLAY_NAME_PATTERN = /"LSDisplayName"\s*=\s*"([^"]*)"/i;

/**
 * ASN -> display name. An ASN is unique to one launch of one application, so a
 * cached name can never go stale: a relaunched app gets a new ASN. Entries for
 * applications that are no longer running are dropped after each sample.
 */
const displayNameCache = new Map<string, string>();

async function resolveDisplayName(asn: string, fallback: string): Promise<string> {
  const cached = displayNameCache.get(asn);
  if (cached) return cached;

  const [error, stdout] = await execFileAsync('lsappinfo', ['info', '-only', 'LSDisplayName', asn]);
  let resolved = fallback;
  if (!error) {
    const match = DISPLAY_NAME_PATTERN.exec(String(stdout));
    if (match && match[1] && match[1].trim()) resolved = match[1].trim();
  }
  displayNameCache.set(asn, resolved);
  return resolved;
}

/**
 * The macOS sampler.
 *
 * This replaced an `osascript` query against System Events. That query cost
 * ~1.2 SECONDS of wall time per sample (measured; almost all of it Apple Events
 * round-trip rather than our own CPU) and required Automation permission, which
 * is what produced the monitor's `permission_denied` state. `lsappinfo` answers
 * the same question — applications with a visible presence, i.e. System Events'
 * "background only is false" — in ~4ms and needs no permission grant at all.
 *
 * The per-ASN name lookup is paid once per application launch, not once per
 * sample, so the steady-state cost of a poll is the single 4ms call.
 */
export async function collectMacApplications(): Promise<Result<string[]>> {
  const [error, stdout] = await execFileAsync('lsappinfo', ['visibleProcessList']);
  if (!error) {
    const seen = new Set<string>();
    const pending: Promise<string>[] = [];
    ASN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ASN_PATTERN.exec(String(stdout))) !== null) {
      const asn = match[1] || '';
      if (!asn || seen.has(asn)) continue;
      seen.add(asn);
      pending.push(resolveDisplayName(asn, match[2] || ''));
    }

    if (pending.length > 0) {
      const names = (await Promise.all(pending)).map((name) => name.trim()).filter(Boolean);
      // Drop names for applications that have since quit, so the cache tracks
      // what is running rather than everything ever seen this session.
      for (const asn of displayNameCache.keys()) {
        if (!seen.has(asn)) displayNameCache.delete(asn);
      }
      return [null, names];
    }
  }

  // Either lsappinfo is missing/failed, or it reported nothing at all. A live
  // desktop always has at least Finder, so an empty list means we are not seeing
  // the GUI session properly — in both cases fall back to the System Events
  // query, which is slow but authoritative (and reports its own permission
  // errors, which the caller classifies).
  Logger.debug('lsappinfo gave no usable result; falling back to System Events');
  return collectMacApplicationsViaSystemEvents();
}

async function collectMacApplicationsViaSystemEvents(): Promise<Result<string[]>> {
  const script = [
    'set output to {}',
    'tell application "System Events"',
    'repeat with proc in (application processes where background only is false)',
    'set end of output to name of proc',
    'end repeat',
    'end tell',
    'set text item delimiters to linefeed',
    'return output as text',
  ].join('\n');
  const [error, stdout] = await execFileAsync('osascript', ['-e', script]);
  if (error) return [error, null];
  return [null, splitLines(stdout)];
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

export async function collectLinuxApplications(): Promise<Result<string[]>> {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch (_error) {
    // Fall back to process listing without user filtering.
  }
  const args = username ? ['-u', username, '-o', 'comm='] : ['-e', '-o', 'comm='];
  const [error, stdout] = await execFileAsync('ps', args);
  if (error) return [error, null];
  return [null, splitLines(stdout)];
}

// ---------------------------------------------------------------------------

export async function collectRunningApplications(): Promise<Result<string[]>> {
  if (process.platform === 'win32') return collectWindowsApplications();
  if (process.platform === 'darwin') return collectMacApplications();
  return collectLinuxApplications();
}

/** Release any resident sampler state. Called when the monitor stops. */
export function disposeSamplers(): void {
  PowerShellHost.Dispose();
  displayNameCache.clear();
}

export const _internal = { displayNameCache };
