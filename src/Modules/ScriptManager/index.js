const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: ChecksumManager } = require('../ChecksumManager');

const fs = require('fs');
const path = require('path');

let ScriptCache = [];

const Manager = {};

const Internal = {};

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

Internal.RunScriptFile = async (ScriptPath) => {
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

    const Child = spawn(Launcher.command, Launcher.args, {
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
      if (code !== 0) {
        const Message = StdErr.trim() || `Script exited with code ${code}`;
        Logger.error(`Script failed (${code}): ${Message}`);
        return reject(new Error(Message));
      }
      Logger.success(`Script executed successfully: ${StdOut}`);
      resolve(StdOut);
    });
  });
};

Manager.SetScripts = async (Scripts) => {
  ScriptCache = Scripts || [];
};

Manager.Execute = async (_RequestID, ScriptID) => {
  let Script = ScriptCache.find((s) => s.ID === ScriptID);
  if (!Script) return ['Script not found', false];
  Logger.log(`Executing script: ${Script.Name} (${Script.ID})`);
  try {
    const RelativePath = Internal.ResolvePlatformScript(Script);
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
    await Internal.RunScriptFile(TargetFile);
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
  return;
};

Manager.DownloadScripts = async (IP, Port, Scripts) => {
  ScriptCache = Scripts || [];

  Logger.log(`Updating scripts from server ${IP}:${Port}`);

  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();

  for (const Script of Scripts) {
    const ScriptPath = path.join(ScriptsDirectory, Script.ID);
    Logger.log(`Downloading SCRIPT: ${Script.ID}`);

    if (!fs.existsSync(ScriptPath)) {
      fs.mkdirSync(ScriptPath, { recursive: true });
    }

    for (const File of Script.Files) {
      let { Path, Type } = File;

      const FilePath = path.join(ScriptPath, Path);

      if (Type === 'directory') {
        fs.mkdirSync(FilePath, { recursive: true });
        Logger.success(`Created Folder ${FilePath}`);
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
          const response = await fetch(fileUrl);
          if (!response.ok) {
            Logger.error(`Failed to download ${Path} from ${fileUrl}: ${response.statusText}`);
            continue;
          }
          Logger.success(`Downloaded ${FilePath}`);
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(FilePath, Buffer.from(buffer));
        }
      }
    }

    Logger.success(`Downloaded script ${Script.ID}`);
  }
};

module.exports = {
  Manager,
};
