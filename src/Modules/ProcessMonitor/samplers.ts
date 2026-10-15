import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import os from 'os';

import type { RunningApplicationsCapabilities } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import { FindOnPath } from '../Utils';
import { Manager as PowerShellHost } from './powershell-host';

const Logger = CreateLogger('ProcessMonitor');

const COMMAND_TIMEOUT_MS = 8000;
// The host answers in single-digit milliseconds once warm, so a short deadline
// still leaves room for a first call that has to pay the cold start.
const HOST_TIMEOUT_MS = 5000;
// ...except the first call into a fresh host also compiles the window shim
// (Add-Type), which takes a second or two on a fast machine and more on a slow
// one. Holding that call to the warm deadline would time it out, kill the host,
// and recompile in the next one — forever. So the deadline is generous until a
// host has answered once.
const COLD_HOST_TIMEOUT_MS = 20000;
let hostWarm = false;

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

/** One windowed process, as a platform sampler saw it. */
export interface ApplicationProcess {
  Name: string;
  /**
   * The window manager's hung verdict for this process's main window: false
   * when hung. Omitted when the platform cannot tell; null when it can but could
   * not read this process this time.
   */
  Responding?: boolean | null;
}

/** Everything one sample of the platform produced. */
export interface ApplicationSample {
  Processes: ApplicationProcess[];
  /**
   * Raw name of the process owning the focused window. Undefined when the
   * platform cannot report it (Capabilities.Foreground false); null when it can,
   * but nothing is focused or the owner could not be read.
   */
  Foreground?: string | null;
  Capabilities: RunningApplicationsCapabilities;
}

const NO_CAPABILITIES: RunningApplicationsCapabilities = { Responding: false, Foreground: false };

function namesOnly(names: string[]): ApplicationProcess[] {
  return names.map((Name) => ({ Name }));
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

/**
 * user32 calls PowerShell has no cmdlet for: which window has focus and who owns
 * it, and whether a window is hung.
 *
 * Hung detection deliberately uses IsHungAppWindow rather than Get-Process's
 * `.Responding`. That property is a SendMessageTimeout with a FIVE SECOND
 * timeout per window: a window that has only just stopped pumping messages makes
 * the whole query wait it out, which would blow the host's deadline on the very
 * sample that matters and tear the host down. IsHungAppWindow is the window
 * manager's own verdict (the one that ghosts the window and appends "Not
 * Responding" to its title) and answers immediately.
 *
 * Compiled once per host with Add-Type: ~1s the first time, then a method call.
 * C# 5 for the same reason as the audio shim: Windows PowerShell 5.1 compiles
 * with the .NET Framework compiler.
 */
export const WINDOWS_WINDOW_SHIM = `
using System;
using System.Runtime.InteropServices;

namespace ShowTrak
{
    public static class ApplicationWindows
    {
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsHungAppWindow(IntPtr window);

        public static int ForegroundProcessId()
        {
            IntPtr window = GetForegroundWindow();
            if (window == IntPtr.Zero) return 0;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            return (int)processId;
        }

        public static bool IsHung(IntPtr window)
        {
            return window != IntPtr.Zero && IsHungAppWindow(window);
        }
    }
}
`;

const WINDOW_SHIM_BASE64 = Buffer.from(WINDOWS_WINDOW_SHIM, 'utf8').toString('base64');

/**
 * The persistent host's query: every windowed process with its hung verdict, and
 * the owner of the focused window, as one JSON object.
 *
 *  - The shim is compiled at most ONCE per host, success or not: a session flag
 *    stops a failing Add-Type (blocked by policy, no compiler) being retried
 *    every three seconds at a second of CPU each time. Without it the query
 *    still answers, with `Shim` false, and the monitor reports both
 *    capabilities as unavailable rather than losing the application list.
 *  - Everything else runs inside `& { }`, so its variables die with the call
 *    instead of accumulating in the long-lived session.
 *  - The source rides as base64 so the statement stays on one line (the host
 *    evaluates one line per request) and no quoting rules apply to it.
 */
export const WINDOWS_HOST_QUERY = [
  'if (-not $global:ShowTrakWindowShimTried) {',
  '  $global:ShowTrakWindowShimTried = $true;',
  `  try { Add-Type -ErrorAction Stop -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${WINDOW_SHIM_BASE64}'))) } catch { }`,
  '};',
  '& {',
  "  $shim = [bool]('ShowTrak.ApplicationWindows' -as [type]);",
  '  $foreground = $null;',
  '  if ($shim) {',
  '    try {',
  '      $foregroundId = [ShowTrak.ApplicationWindows]::ForegroundProcessId();',
  '      if ($foregroundId -gt 0) { $foreground = (Get-Process -Id $foregroundId -ErrorAction Stop).ProcessName }',
  '    } catch { $foreground = $null }',
  '  };',
  '  $rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName } | ForEach-Object {',
  '    $responding = $null;',
  '    if ($shim) { try { $responding = -not [ShowTrak.ApplicationWindows]::IsHung($_.MainWindowHandle) } catch { $responding = $null } };',
  '    [pscustomobject]@{ Name = $_.ProcessName; Responding = $responding }',
  '  });',
  '  ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ Processes = $rows; Foreground = $foreground; Shim = $shim })',
  '}',
].join(' ');

/**
 * The rows of a list-valued property in PowerShell's JSON. Three shapes reach us:
 * an array; one bare object, where a single-element list was unrolled; and, from
 * Windows PowerShell 5.1, `{"value":[...],"Count":n}` when the array was wrapped
 * in a PSObject on its way into the property — a long-standing ConvertTo-Json
 * quirk that would otherwise read as one malformed row.
 */
function jsonRows(Value: unknown): unknown[] {
  if (Array.isArray(Value)) return Value;
  if (!Value || typeof Value !== 'object') return [];
  const Wrapped = (Value as { value?: unknown }).value;
  return Array.isArray(Wrapped) ? Wrapped : [Value];
}

/**
 * Parse the host query's JSON. Throws on anything that is not the expected
 * object, so a compile error or warning text is never read as "no applications".
 */
export function ParseWindowsApplications(Text: string): ApplicationSample {
  const Line = String(Text || '')
    .split(/\r?\n/)
    .map((Entry) => Entry.trim())
    .reverse()
    .find((Entry) => Entry.startsWith('{') && Entry.endsWith('}'));
  if (!Line) throw new Error('Application query returned no process list');
  const Parsed: unknown = JSON.parse(Line);
  if (!Parsed || typeof Parsed !== 'object' || Array.isArray(Parsed)) {
    throw new Error('Application query returned no process list');
  }
  const Root = Parsed as Record<string, unknown>;
  const Shim = Root.Shim === true;
  const RawRows = jsonRows(Root.Processes);
  const Processes: ApplicationProcess[] = [];
  for (const Raw of RawRows as unknown[]) {
    if (!Raw || typeof Raw !== 'object') continue;
    const Row = Raw as Record<string, unknown>;
    const Name = typeof Row.Name === 'string' ? Row.Name.trim() : '';
    if (!Name) continue;
    if (!Shim) {
      Processes.push({ Name });
      continue;
    }
    Processes.push({
      Name,
      Responding: typeof Row.Responding === 'boolean' ? Row.Responding : null,
    });
  }
  if (!Shim) return { Processes, Capabilities: { ...NO_CAPABILITIES } };
  const Foreground =
    typeof Root.Foreground === 'string' && Root.Foreground.trim() ? Root.Foreground.trim() : null;
  return { Processes, Foreground, Capabilities: { Responding: true, Foreground: true } };
}

export async function collectWindowsApplications(): Promise<Result<ApplicationSample>> {
  const [hostError, stdout] = await PowerShellHost.Run(
    WINDOWS_HOST_QUERY,
    hostWarm ? HOST_TIMEOUT_MS : COLD_HOST_TIMEOUT_MS
  );
  if (!hostError && stdout !== null) {
    try {
      const sample = ParseWindowsApplications(stdout);
      hostWarm = true;
      return [null, sample];
    } catch (error) {
      Logger.debug('PowerShell host returned an unreadable sample', error);
    }
  }
  // Whatever went wrong, the next host call may land in a fresh session that
  // has to compile the shim again.
  hostWarm = false;

  // The host is unavailable or wedged. Fall back to the pre-existing one-shot
  // spawn so a broken host costs latency rather than the whole signal. The
  // fallback lists names only: compiling the window shim into a cold
  // powershell.exe every three seconds would cost more than the host it is
  // standing in for, so hung and foreground detection report themselves
  // unavailable until the host recovers.
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
  return [
    null,
    { Processes: namesOnly(splitLines(oneShot)), Capabilities: { ...NO_CAPABILITIES } },
  ];
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

// `lsappinfo front` answers "ASN:0x0-0x491c918:" — the ASN of the frontmost
// application, in the same form visibleProcessList uses.
const FRONT_ASN_PATTERN = /(ASN:0x[0-9a-f]+-0x[0-9a-f]+)/i;

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
 * sample, so the steady-state cost of a poll is two ~4ms calls: the listing and
 * `lsappinfo front`, run side by side. The frontmost application is named
 * through the same cache, so it always matches its entry in the list.
 *
 * macOS has no public "application not responding" API (Activity Monitor and
 * the Force Quit window use private ones), so hung detection is reported as
 * unavailable here rather than guessed.
 */
export async function collectMacApplications(): Promise<Result<ApplicationSample>> {
  const [[error, stdout], [frontError, frontStdout]] = await Promise.all([
    execFileAsync('lsappinfo', ['visibleProcessList']),
    execFileAsync('lsappinfo', ['front']),
  ]);
  const frontMatch = frontError ? null : FRONT_ASN_PATTERN.exec(String(frontStdout));
  const frontAsn = frontMatch && frontMatch[1] ? frontMatch[1] : null;
  const capabilities: RunningApplicationsCapabilities = {
    Responding: false,
    // A failing `lsappinfo front` means this session cannot say, which is not
    // the same as "nothing is focused".
    Foreground: !frontError,
  };

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
      const foreground = await resolveForeground(frontAsn, capabilities);
      // The frontmost application is nearly always in the visible list already;
      // when it is not, keep its name too, so the next sample does not look it
      // up again.
      if (frontAsn) seen.add(frontAsn);
      // Drop names for applications that have since quit, so the cache tracks
      // what is running rather than everything ever seen this session.
      for (const asn of displayNameCache.keys()) {
        if (!seen.has(asn)) displayNameCache.delete(asn);
      }
      return [null, withForeground(namesOnly(names), foreground, capabilities)];
    }
  }

  // Either lsappinfo is missing/failed, or it reported nothing at all. A live
  // desktop always has at least Finder, so an empty list means we are not seeing
  // the GUI session properly — in both cases fall back to the System Events
  // query, which is slow but authoritative (and reports its own permission
  // errors, which the caller classifies).
  Logger.debug('lsappinfo gave no usable result; falling back to System Events');
  const [fallbackError, names] = await collectMacApplicationsViaSystemEvents();
  if (fallbackError || !names) return [fallbackError, null];
  const foreground = await resolveForeground(frontAsn, capabilities);
  return [null, withForeground(namesOnly(names), foreground, capabilities)];
}

async function resolveForeground(
  frontAsn: string | null,
  capabilities: RunningApplicationsCapabilities
): Promise<string | null | undefined> {
  if (!capabilities.Foreground) return undefined;
  if (!frontAsn) return null;
  const name = (await resolveDisplayName(frontAsn, '')).trim();
  return name || null;
}

function withForeground(
  Processes: ApplicationProcess[],
  Foreground: string | null | undefined,
  Capabilities: RunningApplicationsCapabilities
): ApplicationSample {
  if (!Capabilities.Foreground || Foreground === undefined) {
    return { Processes, Capabilities: { ...Capabilities, Foreground: false } };
  }
  return { Processes, Foreground, Capabilities };
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

/**
 * Whether the focused window can be asked about at all, and with what. Decided
 * once per process: whether xdotool is installed and whether this is an X11
 * session do not change under a running client.
 *
 * Wayland deliberately has no "which window is focused" API for ordinary
 * clients, and xdotool under XWayland sees only X11 windows — it would report
 * nothing focused whenever a native Wayland window has focus, which reads as an
 * answer when it is not one. So a Wayland session reports the capability as
 * unavailable rather than half-working.
 */
let xdotoolPath: string | null | undefined;

function linuxForegroundTool(env: NodeJS.ProcessEnv = process.env): string | null {
  if (xdotoolPath !== undefined) return xdotoolPath;
  const wayland =
    !!env.WAYLAND_DISPLAY || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
  xdotoolPath = !env.DISPLAY || wayland ? null : FindOnPath('xdotool', env, 'linux');
  return xdotoolPath;
}

/**
 * The focused window's process name, read as `comm` — exactly what `ps -o comm=`
 * lists, so it matches the application's entry. Undefined when the session
 * cannot say at all; null when it can but nothing (readable) has focus.
 */
async function collectLinuxForeground(): Promise<string | null | undefined> {
  const tool = linuxForegroundTool();
  if (!tool) return undefined;
  const [error, stdout] = await execFileAsync(tool, ['getactivewindow', 'getwindowpid']);
  if (error) {
    // "Can't open display" means the X server is unreachable from here (the
    // client started outside the desktop session): that is "cannot tell", and
    // it will not get better, so stop asking.
    if (/open display/i.test(String((error as Error).message || ''))) {
      xdotoolPath = null;
      return undefined;
    }
    // Otherwise the usual cause is a focused window with no _NET_WM_PID (the
    // desktop itself, some override-redirect popups): nothing nameable.
    return null;
  }
  const pid = parseInt(String(stdout).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    return comm || null;
  } catch (_error) {
    return null;
  }
}

export async function collectLinuxApplications(): Promise<Result<ApplicationSample>> {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch (_error) {
    // Fall back to process listing without user filtering.
  }
  const args = username ? ['-u', username, '-o', 'comm='] : ['-e', '-o', 'comm='];
  const [[error, stdout], foreground] = await Promise.all([
    execFileAsync('ps', args),
    collectLinuxForeground(),
  ]);
  if (error) return [error, null];
  const processes = namesOnly(splitLines(stdout));
  if (foreground === undefined) {
    return [null, { Processes: processes, Capabilities: { ...NO_CAPABILITIES } }];
  }
  return [
    null,
    {
      Processes: processes,
      Foreground: foreground,
      Capabilities: { Responding: false, Foreground: true },
    },
  ];
}

// ---------------------------------------------------------------------------

export async function collectRunningApplications(): Promise<Result<ApplicationSample>> {
  if (process.platform === 'win32') return collectWindowsApplications();
  if (process.platform === 'darwin') return collectMacApplications();
  return collectLinuxApplications();
}

/** Release any resident sampler state. Called when the monitor stops. */
export function disposeSamplers(): void {
  PowerShellHost.Dispose();
  // A disposed host comes back as a fresh session that must compile the shim.
  hostWarm = false;
  displayNameCache.clear();
}

export const _internal = {
  displayNameCache,
  /** Test seam: forget the cached xdotool lookup. */
  resetLinuxForeground(): void {
    xdotoolPath = undefined;
  },
  linuxForegroundTool,
};
