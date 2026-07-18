const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: AppDataManager } = require('../AppData');
const { Manager: ChecksumManager } = require('../ChecksumManager');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let ScriptCache = [];
let LastAppliedDeploymentFingerprint = null;
let DeploymentStateLoaded = false;

const Manager = {};

const Internal = {};

Internal.GetDeploymentStatePath = () => {
  return path.join(AppDataManager.GetProfileDirectory(), 'ScriptDeploymentState.json');
};

Internal.NormalizeFileEntryForFingerprint = (File) => {
  if (!File || typeof File !== 'object') return null;
  return {
    Path: String(File.Path || ''),
    Type: String(File.Type || ''),
    Checksum: File.Checksum ? String(File.Checksum) : null,
  };
};

Internal.BuildDeploymentFingerprint = (Scripts) => {
  const Normalized = (Array.isArray(Scripts) ? Scripts : [])
    .map((Script) => {
      if (!Script || typeof Script !== 'object') return null;
      const Files = (Array.isArray(Script.Files) ? Script.Files : [])
        .map((File) => Internal.NormalizeFileEntryForFingerprint(File))
        .filter(Boolean)
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
    .filter(Boolean)
    .sort((A, B) => A.ID.localeCompare(B.ID));

  return crypto.createHash('sha256').update(JSON.stringify(Normalized)).digest('hex');
};

Internal.LoadDeploymentState = () => {
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
    Logger.warn(`Failed to load script deployment state: ${Err.message}`);
    LastAppliedDeploymentFingerprint = null;
  }
};

Internal.PersistDeploymentState = () => {
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
    Logger.warn(`Failed to persist script deployment state: ${Err.message}`);
  }
};

// Ordered list of platform keys to try for the current OS, most specific first.
Internal.GetPlatformPreference = () => {
  if (process.platform === 'win32') return ['Windows'];
  if (process.platform === 'darwin') return ['macOS'];
  // Linux and Raspberry Pi use the same platform key.
  return ['Linux'];
};

// Normalize a relative script path so it resolves correctly on this OS,
// regardless of how it was authored: convert backslashes to forward slashes
// (path.join handles these on every platform) and strip leading "./" segments.
Internal.NormalizeRelativePath = (value) => {
  if (typeof value !== 'string') return '';
  let p = value.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.trim();
};

// Resolve the relative script file to run for the current platform. Falls back
// to a legacy top-level "Path" for scripts authored before the cross-platform
// schema. Returns the relative path string, or null if nothing is defined.
Internal.ResolvePlatformScript = (Script) => {
  const Platforms = Script && Script.Platforms ? Script.Platforms : {};
  for (const key of Internal.GetPlatformPreference()) {
    const value = Internal.NormalizeRelativePath(Platforms[key]);
    if (value) return value;
  }
  // Legacy single-path scripts.
  const legacy = Internal.NormalizeRelativePath(Script && Script.Path);
  if (legacy) return legacy;
  return null;
};

Internal.ResolvePlatformArguments = (Script) => {
  const ArgumentMap = Script && Script.Arguments ? Script.Arguments : {};
  for (const key of Internal.GetPlatformPreference()) {
    const value = typeof ArgumentMap[key] === 'string' ? ArgumentMap[key].trim() : '';
    if (value) return value;
  }
  return '';
};

Internal.GetScriptLaunchState = (Script) => {
  const ScriptID = Script && Script.ID ? String(Script.ID) : '';
  if (!Script || typeof Script !== 'object') {
    return { Enabled: false, DisabledReason: 'Invalid script configuration' };
  }
  if (!ScriptID) {
    return { Enabled: false, DisabledReason: 'Script is missing an ID' };
  }
  if (Script.isValid === false) {
    return {
      Enabled: false,
      DisabledReason: Script.ParseError
        ? String(Script.ParseError)
        : 'Invalid script configuration',
    };
  }
  if (Script.Enabled === false || Script.isEnabled === false) {
    return { Enabled: false, DisabledReason: 'Script is disabled' };
  }

  const RelativePath = Internal.ResolvePlatformScript(Script);
  if (!RelativePath) {
    return { Enabled: false, DisabledReason: 'No script is configured for this operating system' };
  }

  const ScriptPath = path.join(AppDataManager.GetScriptsDirectory(), ScriptID);
  if (!fs.existsSync(ScriptPath)) {
    return { Enabled: false, DisabledReason: 'Script path does not exist' };
  }

  const TargetFile = path.join(ScriptPath, RelativePath);
  if (!fs.existsSync(TargetFile)) {
    return {
      Enabled: false,
      DisabledReason: 'Script file for this operating system was not found',
    };
  }

  return {
    Enabled: true,
    DisabledReason: '',
    RelativePath,
    ScriptPath: TargetFile,
  };
};

// Parse a shell-like argument string into argv tokens.
// Supports spaces, single/double quotes, and backslash escaping.
Internal.ParseArgumentString = (value) => {
  const input = String(value || '').trim();
  if (!input) return [];

  const args = [];
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
    const ch = input[i];

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
};

// Resolve how to launch a script based on its file extension and the current
// platform. Returns { command, args } suitable for child_process.spawn, or null
// when the script type is not runnable on this platform.
Internal.ResolveLauncher = (ScriptPath) => {
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
};

// Compile a script's optional ConsoleFilter ({ Mode, Pattern }) into a line
// predicate, or return null when no filtering should be applied. Filtering is
// intentionally done on the CLIENT so scripts control what console output the
// server ever sees. Mode "none" (or an empty pattern) disables the filter; an
// uncompilable regex is treated as "no filter" so a bad pattern never silences
// all output.
Internal.CompileConsoleFilter = (ConsoleFilter) => {
  if (!ConsoleFilter || typeof ConsoleFilter !== 'object') return null;
  const Mode = String(ConsoleFilter.Mode || 'none');
  const Pattern = typeof ConsoleFilter.Pattern === 'string' ? ConsoleFilter.Pattern.trim() : '';
  if (Mode === 'none' || !Pattern) return null;

  if (Mode === 'startsWith') return (line) => line.startsWith(Pattern);
  if (Mode === 'regex') {
    let Regex;
    try {
      Regex = new RegExp(Pattern);
    } catch (Err) {
      Logger.warn(`Invalid console filter regex "${Pattern}" (${Err.message}); filter disabled`);
      return null;
    }
    return (line) => Regex.test(line);
  }
  // Default / "includes".
  return (line) => line.includes(Pattern);
};

// Compile a script's optional ConsoleFilter into a strip transform, or return
// null when nothing should be stripped. When ConsoleFilter.Strip is true the
// matched text is removed from a surfaced line, leaving only the remainder
// (trimmed). Only applied to lines that already passed CompileConsoleFilter.
// An uncompilable regex disables stripping (the whole line is surfaced as-is).
Internal.CompileConsoleStrip = (ConsoleFilter) => {
  if (!ConsoleFilter || typeof ConsoleFilter !== 'object') return null;
  if (ConsoleFilter.Strip !== true) return null;
  const Mode = String(ConsoleFilter.Mode || 'none');
  const Pattern = typeof ConsoleFilter.Pattern === 'string' ? ConsoleFilter.Pattern.trim() : '';
  if (Mode === 'none' || !Pattern) return null;

  if (Mode === 'startsWith') {
    return (line) => (line.startsWith(Pattern) ? line.slice(Pattern.length).trim() : line);
  }
  if (Mode === 'regex') {
    let Regex;
    try {
      Regex = new RegExp(Pattern, 'g');
    } catch (Err) {
      Logger.warn(`Invalid console filter regex "${Pattern}" (${Err.message}); strip disabled`);
      return null;
    }
    return (line) => line.replace(Regex, '').trim();
  }
  // Default / "includes": remove every occurrence of the pattern.
  return (line) => line.split(Pattern).join('').trim();
};

Internal.RunScriptFile = async (ScriptPath, ExtraArgs = [], OnProgress, ConsoleFilter = null) => {
  const Report = typeof OnProgress === 'function' ? OnProgress : () => {};
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');

    const Launcher = Internal.ResolveLauncher(ScriptPath);
    if (!Launcher) {
      return reject(new Error(`No launcher available for script: ${ScriptPath}`));
    }

    // Ensure the script is executable on POSIX platforms before launching it.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(ScriptPath, 0o755);
      } catch (chmodError) {
        Logger.warn(`Unable to set executable bit on ${ScriptPath}: ${chmodError.message}`);
      }
    }

    const Child = spawn(Launcher.command, Launcher.args.concat(ExtraArgs), {
      cwd: path.dirname(ScriptPath),
      windowsHide: true,
    });

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
    let FlushTimer = null;
    const ExtractLastLine = (text) => {
      const lines = String(text).split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const trimmed = lines[i].trim();
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
    const QueueOutput = (chunk) => {
      const line = ExtractLastLine(chunk);
      if (!line) return;
      LatestLine = line;
      if (FlushTimer) return;
      FlushTimer = setTimeout(FlushLine, 200);
      if (FlushTimer && typeof FlushTimer.unref === 'function') FlushTimer.unref();
    };

    Child.stdout.on('data', (data) => {
      const text = data.toString();
      StdOut += text;
      QueueOutput(text);
    });
    Child.stderr.on('data', (data) => {
      const text = data.toString();
      StdErr += text;
      QueueOutput(text);
    });

    Child.on('error', (error) => {
      if (FlushTimer) clearTimeout(FlushTimer);
      Logger.error(`Error executing script: ${error.message}`);
      reject(error);
    });

    Child.on('close', (code) => {
      // Stop tailing; the Complete response now owns the final StatusText.
      if (FlushTimer) clearTimeout(FlushTimer);
      // A non-zero exit code still means the script process completed.
      if (code !== 0) {
        const Message = StdErr.trim() || `Script exited with code ${code}`;
        Logger.warn(`Script exited non-zero (${code}): ${Message}`);
      } else {
        Logger.success(`Script executed successfully: ${StdOut}`);
      }
      resolve(StdOut);
    });
  });
};

Manager.SetScripts = async (Scripts) => {
  ScriptCache = Scripts || [];
  BroadcastManager.emit('ScriptsUpdated', Manager.GetScripts());
};

Manager.GetScripts = () => {
  return Array.isArray(ScriptCache) ? ScriptCache.slice() : [];
};

Manager.GetTrayScriptEntries = () => {
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
};

Manager.GetExpectedDeploymentFingerprint = async (Scripts = null) => {
  const TargetScripts = Array.isArray(Scripts) ? Scripts : ScriptCache;
  return Internal.BuildDeploymentFingerprint(TargetScripts || []);
};

Manager.GetLastAppliedDeploymentFingerprint = async () => {
  Internal.LoadDeploymentState();
  return LastAppliedDeploymentFingerprint;
};

// Resolve a script by ID (from the in-RAM cache, which may have been hydrated
// from disk at launch) and report whether it is runnable on this platform.
// Used by the run-on-launch flow to decide whether to show the countdown.
Manager.GetLaunchState = (ScriptID) => {
  const Script = ScriptCache.find((s) => s && s.ID === ScriptID);
  if (!Script) {
    return { Found: false, Enabled: false, DisabledReason: 'Script not found', Name: null };
  }
  const State = Internal.GetScriptLaunchState(Script);
  return {
    Found: true,
    Enabled: !!State.Enabled,
    DisabledReason: State.DisabledReason || '',
    Name: Script.Name ? String(Script.Name) : ScriptID,
  };
};

Manager.Execute = async (_RequestID, ScriptID, OnProgress) => {
  // OnProgress(Progress:0-100, StatusText) lets the server render a live
  // progress bar / running spinner. It is optional so other callers still work.
  const Report = typeof OnProgress === 'function' ? OnProgress : () => {};
  let Script = ScriptCache.find((s) => s.ID === ScriptID);
  if (!Script) return ['Script not found', false];
  Logger.log(`Executing script: ${Script.Name} (${Script.ID})`);
  try {
    Report(10, 'Preparing');
    const LaunchState = Internal.GetScriptLaunchState(Script);
    if (!LaunchState.Enabled) {
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
      Script.ConsoleFilter
    );
    Logger.success(`Script ${Script.Name} executed successfully`);
    return [null, true];
  } catch (error) {
    Logger.error(`Error executing script ${Script.Name}`, error);
    return ['An error occured during script execution', false];
  }
};

Manager.DeleteScripts = async () => {
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
};

Manager.DownloadScripts = async (IP, Port, Scripts) => {
  ScriptCache = Scripts || [];

  Logger.log(`Updating scripts from server ${IP}:${Port}`);

  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  const Failures = [];

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

    const ScriptPath = path.join(ScriptsDirectory, Script.ID);
    Logger.log(`Downloading SCRIPT: ${Script.ID}`);

    if (!fs.existsSync(ScriptPath)) {
      fs.mkdirSync(ScriptPath, { recursive: true });
    }

    const ScriptFiles = Array.isArray(Script.Files) ? Script.Files : [];
    for (const File of ScriptFiles) {
      let { Path, Type } = File;

      const FilePath = path.join(ScriptPath, Path);

      if (Type === 'directory') {
        try {
          fs.mkdirSync(FilePath, { recursive: true });
          Logger.success(`Created Folder ${FilePath}`);
        } catch (Err) {
          const Message = `Failed to create folder ${Path} for ${Script.ID}: ${Err.message}`;
          Logger.error(Message);
          Failures.push(Message);
        }
      } else {
        const { Checksum } = File;
        let ShouldDownload = true;
        if (fs.existsSync(FilePath)) {
          let OldChecksum = await ChecksumManager.Checksum(FilePath);
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
            Logger.success(`Downloaded ${FilePath}`);
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(FilePath, Buffer.from(buffer));
          } catch (Err) {
            const Message = `Failed to deploy ${Script.ID}/${Path}: ${Err.message}`;
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
};

module.exports = {
  Manager,
};
