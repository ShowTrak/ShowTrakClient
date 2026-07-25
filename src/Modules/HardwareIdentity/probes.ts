// Per-platform firmware identifier acquisition.
//
// BEST-EFFORT and FAIL-SOFT throughout: any probe may return null (permissions,
// missing tools, unusual hardware) and the caller falls back to a MAC-derived
// identity. Probes are injectable so the logic is testable without touching the
// real OS. Mirrors the approach in ../DisplayMonitor/identity.ts.

import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;

/** Injectable command runner; resolves null on any failure. */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<string | null>;

/** Injectable file reader matching the `fs.readFileSync(path, 'utf-8')` shape. */
export type FileReader = (path: string, encoding: BufferEncoding) => string | Buffer;

function runCommand(
  command: string,
  args: string[],
  { timeout = PROBE_TIMEOUT_MS }: { timeout?: number } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          resolve(typeof stdout === 'string' ? stdout : String(stdout));
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

function parseWindowsUUID(stdout: string | null): string | null {
  if (!stdout) return null;
  const value = stdout.trim();
  return value || null;
}

async function getWindowsFirmwareId(exec: CommandRunner = runCommand): Promise<string | null> {
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
function parseMacUUID(stdout: string | null): string | null {
  if (!stdout) return null;
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
  return match ? (match[1] ?? '').trim() || null : null;
}

async function getMacFirmwareId(exec: CommandRunner = runCommand): Promise<string | null> {
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

function getLinuxFirmwareId(readFile: FileReader = fs.readFileSync): string | null {
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
export async function GetFirmwareId(platform: string = os.platform()): Promise<string | null> {
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

// Exposed for tests.
export const _internal = {
  runCommand,
  parseWindowsUUID,
  parseMacUUID,
  getWindowsFirmwareId,
  getMacFirmwareId,
  getLinuxFirmwareId,
  LINUX_DMI_PATHS,
  PROBE_TIMEOUT_MS,
};
