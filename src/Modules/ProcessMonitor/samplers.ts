import { execFile } from 'child_process';
import { LowerChildPriority } from '../Utils/process-priority';
import { readFile } from 'fs/promises';
import os from 'os';

import type { RunningApplicationsCapabilities } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import { FindOnPath } from '../Utils';
import { Hosts, JsonRows, RunOneShot, type PowerShellPrelude } from '../PowerShell';

const Logger = CreateLogger('ProcessMonitor');

const COMMAND_TIMEOUT_MS = 8000;
// The host answers in single-digit milliseconds once warm. A fresh host's first
// request gets a startup allowance on top (see PowerShell/host.ts), and the one
// that carries the window shim's compile gets SHIM_COMPILE_ALLOWANCE_MS more:
// holding that call to the warm deadline would time it out, kill the host, and
// recompile in the next one — forever.
const HOST_TIMEOUT_MS = 5000;
const SHIM_COMPILE_ALLOWANCE_MS = 15000;

export function execFileAsync(command: string, args: string[]): Promise<[unknown, string]> {
  return new Promise((resolve) => {
    const Child = execFile(
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
    LowerChildPriority(Child);
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
 * The running-application query, in C#: one EnumWindows pass and one process
 * snapshot, with the JSON built in the shim.
 *
 * It replaced `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }`, whose
 * cost grows with processes x windows — .NET finds each process's main window
 * with its own full EnumWindows pass — and then ConvertTo-Json on top: tens to
 * hundreds of milliseconds of CPU every three seconds. This walks the windows
 * once and indexes them by process.
 *
 * Which processes are reported is unchanged. A process counts when it owns a
 * main window as .NET's Process.MainWindowHandle defines one: the FIRST visible,
 * unowned top-level window found for it in EnumWindows order. Names come from
 * Process.ProcessName, rows are ordered as Get-Process orders them (name, case
 * insensitively, then id), and nameless processes are skipped, as before.
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
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ShowTrak
{
    public static class ApplicationWindows
    {
        delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr window, uint command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsHungAppWindow(IntPtr window);

        const uint GW_OWNER = 4;

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

        // Process id -> its main window, as Process.MainWindowHandle picks it: the
        // first visible, unowned top-level window in EnumWindows order.
        public static Dictionary<int, IntPtr> MainWindows()
        {
            Dictionary<int, IntPtr> found = new Dictionary<int, IntPtr>();
            EnumWindowsProc callback = delegate (IntPtr window, IntPtr parameter)
            {
                if (GetWindow(window, GW_OWNER) != IntPtr.Zero) return true;
                if (!IsWindowVisible(window)) return true;
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (processId != 0 && !found.ContainsKey((int)processId)) found[(int)processId] = window;
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }

        static string Name(Process process)
        {
            try { return process.ProcessName; } catch { return null; }
        }

        static int CompareProcesses(Process left, Process right)
        {
            int byName = String.Compare(Name(left), Name(right), StringComparison.OrdinalIgnoreCase);
            if (byName != 0) return byName;
            return left.Id.CompareTo(right.Id);
        }

        static string Json(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder("\\"");
            foreach (char c in value)
            {
                if (c == '\\\\') sb.Append("\\\\\\\\");
                else if (c == '"') sb.Append("\\\\\\"");
                else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // {"Processes":[{"Name":..,"Responding":..}],"Foreground":..,"Shim":true}
        public static string Query()
        {
            Dictionary<int, IntPtr> windows = MainWindows();
            int foregroundId = ForegroundProcessId();
            string foreground = null;
            Process[] processes = Process.GetProcesses();
            Array.Sort(processes, CompareProcesses);
            StringBuilder rows = new StringBuilder();
            foreach (Process process in processes)
            {
                try
                {
                    int id = process.Id;
                    string name = Name(process);
                    if (id == foregroundId && foregroundId > 0) foreground = name;
                    IntPtr window;
                    if (!windows.TryGetValue(id, out window)) continue;
                    if (String.IsNullOrEmpty(name)) continue;
                    string responding;
                    try { responding = IsHungAppWindow(window) ? "false" : "true"; }
                    catch { responding = "null"; }
                    if (rows.Length > 0) rows.Append(',');
                    rows.Append("{\\"Name\\":").Append(Json(name))
                        .Append(",\\"Responding\\":").Append(responding).Append('}');
                }
                catch { }
                finally { process.Dispose(); }
            }
            if (foreground == null && foregroundId > 0)
            {
                // Started between the window walk and the snapshot.
                try { using (Process owner = Process.GetProcessById(foregroundId)) { foreground = owner.ProcessName; } }
                catch { foreground = null; }
            }
            if (foreground != null && foreground.Length == 0) foreground = null;
            return "{\\"Processes\\":[" + rows.ToString() + "],\\"Foreground\\":" + Json(foreground) + ",\\"Shim\\":true}";
        }
    }
}
`;

const WINDOW_SHIM_BASE64 = Buffer.from(WINDOWS_WINDOW_SHIM, 'utf8').toString('base64');

/**
 * Compiles the shim into the Desktop host's session, once per powershell.exe. A
 * failing Add-Type (blocked by policy, no compiler) is not retried: the query
 * below answers without it, with `Shim` false, and the monitor reports both
 * capabilities as unavailable rather than losing the application list. The
 * source rides as base64 so the statement stays on one line (the host evaluates
 * one line per request) and no quoting rules apply to it.
 */
export const WINDOWS_WINDOW_PRELUDE: PowerShellPrelude = {
  Key: 'ShowTrak.ApplicationWindows',
  Script:
    "if (-not ('ShowTrak.ApplicationWindows' -as [type])) { " +
    `Add-Type -ErrorAction Stop -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${WINDOW_SHIM_BASE64}'))) }`,
  ExtraTimeoutMs: SHIM_COMPILE_ALLOWANCE_MS,
};

/**
 * The persistent host's query: the shim's one-pass answer, or — when the shim
 * could not be compiled — the old Get-Process pipeline, names only, with `Shim`
 * false. Everything runs inside `& { }`, so its variables die with the call
 * instead of accumulating in the long-lived session.
 */
export const WINDOWS_HOST_QUERY = [
  '& {',
  "  if ('ShowTrak.ApplicationWindows' -as [type]) { [ShowTrak.ApplicationWindows]::Query() }",
  '  else {',
  '    $rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName } | ForEach-Object {',
  '      [pscustomobject]@{ Name = $_.ProcessName; Responding = $null }',
  '    });',
  '    ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ Processes = $rows; Foreground = $null; Shim = $false })',
  '  }',
  '}',
].join(' ');

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
  const RawRows = JsonRows(Root.Processes);
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
  const [hostError, stdout] = await Hosts.Desktop.Run(WINDOWS_HOST_QUERY, {
    TimeoutMs: HOST_TIMEOUT_MS,
    Prelude: WINDOWS_WINDOW_PRELUDE,
  });
  if (!hostError && stdout !== null) {
    try {
      return [null, ParseWindowsApplications(stdout)];
    } catch (error) {
      Logger.debug('PowerShell host returned an unreadable sample', error);
    }
  }

  // The host is unavailable, wedged or answered nonsense. Unlike the other
  // samplers this one falls back even after a timeout: a failed sample is
  // reported as an empty application list, which would read as every critical
  // application having quit. The fallback lists names only — compiling the
  // window shim into a cold powershell.exe every three seconds would cost more
  // than the host it is standing in for — so hung and foreground detection
  // report themselves unavailable until the host recovers.
  Logger.debug('PowerShell host sample failed; falling back to a one-shot spawn');
  const [error, oneShot] = await RunOneShot(WINDOWS_QUERY, COMMAND_TIMEOUT_MS);
  if (error || oneShot === null) return [error || new Error('No output'), null];
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

/**
 * Release resident sampler state. Called when the monitor stops. The shared
 * Desktop PowerShell host is left to its idle shutdown, so a reconnect within a
 * few minutes keeps its compiled shim.
 */
export function disposeSamplers(): void {
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
