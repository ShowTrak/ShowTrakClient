// Per-platform firmware identifier acquisition.
//
// BEST-EFFORT and FAIL-SOFT throughout: any probe may return null (permissions,
// missing tools, unusual hardware) and the caller falls back to a MAC-derived
// identity. Probes are injectable so the logic is testable without touching the
// real OS. Mirrors the approach in ../DisplayMonitor/identity.js.

const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const PROBE_TIMEOUT_MS = 5000;

function runCommand(command, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          resolve(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
        }
      );
    } catch (_error) {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Windows: SMBIOS UUID via CIM.
// ---------------------------------------------------------------------------
// root\cimv2 is readable by Authenticated Users, so this needs no elevation.
// Deliberately NOT `wmic csproduct get uuid`: wmic is deprecated and removed in
// Windows 11 24H2 / Server 2025.
const WINDOWS_PS_COMMAND =
  'Get-CimInstance -ClassName Win32_ComputerSystemProduct | Select-Object -ExpandProperty UUID';

function parseWindowsUUID(stdout) {
  if (!stdout) return null;
  const value = stdout.trim();
  return value || null;
}

async function getWindowsFirmwareId(exec = runCommand) {
  const stdout = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_COMMAND],
    { timeout: PROBE_TIMEOUT_MS }
  );
  return parseWindowsUUID(stdout);
}

// ---------------------------------------------------------------------------
// macOS: IOPlatformUUID. Readable as a normal user.
// ---------------------------------------------------------------------------
function parseMacUUID(stdout) {
  if (!stdout) return null;
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
  return match ? match[1].trim() || null : null;
}

async function getMacFirmwareId(exec = runCommand) {
  const stdout = await exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    timeout: PROBE_TIMEOUT_MS,
  });
  return parseMacUUID(stdout);
}

// ---------------------------------------------------------------------------
// Linux: DMI. All of these are mode 0400 (root-only), so an unprivileged
// Electron session will typically read none of them and fall back to MAC. We
// still try: kiosk/root deployments benefit, and a failed read is cheap.
//
// We never cache the value to disk to work around the permission problem: a
// cached file is exactly what Clonezilla clones, which is the bug we are
// fixing. Live read or nothing.
// ---------------------------------------------------------------------------
const LINUX_DMI_PATHS = [
  '/sys/class/dmi/id/product_uuid',
  '/sys/class/dmi/id/board_serial',
  '/sys/class/dmi/id/product_serial',
];

function getLinuxFirmwareId(readFile = fs.readFileSync) {
  for (const dmiPath of LINUX_DMI_PATHS) {
    try {
      const value = String(readFile(dmiPath, 'utf-8')).trim();
      if (value) return value;
    } catch (_error) {
      // Almost always EACCES for a non-root client. Try the next path.
    }
  }
  return null;
}

// Dispatch to the correct platform probe. Fail-soft: never throws.
async function GetFirmwareId(platform = os.platform()) {
  try {
    switch (platform) {
      case 'win32':
        return await getWindowsFirmwareId();
      case 'darwin':
        return await getMacFirmwareId();
      case 'linux':
        return getLinuxFirmwareId();
      default:
        return null;
    }
  } catch (_error) {
    return null;
  }
}

module.exports = {
  GetFirmwareId,
  // Exposed for tests.
  _internal: {
    runCommand,
    parseWindowsUUID,
    parseMacUUID,
    getWindowsFirmwareId,
    getMacFirmwareId,
    getLinuxFirmwareId,
    LINUX_DMI_PATHS,
    PROBE_TIMEOUT_MS,
  },
};
