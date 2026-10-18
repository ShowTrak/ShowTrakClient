import type { StorageHealth, StorageVolume, StorageVolumeKind } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import {
  CreatePowerShellHost,
  IsScriptFailure,
  SCRIPT_TIMED_OUT,
} from '../ProcessMonitor/powershell-host';
import { COMMAND_TIMEOUT_MS, ErrorText, RunCommand } from '../AudioMonitor/shared';

// Windows: every drive letter from Win32_LogicalDisk (local, removable and
// mapped network drives — not optical drives or RAM disks), with each volume's
// HealthStatus and read-only state from the Storage module's MSFT_Volume,
// MSFT_Partition and MSFT_Disk (Windows 8 / Server 2012 and later). Where that
// is missing, or a drive has no partition (a mapped share), the field is null
// and reads as "cannot tell" on the server.
//
// The two are separate queries because the Storage module can be very slow —
// tens of seconds on some machines — and asked every poll it made the whole
// reading time out. The drive list is read every poll; health and read-only
// are cached (see DETAIL_TTL_MS) and a slow or failed lookup only leaves them
// null, never the drives unreported.
//
// A removable drive with no media in it (an empty card reader) reports no size
// and is left out, as Explorer leaves it unsized.

export const WINDOWS_STORAGE_SCRIPT = [
  '& {',
  "  $rows = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 2 OR DriveType = 3 OR DriveType = 4' -OperationTimeoutSec 10 -ErrorAction Stop | ForEach-Object {",
  '    [pscustomobject]@{ Drive = $_.DeviceID; Label = $_.VolumeName; FileSystem = $_.FileSystem; Size = $_.Size; Free = $_.FreeSpace; Type = $_.DriveType; Provider = $_.ProviderName }',
  '  });',
  '  ConvertTo-Json -Compress -InputObject @($rows)',
  '}',
].join(' ');

// Drive letters are matched as text: a partition or volume without one reports
// the NUL character, not null.
export const WINDOWS_STORAGE_DETAIL_SCRIPT = [
  '& {',
  "  $ns = 'root/Microsoft/Windows/Storage'",
  '  $health = @{}',
  "  try { Get-CimInstance -Namespace $ns -ClassName MSFT_Volume -OperationTimeoutSec 4 -ErrorAction Stop | ForEach-Object { $l = [string]$_.DriveLetter; if ($l -match '^[A-Za-z]$') { $health[$l.ToUpper()] = [string]$_.HealthStatus } } } catch {}",
  '  $readOnly = @{}',
  '  try {',
  '    $disks = @{}',
  '    Get-CimInstance -Namespace $ns -ClassName MSFT_Disk -OperationTimeoutSec 4 -ErrorAction Stop | ForEach-Object { $disks[[string]$_.Number] = [bool]$_.IsReadOnly }',
  "    Get-CimInstance -Namespace $ns -ClassName MSFT_Partition -OperationTimeoutSec 4 -ErrorAction Stop | ForEach-Object { $l = [string]$_.DriveLetter; if ($l -match '^[A-Za-z]$') { $readOnly[$l.ToUpper()] = ([bool]$_.IsReadOnly -or [bool]$disks[[string]$_.DiskNumber]) } }",
  '  } catch {}',
  '  ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ Health = $health; ReadOnly = $readOnly })',
  '}',
].join(' ');

const Logger = CreateLogger('StorageMonitor');

/** MSFT_Volume.HealthStatus: 0 Healthy, 1 Warning (scan or repair needed), 2 Unhealthy, 5 Unknown. */
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

/** The last JSON line of a script's output; anything before it is PowerShell noise. */
function JsonLine(Output: string): string | null {
  return (
    String(Output || '')
      .trim()
      .split(/\r?\n/)
      .map((Entry) => Entry.trim())
      .reverse()
      .find((Entry) => Entry.startsWith('[') || Entry.startsWith('{')) || null
  );
}

/** "C:" → "C". */
function LetterOf(MountPoint: string): string {
  return MountPoint.replace(/:$/, '').toUpperCase();
}

/**
 * Parse the drive list: an array, one bare object, or nothing at all. ReadOnly
 * and Health are left null here; ApplyWindowsStorageDetail fills them in.
 */
export function ParseWindowsStorage(Output: string): StorageVolume[] {
  if (!String(Output || '').trim()) return [];
  const Line = JsonLine(Output);
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
      ReadOnly: null,
      Health: null,
    });
  }
  return Volumes;
}

/** Health and read-only state by drive letter, from the Storage module. */
export interface WindowsStorageDetail {
  Health: Record<string, StorageHealth>;
  ReadOnly: Record<string, boolean>;
}

const NO_DETAIL: WindowsStorageDetail = { Health: {}, ReadOnly: {} };

/** Parse the detail script's `{Health: {C: "0"}, ReadOnly: {C: false}}`. */
export function ParseWindowsStorageDetail(Output: string): WindowsStorageDetail {
  const Line = JsonLine(Output);
  if (!Line) throw new Error('Storage detail query returned nothing');
  const Parsed = JSON.parse(Line) as { Health?: unknown; ReadOnly?: unknown } | null;
  const Detail: WindowsStorageDetail = { Health: {}, ReadOnly: {} };
  const Entries = (Value: unknown) =>
    Value && typeof Value === 'object' ? Object.entries(Value as Record<string, unknown>) : [];
  for (const [Letter, Value] of Entries(Parsed?.Health)) {
    const Health = HealthOf(Value);
    if (Health) Detail.Health[Letter.toUpperCase()] = Health;
  }
  for (const [Letter, Value] of Entries(Parsed?.ReadOnly)) {
    if (typeof Value === 'boolean') Detail.ReadOnly[Letter.toUpperCase()] = Value;
  }
  return Detail;
}

export function ApplyWindowsStorageDetail(
  Volumes: StorageVolume[],
  Detail: WindowsStorageDetail
): StorageVolume[] {
  return Volumes.map((Volume) => {
    const Letter = LetterOf(Volume.MountPoint);
    return {
      ...Volume,
      ReadOnly: Detail.ReadOnly[Letter] ?? null,
      Health: Detail.Health[Letter] || null,
    };
  });
}

const VOLUMES_TIMEOUT_MS = 20000;
const DETAIL_TIMEOUT_MS = 15000;
// Health and read-only rarely change, so the slow lookup is repeated this often…
const DETAIL_TTL_MS = 5 * 60 * 1000;
// …or sooner when a drive letter appears or goes, but never more often than this,
// so a machine where the lookup always fails is not asked every poll.
const DETAIL_RETRY_MS = 60 * 1000;

const Host = CreatePowerShellHost('StoragePowerShellHost');
const DetailCache = {
  AttemptAt: -Infinity,
  Letters: '',
  Detail: NO_DETAIL,
};

/**
 * A one-shot powershell.exe failure as something worth reading. Node's own
 * message is "Command failed: " plus the entire command line, then stderr.
 */
export function OneShotError(Error_: unknown, TimeoutMs: number): Error {
  const Failure = (Error_ || {}) as { killed?: unknown; code?: unknown; message?: unknown };
  if (Failure.killed) {
    return new Error(`PowerShell did not answer within ${Math.round(TimeoutMs / 1000)} seconds`);
  }
  const Message = String(Failure.message || '');
  if (!Message.startsWith('Command failed:')) return new Error(Message || 'PowerShell failed');
  // Windows PowerShell's error record leads with the message, then "At line:1 …".
  const Reason = Message.split(/\r?\n/)
    .slice(1)
    .map((Line) => Line.trim())
    .find((Line) => Line && !Line.startsWith('#< CLIXML'));
  return new Error(Reason || `PowerShell exited with code ${String(Failure.code ?? 'unknown')}`);
}

/**
 * Run in the persistent host, falling back to a one-shot powershell.exe only when
 * the host itself could not run the script. A script that raised, or ran past its
 * deadline, would do the same again — and the one-shot's shorter deadline would
 * only turn a slow answer into a second failure.
 */
async function RunPowerShell(Script: string, TimeoutMs: number): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, TimeoutMs);
  if (!HostError && Output !== null) return [null, Output];
  if (IsScriptFailure(HostError)) return [HostError, null];
  const [Error_, OneShotOutput] = await RunCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${Script}`,
  ]);
  if (Error_ || OneShotOutput === null) return [OneShotError(Error_, COMMAND_TIMEOUT_MS), null];
  return [null, OneShotOutput];
}

/** The cached detail, refreshed first when it is stale or the drives changed. */
async function DetailFor(Volumes: StorageVolume[], Now: number): Promise<WindowsStorageDetail> {
  const Letters = Volumes.map((Volume) => LetterOf(Volume.MountPoint))
    .sort()
    .join(',');
  const SinceAttempt = Now - DetailCache.AttemptAt;
  const Due =
    SinceAttempt >= DETAIL_TTL_MS ||
    (Letters !== DetailCache.Letters && SinceAttempt >= DETAIL_RETRY_MS);
  if (!Due) return DetailCache.Detail;
  DetailCache.AttemptAt = Now;
  DetailCache.Letters = Letters;
  const [Error_, Output] = await RunPowerShell(WINDOWS_STORAGE_DETAIL_SCRIPT, DETAIL_TIMEOUT_MS);
  try {
    if (Error_ || Output === null) throw Error_ || new Error('No output');
    DetailCache.Detail = ParseWindowsStorageDetail(Output);
  } catch (error) {
    // The last answer is kept: health and read-only are unlikely to have changed.
    Logger.warn(`Storage health and read-only lookup failed: ${ErrorText(error, 'unknown error')}`);
  }
  return DetailCache.Detail;
}

export async function CollectWindowsStorage(): Promise<Result<StorageVolume[]>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_STORAGE_SCRIPT, VOLUMES_TIMEOUT_MS);
  if (Error_ || Output === null) {
    const Code = Error_ && typeof Error_ === 'object' ? (Error_ as { code?: unknown }).code : null;
    if (Code === SCRIPT_TIMED_OUT) {
      return [
        new Error(`Windows did not list the drives within ${VOLUMES_TIMEOUT_MS / 1000} seconds`),
        null,
      ];
    }
    return [new Error(`Could not list the drives: ${ErrorText(Error_, 'no output')}`), null];
  }
  let Volumes: StorageVolume[];
  try {
    Volumes = ParseWindowsStorage(Output);
  } catch (error) {
    return [error, null];
  }
  return [null, ApplyWindowsStorageDetail(Volumes, await DetailFor(Volumes, Date.now()))];
}

/** Release the resident PowerShell host. */
export function DisposeWindowsStorage(): void {
  Host.Dispose();
}

export const _internal = { Host, DetailCache, DETAIL_TTL_MS, DETAIL_RETRY_MS };
