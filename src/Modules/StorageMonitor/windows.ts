import type { StorageHealth, StorageVolume, StorageVolumeKind } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreatePowerShellHost } from '../ProcessMonitor/powershell-host';
import { RunCommand } from '../AudioMonitor/shared';

// Windows: every drive letter from Win32_LogicalDisk (local, removable and
// mapped network drives — not optical drives or RAM disks), with each volume's
// HealthStatus from Get-Volume and its read-only state from Get-Partition and
// Get-Disk. Those two come from the Storage module (Windows 8 / Server 2012 and
// later); where it is missing, or a drive has no partition (a mapped share), the
// field is null and reads as "cannot tell" on the server.
//
// A removable drive with no media in it (an empty card reader) reports no size
// and is left out, as Explorer leaves it unsized.

export const WINDOWS_STORAGE_SCRIPT = [
  '& {',
  '  $health = @{}',
  '  try { Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object { $health[[string]$_.DriveLetter] = [string]$_.HealthStatus } } catch {}',
  '  $readOnly = @{}',
  '  try {',
  '    $disks = @{}',
  '    Get-Disk -ErrorAction Stop | ForEach-Object { $disks[[int]$_.Number] = [bool]$_.IsReadOnly }',
  '    Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object { $readOnly[[string]$_.DriveLetter] = ([bool]$_.IsReadOnly -or [bool]$disks[[int]$_.DiskNumber]) }',
  '  } catch {}',
  '  $rows = @(Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 -or $_.DriveType -eq 4 } | ForEach-Object {',
  "    $letter = ([string]$_.DeviceID).TrimEnd(':')",
  '    [pscustomobject]@{ Drive = $_.DeviceID; Label = $_.VolumeName; FileSystem = $_.FileSystem; Size = $_.Size; Free = $_.FreeSpace; Type = $_.DriveType; Provider = $_.ProviderName; Health = $health[$letter]; ReadOnly = $readOnly[$letter] }',
  '  });',
  '  ConvertTo-Json -Compress -InputObject @($rows)',
  '}',
].join(' ');

/** Get-Volume's HealthStatus: Healthy, Warning (scan or repair needed), Unhealthy. */
function HealthOf(Value: unknown): StorageHealth | null {
  const Text = String(Value ?? '')
    .trim()
    .toLowerCase();
  if (Text === 'healthy' || Text === '0') return 'ok';
  if (Text === 'warning' || Text === '1') return 'warning';
  if (Text === 'unhealthy' || Text === '2') return 'failing';
  return null;
}

/** Win32_LogicalDisk.DriveType: 2 removable, 3 local, 4 network. */
function KindOf(Value: unknown): StorageVolumeKind {
  const Type = Number(Value);
  if (Type === 3) return 'internal';
  if (Type === 2) return 'external';
  if (Type === 4) return 'network';
  return 'unknown';
}

function Text(Value: unknown): string | null {
  return typeof Value === 'string' && Value.trim() ? Value.trim() : null;
}

/** Parse the script's JSON: an array, one bare object, or nothing at all. */
export function ParseWindowsStorage(Output: string): StorageVolume[] {
  const Trimmed = String(Output || '').trim();
  if (!Trimmed) return [];
  const Line = Trimmed.split(/\r?\n/)
    .map((Entry) => Entry.trim())
    .reverse()
    .find((Entry) => Entry.startsWith('[') || Entry.startsWith('{'));
  if (!Line) throw new Error('Storage query returned no drive list');
  const Parsed: unknown = JSON.parse(Line);
  const Volumes: StorageVolume[] = [];
  for (const Raw of (Array.isArray(Parsed) ? Parsed : [Parsed]) as unknown[]) {
    if (!Raw || typeof Raw !== 'object') continue;
    const Row = Raw as Record<string, unknown>;
    const Drive = Text(Row.Drive);
    const TotalBytes = Number(Row.Size);
    const FreeBytes = Number(Row.Free);
    if (!Drive || !Number.isFinite(TotalBytes) || TotalBytes <= 0) continue;
    const Kind = KindOf(Row.Type);
    Volumes.push({
      MountPoint: Drive.toUpperCase(),
      // A mapped share has no label; its UNC path is what it is known by.
      Name: Text(Row.Label) || (Kind === 'network' ? Text(Row.Provider) : null),
      FileSystem: Text(Row.FileSystem),
      Kind,
      TotalBytes,
      FreeBytes: Number.isFinite(FreeBytes) && FreeBytes > 0 ? Math.min(FreeBytes, TotalBytes) : 0,
      ReadOnly: typeof Row.ReadOnly === 'boolean' ? Row.ReadOnly : null,
      Health: HealthOf(Row.Health),
    });
  }
  return Volumes;
}

const HOST_TIMEOUT_MS = 20000;
const Host = CreatePowerShellHost('StoragePowerShellHost');

/** Run in the persistent host, falling back to a one-shot powershell.exe. */
async function RunPowerShell(Script: string): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, HOST_TIMEOUT_MS);
  if (!HostError && Output !== null) return [null, Output];
  return RunCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${Script}`,
  ]);
}

export async function CollectWindowsStorage(): Promise<Result<StorageVolume[]>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_STORAGE_SCRIPT);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [null, ParseWindowsStorage(Output)];
  } catch (error) {
    return [error, null];
  }
}

/** Release the resident PowerShell host. */
export function DisposeWindowsStorage(): void {
  Host.Dispose();
}

export const _internal = { Host };
