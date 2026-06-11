const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

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

Internal.RunScriptFile = async (ScriptPath, ExtraArgs = []) => {
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

    let StdOut = '';
    let StdErr = '';

    Child.stdout.on('data', (data) => {
      StdOut += data.toString();
    });
    Child.stderr.on('data', (data) => {
      StdErr += data.toString();
    });

    Child.on('error', (error) => {
      Logger.error(`Error executing script: ${error.message}`);
      reject(error);
    });

    Child.on('close', (code) => {
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
};

Manager.GetExpectedDeploymentFingerprint = async (Scripts = null) => {
  const TargetScripts = Array.isArray(Scripts) ? Scripts : ScriptCache;
  return Internal.BuildDeploymentFingerprint(TargetScripts || []);
};

Manager.GetLastAppliedDeploymentFingerprint = async () => {
  Internal.LoadDeploymentState();
  return LastAppliedDeploymentFingerprint;
};

Manager.Execute = async (_RequestID, ScriptID) => {
  let Script = ScriptCache.find((s) => s.ID === ScriptID);
  if (!Script) return ['Script not found', false];
  Logger.log(`Executing script: ${Script.Name} (${Script.ID})`);
  try {
    const RelativePath = Internal.ResolvePlatformScript(Script);
    const PlatformArgString = Internal.ResolvePlatformArguments(Script);
    const PlatformArgs = Internal.ParseArgumentString(PlatformArgString);
    if (!RelativePath) {
      Logger.error(`No script defined for this platform (${process.platform}) on ${Script.Name}`);
      return ['No script is configured for this operating system', false];
    }
    const ScriptPath = path.join(AppDataManager.GetScriptsDirectory(), Script.ID);
    if (!fs.existsSync(ScriptPath)) {
      Logger.error(`Script path does not exist: ${ScriptPath}`);
      return ['Script path does not exist', false];
    }
    const TargetFile = path.join(ScriptPath, RelativePath);
    if (!fs.existsSync(TargetFile)) {
      Logger.error(`Script file does not exist: ${TargetFile}`);
      return ['Script file for this operating system was not found', false];
    }
    await Internal.RunScriptFile(TargetFile, PlatformArgs);
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
};

module.exports = {
  Manager,
};
