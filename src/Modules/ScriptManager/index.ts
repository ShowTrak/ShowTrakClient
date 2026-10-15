import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { VariableEnvironment } from '@showtrak/protocol';
import type {
  ClientScript,
  ScriptConsoleFilter,
  ScriptFile,
  ScriptLaunchState,
  TrayScriptEntry,
} from '../../types/client';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDataManager } from '../AppData';
import { Manager as VariableStore } from '../Variables';
import { ErrorMessage } from '../Utils';
import { ChecksumBuffer, ChecksumFile } from '@showtrak/protocol/runtime';

const Logger = CreateLogger('ScriptManager');

/** Progress reporter passed through to the server's execution modal. */
export type ProgressReporter = (progress: number, statusText: string) => void;

let ScriptCache: ClientScript[] = [];
let LastAppliedDeploymentFingerprint: string | null = null;
let DeploymentStateLoaded = false;

/** Applied when a script carries no usable Timeout; matches the Server's default. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 15000;
/** How long a timed-out script gets to exit on SIGTERM before it is SIGKILLed. */
const SCRIPT_KILL_GRACE_MS = 3000;
/** How much of a failing script's stderr is surfaced as its error. */
const SCRIPT_ERROR_TAIL_LENGTH = 500;

/**
 * A script process that is still running, and how to stop it.
 *
 * Tracked so the app can stop its own scripts on quit rather than leaving them
 * orphaned. `Abort` kills the DIRECT child only and fails the run with the
 * given message — see KillDirectChild for why it never kills the tree.
 */
interface RunningScript {
  Child: import('child_process').ChildProcess;
  Abort: (Message: string) => void;
}
const RunningScripts = new Set<RunningScript>();

interface NormalizedFileEntry {
  Path: string;
  Type: string;
  Checksum: string | null;
}

const Internal = {
  GetDeploymentStatePath(): string {
    return path.join(AppDataManager.GetProfileDirectory(), 'ScriptDeploymentState.json');
  },

  NormalizeFileEntryForFingerprint(
    File: ScriptFile | null | undefined
  ): NormalizedFileEntry | null {
    if (!File || typeof File !== 'object') return null;
    return {
      Path: String(File.Path || ''),
      Type: String(File.Type || ''),
      Checksum: File.Checksum ? String(File.Checksum) : null,
    };
  },

  BuildDeploymentFingerprint(Scripts: ClientScript[] | null | undefined): string {
    const Normalized = (Array.isArray(Scripts) ? Scripts : [])
      .map((Script) => {
        if (!Script || typeof Script !== 'object') return null;
        const Files = (Array.isArray(Script.Files) ? Script.Files : [])
          .map((File) => Internal.NormalizeFileEntryForFingerprint(File))
          .filter((File): File is NormalizedFileEntry => File !== null)
          .sort((A, B) => {
            if (A.Path === B.Path) return A.Type.localeCompare(B.Type);
            return A.Path.localeCompare(B.Path);
          });

        return {
          ID: String(Script.ID || ''),
          Name: String(Script.Name || ''),
          Description: String(Script.Description || ''),
          Colour: typeof Script.Colour === 'number' ? Script.Colour : 6,
          Weight: typeof Script.Weight === 'number' ? Script.Weight : 0,
          Confirmation: !!Script.Confirmation,
          Timeout: typeof Script.Timeout === 'number' ? Script.Timeout : 15000,
          Enabled: !!(Script.isEnabled || Script.Enabled),
          Platforms: Script.Platforms || {},
          Arguments: Script.Arguments || {},
          ConsoleFilter:
            Script.ConsoleFilter && typeof Script.ConsoleFilter === 'object'
              ? {
                  Mode: String(Script.ConsoleFilter.Mode || 'none'),
                  Pattern: String(Script.ConsoleFilter.Pattern || ''),
                  Strip: Script.ConsoleFilter.Strip === true,
                }
              : { Mode: 'none', Pattern: '', Strip: false },
          isValid: Script.isValid !== false,
          ParseError: Script.ParseError ? String(Script.ParseError) : '',
          Files,
        };
      })
      .filter((Script): Script is NonNullable<typeof Script> => Script !== null)
      .sort((A, B) => A.ID.localeCompare(B.ID));

    return crypto.createHash('sha256').update(JSON.stringify(Normalized)).digest('hex');
  },

  LoadDeploymentState(): void {
    if (DeploymentStateLoaded) return;
    DeploymentStateLoaded = true;
    const StatePath = Internal.GetDeploymentStatePath();
    try {
      if (!fs.existsSync(StatePath)) {
        LastAppliedDeploymentFingerprint = null;
        return;
      }
      const Raw = fs.readFileSync(StatePath, 'utf-8');
      const Parsed = JSON.parse(Raw || '{}');
      LastAppliedDeploymentFingerprint =
        Parsed && typeof Parsed.LastAppliedDeploymentFingerprint === 'string'
          ? Parsed.LastAppliedDeploymentFingerprint
          : null;
    } catch (Err) {
      Logger.warn(`Failed to load script deployment state: ${(Err as Error).message}`);
      LastAppliedDeploymentFingerprint = null;
    }
  },

  PersistDeploymentState(): void {
    const StatePath = Internal.GetDeploymentStatePath();
    try {
      fs.writeFileSync(
        StatePath,
        JSON.stringify(
          {
            LastAppliedDeploymentFingerprint,
            UpdatedAt: Date.now(),
          },
          null,
          2
        )
      );
    } catch (Err) {
      Logger.warn(`Failed to persist script deployment state: ${(Err as Error).message}`);
    }
  },

  // Ordered list of platform keys to try for the current OS, most specific first.
  GetPlatformPreference(): string[] {
    if (process.platform === 'win32') return ['Windows'];
    if (process.platform === 'darwin') return ['macOS'];
    // Linux and Raspberry Pi use the same platform key.
    return ['Linux'];
  },

  // Normalize a relative script path so it resolves correctly on this OS,
  // regardless of how it was authored: convert backslashes to forward slashes
  // (path.join handles these on every platform) and strip leading "./" segments.
  NormalizeRelativePath(value: unknown): string {
    if (typeof value !== 'string') return '';
    let p = value.trim().replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.slice(2);
    return p.trim();
  },

  // True when a server-supplied relative segment is safe to join onto a
  // directory we own.
  //
  // Rejected: absolute paths, UNC paths, drive letters, NUL bytes, and any `..`
  // component under EITHER separator. Both spellings matter: a Windows-style
  // `..\evil` is an ordinary filename to POSIX `path.resolve`, but
  // NormalizeRelativePath rewrites backslashes to forward slashes, which turns
  // it into a real traversal on every platform.
  IsSafeRelativeSegment(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const Raw = value.trim();
    if (!Raw || Raw.includes('\0')) return false;
    const Unified = Raw.replace(/\\/g, '/');
    // Leading '/' covers both POSIX absolute paths and UNC ('\\host\share').
    if (Unified.startsWith('/')) return false;
    if (/^[a-zA-Z]:/.test(Unified)) return false;
    return !Unified.split('/').includes('..');
  },

  // Contain a server-supplied path segment inside a directory we own.
  //
  // Both `Script.ID` and `ScriptFile.Path` arrive from the server over the wire
  // and are joined onto the scripts directory. Unchecked, a segment containing
  // `..` — or an absolute path, which `path.join`/`path.resolve` let win
  // outright — escapes the sandbox, and DownloadScripts will then write to it,
  // chmod 0755 it and ultimately execute it. Adoption pins ServerIdentity, so
  // this is not reachable by an unauthenticated peer, but the blast radius of a
  // spoofed or compromised server should stop at the scripts directory.
  //
  // Returns the resolved absolute path, or null when the segment would escape.
  ResolveContained(Base: string, ...Segments: string[]): string | null {
    if (typeof Base !== 'string' || !Base) return null;
    for (const Segment of Segments) {
      if (!Internal.IsSafeRelativeSegment(Segment)) return null;
    }
    let Resolved: string;
    let Root: string;
    try {
      Root = path.resolve(Base);
      Resolved = path.resolve(Root, ...Segments.map((Segment) => Segment.trim()));
    } catch {
      return null;
    }
    // Defence in depth: the segment checks above should already have caught
    // anything that escapes, so this prefix test is a second, independent gate.
    // Equality is a rejection too — a target must be strictly inside the base.
    if (Resolved === Root) return null;
    return Resolved.startsWith(Root + path.sep) ? Resolved : null;
  },

  // Resolve the relative script file to run for the current platform. Falls back
  // to a legacy top-level "Path" for scripts authored before the cross-platform
  // schema. Returns the relative path string, or null if nothing is defined.
  ResolvePlatformScript(Script: ClientScript | null | undefined): string | null {
    const Platforms = Script && Script.Platforms ? Script.Platforms : {};
    for (const key of Internal.GetPlatformPreference()) {
      const value = Internal.NormalizeRelativePath(Platforms[key]);
      if (value) return value;
    }
    // Legacy single-path scripts.
    const legacy = Internal.NormalizeRelativePath(Script && Script.Path);
    if (legacy) return legacy;
    return null;
  },

  ResolvePlatformArguments(Script: ClientScript | null | undefined): string {
    const ArgumentMap = Script && Script.Arguments ? Script.Arguments : {};
    for (const key of Internal.GetPlatformPreference()) {
      const raw = ArgumentMap[key];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value) return value;
    }
    return '';
  },

  GetScriptLaunchState(Script: ClientScript | null | undefined): ScriptLaunchState {
    const ScriptID = Script && Script.ID ? String(Script.ID) : '';
    if (!Script || typeof Script !== 'object') {
      return { Enabled: false, DisabledReason: 'Invalid script configuration.' };
    }
    if (!ScriptID) {
      return { Enabled: false, DisabledReason: 'Script is missing an ID.' };
    }
    if (Script.isValid === false) {
      return {
        Enabled: false,
        DisabledReason: Script.ParseError
          ? String(Script.ParseError)
          : 'Invalid script configuration.',
      };
    }
    if (Script.Enabled === false || Script.isEnabled === false) {
      return { Enabled: false, DisabledReason: 'Script is disabled.' };
    }

    const RelativePath = Internal.ResolvePlatformScript(Script);
    if (!RelativePath) {
      return {
        Enabled: false,
        DisabledReason: 'No script is configured for this operating system.',
      };
    }

    const ScriptPath = Internal.ResolveContained(AppDataManager.GetScriptsDirectory(), ScriptID);
    if (!ScriptPath) {
      return { Enabled: false, DisabledReason: 'Script ID is not a valid directory name.' };
    }
    if (!fs.existsSync(ScriptPath)) {
      return { Enabled: false, DisabledReason: 'Script path does not exist.' };
    }

    const TargetFile = Internal.ResolveContained(ScriptPath, RelativePath);
    if (!TargetFile) {
      return {
        Enabled: false,
        DisabledReason: 'Script path for this operating system escapes the scripts directory.',
      };
    }
    if (!fs.existsSync(TargetFile)) {
      return {
        Enabled: false,
        DisabledReason: 'Script file for this operating system was not found.',
      };
    }

    return {
      Enabled: true,
      DisabledReason: '',
      RelativePath,
      ScriptPath: TargetFile,
    };
  },

  // Parse a shell-like argument string into argv tokens.
  // Supports spaces, single/double quotes, and backslash escaping.
  ParseArgumentString(value: unknown): string[] {
    const input = String(value || '').trim();
    if (!input) return [];

    const args: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaping = false;

    const pushCurrent = () => {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    };

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i] as string;

      if (escaping) {
        current += ch;
        escaping = false;
        continue;
      }

      if (ch === '\\') {
        escaping = true;
        continue;
      }

      if (inSingle) {
        if (ch === "'") inSingle = false;
        else current += ch;
        continue;
      }

      if (inDouble) {
        if (ch === '"') inDouble = false;
        else current += ch;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }

      if (/\s/.test(ch)) {
        pushCurrent();
        continue;
      }

      current += ch;
    }

    if (escaping) current += '\\';
    pushCurrent();
    return args;
  },

  // Resolve how to launch a script based on its file extension and the current
  // platform. Returns { command, args } suitable for child_process.spawn, or null
  // when the script type is not runnable on this platform.
  ResolveLauncher(ScriptPath: string): { command: string; args: string[] } | null {
    const Extension = path.extname(ScriptPath).toLowerCase();

    if (process.platform === 'win32') {
      switch (Extension) {
        case '.bat':
        case '.cmd':
          return { command: 'cmd.exe', args: ['/c', ScriptPath] };
        case '.ps1':
          return {
            command: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ScriptPath],
          };
        case '.exe':
          return { command: ScriptPath, args: [] };
        default:
          // Fall back to the shell so the OS file associations are honored.
          return { command: 'cmd.exe', args: ['/c', ScriptPath] };
      }
    }

    // macOS and Linux.
    switch (Extension) {
      case '.sh':
      case '.command':
      case '':
        return { command: '/bin/sh', args: [ScriptPath] };
      case '.bash':
        return { command: '/bin/bash', args: [ScriptPath] };
      case '.py':
        return { command: 'python3', args: [ScriptPath] };
      case '.js':
        return { command: 'node', args: [ScriptPath] };
      default:
        // Assume the file is directly executable (e.g. a binary or a script with
        // a shebang). It will be marked executable before launch.
        return { command: ScriptPath, args: [] };
    }
  },

  // Compile a script's optional ConsoleFilter ({ Mode, Pattern }) into a line
  // predicate, or return null when no filtering should be applied. Filtering is
  // intentionally done on the CLIENT so scripts control what console output the
  // server ever sees. Mode "none" (or an empty pattern) disables the filter; an
  // uncompilable regex is treated as "no filter" so a bad pattern never silences
  // all output.
  CompileConsoleFilter(
    ConsoleFilter: ScriptConsoleFilter | null | undefined
  ): ((line: string) => boolean) | null {
    if (!ConsoleFilter || typeof ConsoleFilter !== 'object') return null;
    const Mode = String(ConsoleFilter.Mode || 'none');
    const Pattern = typeof ConsoleFilter.Pattern === 'string' ? ConsoleFilter.Pattern.trim() : '';
    if (Mode === 'none' || !Pattern) return null;

    if (Mode === 'startsWith') return (line: string) => line.startsWith(Pattern);
    if (Mode === 'regex') {
      let Regex: RegExp;
      try {
        Regex = new RegExp(Pattern);
      } catch (Err) {
        Logger.warn(
          `Invalid console filter regex "${Pattern}" (${(Err as Error).message}); filter disabled`
        );
        return null;
      }
      return (line: string) => Regex.test(line);
    }
    // Default / "includes".
    return (line: string) => line.includes(Pattern);
  },

  // Compile a script's optional ConsoleFilter into a strip transform, or return
  // null when nothing should be stripped. When ConsoleFilter.Strip is true the
  // matched text is removed from a surfaced line, leaving only the remainder
  // (trimmed). Only applied to lines that already passed CompileConsoleFilter.
  // An uncompilable regex disables stripping (the whole line is surfaced as-is).
  CompileConsoleStrip(
    ConsoleFilter: ScriptConsoleFilter | null | undefined
  ): ((line: string) => string) | null {
    if (!ConsoleFilter || typeof ConsoleFilter !== 'object') return null;
    if (ConsoleFilter.Strip !== true) return null;
    const Mode = String(ConsoleFilter.Mode || 'none');
    const Pattern = typeof ConsoleFilter.Pattern === 'string' ? ConsoleFilter.Pattern.trim() : '';
    if (Mode === 'none' || !Pattern) return null;

    if (Mode === 'startsWith') {
      return (line: string) =>
        line.startsWith(Pattern) ? line.slice(Pattern.length).trim() : line;
    }
    if (Mode === 'regex') {
      let Regex: RegExp;
      try {
        Regex = new RegExp(Pattern, 'g');
      } catch (Err) {
        Logger.warn(
          `Invalid console filter regex "${Pattern}" (${(Err as Error).message}); strip disabled`
        );
        return null;
      }
      return (line: string) => line.replace(Regex, '').trim();
    }
    // Default / "includes": remove every occurrence of the pattern.
    return (line: string) => line.split(Pattern).join('').trim();
  },

  // The timeout a script runs under: its own Timeout when that is a positive
  // number (the same rule the Server applies when it arms its watchdog),
  // otherwise the default.
  ResolveTimeoutMs(Script: ClientScript | null | undefined): number {
    const Timeout = Script ? Script.Timeout : undefined;
    return typeof Timeout === 'number' && Number.isFinite(Timeout) && Timeout > 0
      ? Timeout
      : DEFAULT_SCRIPT_TIMEOUT_MS;
  },

  // "15s", "1.5s" — the timeout as an operator would write it.
  FormatTimeout(TimeoutMs: number): string {
    return `${Number((TimeoutMs / 1000).toFixed(1))}s`;
  },

  // The end of a script's stderr, which is where the reason it failed almost
  // always is. Capped so a chatty script cannot flood the execution panel (the
  // Server also truncates errors, at 2048 characters).
  TailText(Text: string, MaxLength = SCRIPT_ERROR_TAIL_LENGTH): string {
    const Trimmed = String(Text || '').trim();
    if (Trimmed.length <= MaxLength) return Trimmed;
    return `…${Trimmed.slice(-MaxLength).trimStart()}`;
  },

  // Stop a script process — the DIRECT child only, never its process tree.
  //
  // This is deliberate. Show scripts routinely exist to launch the show itself
  // (QLab, a media server, a kiosk browser), and those applications are
  // descendants of the script process. A tree kill on timeout or on quit would
  // take the show down with the script, which is far worse than a script that
  // overstayed its timeout. So only the launcher process we spawned is
  // signalled; anything it started is left running.
  //
  // POSIX gets SIGTERM first so a script can clean up, then SIGKILL if it is
  // still alive after a short grace. On Windows, kill() is already a hard
  // TerminateProcess of that one process.
  KillDirectChild(Child: import('child_process').ChildProcess): void {
    try {
      Child.kill();
    } catch (Err) {
      Logger.warn(`Failed to stop script process: ${(Err as Error).message}`);
    }
    if (process.platform === 'win32') return;
    const Escalation = setTimeout(() => {
      if (Child.exitCode !== null || Child.signalCode !== null) return;
      try {
        Child.kill('SIGKILL');
      } catch (Err) {
        Logger.warn(`Failed to force-stop script process: ${(Err as Error).message}`);
      }
    }, SCRIPT_KILL_GRACE_MS);
    if (typeof Escalation.unref === 'function') Escalation.unref();
  },

  async RunScriptFile(
    ScriptPath: string,
    ExtraArgs: string[] = [],
    OnProgress?: ProgressReporter,
    ConsoleFilter: ScriptConsoleFilter | null = null,
    Variables: VariableEnvironment | null = null,
    TimeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS
  ): Promise<string> {
    const Report: ProgressReporter = typeof OnProgress === 'function' ? OnProgress : () => {};
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process') as typeof import('child_process');

      const Launcher = Internal.ResolveLauncher(ScriptPath);
      if (!Launcher) {
        return reject(new Error(`No launcher is available for script: ${ScriptPath}.`));
      }

      // Ensure the script is executable on POSIX platforms before launching it.
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(ScriptPath, 0o755);
        } catch (chmodError) {
          Logger.warn(
            `Unable to set executable bit on ${ScriptPath}: ${(chmodError as Error).message}`
          );
        }
      }

      // Show variables are injected here and ONLY here, which is what makes them
      // reach every execution path — server dispatch, the tray menu and the
      // run-on-launch action all arrive at this one spawn.
      //
      // process.env must be spread in: passing `env` at all means we own the
      // whole block, and a script that lost PATH would fail in a way that looks
      // nothing like a variable problem. Show variables go last so they win, but
      // every name is prefixed SHOWTRAK_VAR_ (enforced in Modules/Variables), so
      // in practice they cannot collide with anything the OS provides.
      const ScriptEnvironment = { ...process.env, ...(Variables || {}) };

      const Child = spawn(Launcher.command, Launcher.args.concat(ExtraArgs), {
        cwd: path.dirname(ScriptPath),
        windowsHide: true,
        env: ScriptEnvironment,
      });

      // Exactly one outcome per run, whichever of close / error / timeout / quit
      // gets there first.
      let Settled = false;
      let TimeoutTimer: NodeJS.Timeout | null = null;
      const Tracked: RunningScript = {
        Child,
        Abort: (Message: string) => {
          if (Settled) return;
          Internal.KillDirectChild(Child);
          Fail(new Error(Message));
        },
      };
      const Finish = () => {
        Settled = true;
        if (TimeoutTimer) clearTimeout(TimeoutTimer);
        if (FlushTimer) clearTimeout(FlushTimer);
        RunningScripts.delete(Tracked);
      };
      const Fail = (Err: Error) => {
        if (Settled) return;
        Finish();
        reject(Err);
      };
      const Succeed = (Output: string) => {
        if (Settled) return;
        Finish();
        resolve(Output);
      };
      RunningScripts.add(Tracked);

      // The process is now live — the server treats the Running stage (progress
      // >= 50) as the spinner state; StatusText from here on is live console tail.
      Child.on('spawn', () => Report(65, 'Running'));

      let StdOut = '';
      let StdErr = '';

      // Tail the console: surface the most recent non-empty output line as the
      // running StatusText so it shows inline in the server's execution modal.
      // Emits are throttled (trailing edge) so chatty scripts don't flood the
      // socket, and capped in length (the server also enforces a 512-char limit).
      // When the script defines a ConsoleFilter, only lines matching it are
      // surfaced (see CompileConsoleFilter); non-matching output is still captured
      // in StdOut/StdErr but never becomes the live status tail.
      const MatchesConsoleFilter = Internal.CompileConsoleFilter(ConsoleFilter);
      const StripConsoleFilter = Internal.CompileConsoleStrip(ConsoleFilter);
      let LatestLine = '';
      let LastSentLine = '';
      let FlushTimer: NodeJS.Timeout | null = null;
      const ExtractLastLine = (text: string): string => {
        const lines = String(text).split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const trimmed = (lines[i] ?? '').trim();
          if (!trimmed) continue;
          if (MatchesConsoleFilter && !MatchesConsoleFilter(trimmed)) continue;
          if (StripConsoleFilter) {
            // Surface only the remainder after removing the matched text; an
            // empty remainder means nothing useful to show, so keep scanning
            // earlier lines for the most recent meaningful tail.
            const stripped = StripConsoleFilter(trimmed);
            if (!stripped) continue;
            return stripped;
          }
          return trimmed;
        }
        return '';
      };
      const FlushLine = () => {
        FlushTimer = null;
        if (!LatestLine || LatestLine === LastSentLine) return;
        LastSentLine = LatestLine;
        Report(65, LatestLine.slice(0, 200));
      };
      const QueueOutput = (chunk: string) => {
        const line = ExtractLastLine(chunk);
        if (!line) return;
        LatestLine = line;
        if (FlushTimer) return;
        FlushTimer = setTimeout(FlushLine, 200);
        if (FlushTimer && typeof FlushTimer.unref === 'function') FlushTimer.unref();
      };

      // Output keeps being READ after the run has settled, but is discarded. A
      // process the script launched can inherit these pipes and outlive it; if
      // we stopped draining them it would block the moment it wrote, and
      // destroying them would hand it EPIPE — either of which can take down the
      // very show application the script started.
      Child.stdout.on('data', (data) => {
        if (Settled) return;
        const text = data.toString();
        StdOut += text;
        QueueOutput(text);
      });
      Child.stderr.on('data', (data) => {
        if (Settled) return;
        const text = data.toString();
        StdErr += text;
        QueueOutput(text);
      });

      Child.on('error', (error) => {
        if (Settled) return;
        Logger.error(`Error executing script: ${error.message}`);
        Fail(error);
      });

      Child.on('close', (code, signal) => {
        // Stop tailing; the Complete response now owns the final StatusText.
        if (Settled) return;
        if (code === 0) {
          Logger.success(`Script executed successfully: ${StdOut}`);
          Succeed(StdOut);
          return;
        }
        // A non-zero exit is a failed run. Its stderr is usually the reason, so
        // that is what the operator sees; the exit code is the fallback.
        const Message =
          Internal.TailText(StdErr) ||
          (code === null && signal
            ? `Script was stopped by ${signal}.`
            : `Script exited with code ${code}.`);
        Logger.warn(`Script exited non-zero (${code ?? signal}): ${Message}`);
        Fail(new Error(Message));
      });

      // The script's Timeout is enforced here, so it applies to every run path
      // (server dispatch, tray, run-on-launch). On expiry the run fails at once
      // rather than waiting for 'close': a process the script launched can hold
      // the output pipes open indefinitely, so 'close' may never come.
      if (!Settled) {
        const Limit = Math.max(1, Number(TimeoutMs) || DEFAULT_SCRIPT_TIMEOUT_MS);
        TimeoutTimer = setTimeout(() => {
          Logger.warn(`Script timed out after ${Limit}ms; stopping it: ${ScriptPath}`);
          Tracked.Abort(`Script timed out after ${Internal.FormatTimeout(Limit)}.`);
        }, Limit);
        if (typeof TimeoutTimer.unref === 'function') TimeoutTimer.unref();
      }
    });
  },
};

export const Manager = {
  async SetScripts(Scripts: ClientScript[] | null | undefined): Promise<void> {
    ScriptCache = Scripts || [];
    BroadcastManager.emit('ScriptsUpdated', Manager.GetScripts());
  },

  GetScripts(): ClientScript[] {
    return Array.isArray(ScriptCache) ? ScriptCache.slice() : [];
  },

  GetTrayScriptEntries(): TrayScriptEntry[] {
    return Manager.GetScripts()
      .filter((Script) => Script && typeof Script === 'object')
      .sort((A, B) => {
        const weightDelta = (Number(A.Weight) || 0) - (Number(B.Weight) || 0);
        if (weightDelta !== 0) return weightDelta;
        const nameDelta = String(A.Name || '').localeCompare(String(B.Name || ''));
        if (nameDelta !== 0) return nameDelta;
        return String(A.ID || '').localeCompare(String(B.ID || ''));
      })
      .map((Script) => {
        const LaunchState = Internal.GetScriptLaunchState(Script);
        return {
          Script,
          Enabled: !!LaunchState.Enabled,
          DisabledReason: LaunchState.DisabledReason || '',
        };
      });
  },

  async GetExpectedDeploymentFingerprint(Scripts: ClientScript[] | null = null): Promise<string> {
    const TargetScripts = Array.isArray(Scripts) ? Scripts : ScriptCache;
    return Internal.BuildDeploymentFingerprint(TargetScripts || []);
  },

  async GetLastAppliedDeploymentFingerprint(): Promise<string | null> {
    Internal.LoadDeploymentState();
    return LastAppliedDeploymentFingerprint;
  },

  // Resolve a script by ID (from the in-RAM cache, which may have been hydrated
  // from disk at launch) and report whether it is runnable on this platform.
  // Used by the run-on-launch flow to decide whether to show the countdown.
  GetLaunchState(ScriptID: string): {
    Found: boolean;
    Enabled: boolean;
    DisabledReason: string;
    Name: string | null;
  } {
    const Script = ScriptCache.find((s) => s && s.ID === ScriptID);
    if (!Script) {
      return { Found: false, Enabled: false, DisabledReason: 'Script not found.', Name: null };
    }
    const State = Internal.GetScriptLaunchState(Script);
    return {
      Found: true,
      Enabled: !!State.Enabled,
      DisabledReason: State.DisabledReason || '',
      Name: Script.Name ? String(Script.Name) : ScriptID,
    };
  },

  async Execute(
    _RequestID: string,
    ScriptID: string,
    OnProgress?: ProgressReporter,
    // Resolved by the server at dispatch time and therefore fresher than the
    // pushed cache — a script that waited its turn in the queue runs with the
    // values current when it actually started. Absent for tray and launch runs
    // (and from a server too old to send them), which fall back to the cache.
    Variables: VariableEnvironment | null = null
  ): Promise<[string | null, boolean]> {
    // OnProgress(Progress:0-100, StatusText) lets the server render a live
    // progress bar / running spinner. It is optional so other callers still work.
    const Report: ProgressReporter = typeof OnProgress === 'function' ? OnProgress : () => {};
    const Script = ScriptCache.find((s) => s.ID === ScriptID);
    if (!Script) return ['Script not found.', false];
    Logger.log(`Executing script: ${Script.Name} (${Script.ID})`);
    try {
      Report(10, 'Preparing');
      const LaunchState = Internal.GetScriptLaunchState(Script);
      if (!LaunchState.Enabled || !LaunchState.ScriptPath) {
        Logger.error(`Script is not runnable on this platform: ${LaunchState.DisabledReason}`);
        return [LaunchState.DisabledReason, false];
      }
      const PlatformArgString = Internal.ResolvePlatformArguments(Script);
      const PlatformArgs = Internal.ParseArgumentString(PlatformArgString);
      Report(30, 'Launching');
      await Internal.RunScriptFile(
        LaunchState.ScriptPath,
        PlatformArgs,
        Report,
        Script.ConsoleFilter,
        Variables || VariableStore.GetEnvironment(),
        Internal.ResolveTimeoutMs(Script)
      );
      Logger.success(`Script ${Script.Name} executed successfully`);
      return [null, true];
    } catch (error) {
      Logger.error(`Error executing script ${Script.Name}`, error);
      // The real reason goes back to the operator. Never an empty string: the
      // Server reads a falsy error as success.
      const Message = ErrorMessage(error, '').trim();
      return [Message || 'Failed to run script.', false];
    }
  },

  // Stop every script this client is still running — direct child processes
  // only, so anything a script launched keeps running (see KillDirectChild).
  // Called on app quit. Returns how many were stopped.
  StopRunningScripts(Reason = 'Script was stopped because ShowTrak Client is quitting.'): number {
    const Running = Array.from(RunningScripts);
    for (const Entry of Running) Entry.Abort(Reason);
    return Running.length;
  },

  async DeleteScripts(): Promise<void> {
    ScriptCache = [];
    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    if (fs.existsSync(ScriptsDirectory)) {
      fs.rmSync(ScriptsDirectory, { recursive: true, force: true });
      Logger.success(`Deleted all scripts from ${ScriptsDirectory}`);
    }
    fs.mkdirSync(ScriptsDirectory, { recursive: true });
    Internal.LoadDeploymentState();
    LastAppliedDeploymentFingerprint = null;
    Internal.PersistDeploymentState();
    BroadcastManager.emit('ScriptsUpdated', Manager.GetScripts());
    return;
  },

  async DownloadScripts(
    IP: string,
    Port: number,
    Scripts: ClientScript[] | null | undefined
  ): Promise<void> {
    ScriptCache = Scripts || [];

    Logger.log(`Updating scripts from server ${IP}:${Port}`);

    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    const Failures: string[] = [];

    for (const Script of Scripts || []) {
      if (!Script || !Script.ID) {
        Failures.push('Invalid command JSON (Script.json): missing script ID');
        continue;
      }
      if (Script.isValid === false) {
        const ParseError = Script.ParseError ? ` (${Script.ParseError})` : '';
        Failures.push(`Invalid command JSON (Script.json) for ${Script.ID}${ParseError}`);
        continue;
      }

      const ScriptPath = Internal.ResolveContained(ScriptsDirectory, Script.ID);
      if (!ScriptPath) {
        Failures.push(`Refusing to deploy ${Script.ID}: script ID escapes the scripts directory`);
        continue;
      }
      Logger.log(`Downloading SCRIPT: ${Script.ID}`);

      if (!fs.existsSync(ScriptPath)) {
        fs.mkdirSync(ScriptPath, { recursive: true });
      }

      const ScriptFiles = Array.isArray(Script.Files) ? Script.Files : [];
      for (const File of ScriptFiles) {
        const { Path, Type } = File;

        const FilePath = Internal.ResolveContained(ScriptPath, Path);
        if (!FilePath) {
          const Message = `Refusing to deploy ${Script.ID}/${Path}: path escapes the script directory`;
          Logger.error(Message);
          Failures.push(Message);
          continue;
        }

        if (Type === 'directory') {
          try {
            fs.mkdirSync(FilePath, { recursive: true });
            Logger.success(`Created Folder ${FilePath}`);
          } catch (Err) {
            const Message = `Failed to create folder ${Path} for ${Script.ID}: ${(Err as Error).message}`;
            Logger.error(Message);
            Failures.push(Message);
          }
        } else {
          const { Checksum } = File;
          let ShouldDownload = true;
          if (fs.existsSync(FilePath)) {
            const OldChecksum = await ChecksumFile(FilePath, (m) => Logger.debug(m));
            if (OldChecksum === Checksum) {
              ShouldDownload = false;
              Logger.success(`Checksum for file ${FilePath} matches, skipping`);
            } else {
              Logger.warn(`Checksum for file ${FilePath} does not match, downloading`);
            }
          } else {
            Logger.success(`File does not exist: ${Path}, downloading`);
          }
          if (ShouldDownload) {
            const fileUrl = `http://${IP}:${Port}/${Script.ID}/${Path.replaceAll('\\', '/')}`;
            try {
              const response = await fetch(fileUrl);
              if (!response.ok) {
                const Message = `Failed to download ${Path} from ${fileUrl}: ${response.status} ${response.statusText}`;
                Logger.error(Message);
                Failures.push(Message);
                continue;
              }
              const Contents = Buffer.from(await response.arrayBuffer());

              // Verify what actually arrived before it lands on disk, because
              // everything under the scripts directory is later handed to
              // spawn(). The checksum above only decides whether a file already
              // on disk is stale; without this check the downloaded bytes were
              // never compared to anything, so a truncated transfer or a
              // response from the wrong server was executed as-is.
              //
              // A manifest entry with no checksum is not treated as a failure:
              // the Server writes null when it could not hash the file, and
              // refusing those would turn a Server-side read error into a
              // client that cannot deploy at all. It is logged instead.
              if (Checksum) {
                const Actual = ChecksumBuffer(Contents);
                if (Actual !== Checksum) {
                  const Message = `Refusing to deploy ${Script.ID}/${Path}: checksum mismatch (expected ${Checksum}, got ${Actual})`;
                  Logger.error(Message);
                  Failures.push(Message);
                  continue;
                }
              } else {
                Logger.warn(
                  `No checksum published for ${Script.ID}/${Path}; writing unverified contents`
                );
              }

              fs.writeFileSync(FilePath, Contents);
              Logger.success(`Downloaded ${FilePath}`);
            } catch (Err) {
              const Message = `Failed to deploy ${Script.ID}/${Path}: ${(Err as Error).message}`;
              Logger.error(Message);
              Failures.push(Message);
            }
          }
        }
      }

      Logger.success(`Downloaded script ${Script.ID}`);
    }

    if (Failures.length > 0) {
      throw new Error(Failures.join('; '));
    }

    Internal.LoadDeploymentState();
    LastAppliedDeploymentFingerprint = Internal.BuildDeploymentFingerprint(Scripts || []);
    Internal.PersistDeploymentState();
    BroadcastManager.emit('ScriptsUpdated', Manager.GetScripts());
  },
};

export const _internal = Internal;
