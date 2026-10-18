import type { StorageHealth, StorageVolume, StorageVolumeKind } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { RunCommand } from '../AudioMonitor/shared';
import { CLocaleEnv, ParseDfOutput, RunDf, type DfRow } from './df';

// macOS: `df -kP` for sizes, `mount` for each mount's filesystem and flags, and
// `diskutil info -plist` for what only Disk Arbitration knows — the volume's
// name, whether its disk is internal, and the disk's SMART verdict.
//
// What an operator thinks of as "the disks" is the boot volume plus whatever
// Finder shows under /Volumes. Everything else macOS mounts (the hidden
// Preboot, VM, Update and Data volumes, simulator runtimes, autofs maps) is
// flagged `nobrowse` and left out.

/** One line of `mount`: "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)". */
export interface MacMount {
  Device: string;
  MountPoint: string;
  FileSystem: string;
  Flags: string[];
}

export function ParseMacMountOutput(Output: string): MacMount[] {
  const Mounts: MacMount[] = [];
  for (const Raw of String(Output || '').split(/\r?\n/)) {
    const Match = /^(.+?) on (\/.*) \(([^()]*)\)$/.exec(Raw.trim());
    if (!Match) continue;
    const [FileSystem, ...Flags] = Match[3]!.split(',').map((Part) => Part.trim());
    Mounts.push({
      Device: Match[1]!,
      MountPoint: Match[2]!,
      FileSystem: FileSystem || '',
      Flags: Flags.filter(Boolean),
    });
  }
  return Mounts;
}

/** What `diskutil info -plist` adds about one device. */
export interface DiskutilInfo {
  Name: string | null;
  Internal: boolean | null;
  Health: StorageHealth | null;
}

function DecodeXml(Text: string): string {
  return Text.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The three keys this needs out of the plist. SMARTStatus is "Verified" on a
 * healthy disk, "Failing" (or "About to Fail") on a dying one, and "Not
 * Supported" on anything that does not speak SMART — USB sticks, most USB
 * enclosures, disk images — which is no verdict rather than a healthy one.
 */
export function ParseDiskutilInfo(Plist: string): DiskutilInfo {
  const Text = String(Plist || '');
  const StringKey = (Key: string) => {
    const Match = new RegExp(`<key>${Key}</key>\\s*<string>([^<]*)</string>`).exec(Text);
    return Match ? DecodeXml(Match[1]!).trim() : null;
  };
  const BoolKey = (Key: string) => {
    const Match = new RegExp(`<key>${Key}</key>\\s*<(true|false)\\s*/>`).exec(Text);
    return Match ? Match[1] === 'true' : null;
  };
  const Smart = (StringKey('SMARTStatus') || '').toLowerCase();
  let Health: StorageHealth | null = null;
  if (Smart === 'verified') Health = 'ok';
  else if (Smart.includes('fail')) Health = 'failing';
  return { Name: StringKey('VolumeName') || null, Internal: BoolKey('Internal'), Health };
}

const NETWORK_FILESYSTEMS: ReadonlySet<string> = new Set([
  'smbfs',
  'nfs',
  'afpfs',
  'webdav',
  'cifs',
  'ftp',
]);
const SKIPPED_FILESYSTEMS: ReadonlySet<string> = new Set(['devfs', 'autofs']);

/** Whether a mount is one an operator would see as a disk (see the header). */
function IsShown(Mount: MacMount): boolean {
  if (SKIPPED_FILESYSTEMS.has(Mount.FileSystem)) return false;
  return Mount.MountPoint === '/' || !Mount.Flags.includes('nobrowse');
}

function IsNetwork(Mount: MacMount): boolean {
  return NETWORK_FILESYSTEMS.has(Mount.FileSystem) || !Mount.Flags.includes('local');
}

/**
 * Join the three readings into volumes. `Info` is keyed by device and may lack
 * any device (a network share has none, and a failed diskutil call costs only
 * that volume's name, kind and health).
 *
 * The boot volume needs one special case: since Catalina "/" is a sealed,
 * read-only snapshot of the system, and everything the machine writes goes to
 * its Data volume. So "/" is reported writable or not by its Data volume (the
 * mount flagged "root data"), which is what a monitored boot disk means.
 */
export function BuildMacVolumes(
  Df: DfRow[],
  Mounts: MacMount[],
  Info: ReadonlyMap<string, DiskutilInfo>
): StorageVolume[] {
  const MountByPoint = new Map(Mounts.map((Mount) => [Mount.MountPoint, Mount]));
  const DataVolume =
    Mounts.find((Mount) => Mount.Flags.includes('root data')) ||
    MountByPoint.get('/System/Volumes/Data');
  const Volumes: StorageVolume[] = [];
  for (const Row of Df) {
    const Mount = MountByPoint.get(Row.MountPoint);
    if (!Mount || !IsShown(Mount) || !(Row.TotalBytes > 0)) continue;
    const Details = Info.get(Mount.Device) || null;
    const Network = IsNetwork(Mount);
    let Kind: StorageVolumeKind = 'unknown';
    if (Network) Kind = 'network';
    else if (Details && Details.Internal !== null)
      Kind = Details.Internal ? 'internal' : 'external';
    const Flags =
      Mount.MountPoint === '/' && Mount.Flags.includes('sealed') && DataVolume
        ? DataVolume.Flags
        : Mount.Flags;
    Volumes.push({
      MountPoint: Row.MountPoint,
      Name:
        (Details && Details.Name) ||
        (Row.MountPoint.startsWith('/Volumes/') ? Row.MountPoint.slice('/Volumes/'.length) : null),
      FileSystem: Mount.FileSystem || null,
      Kind,
      TotalBytes: Row.TotalBytes,
      FreeBytes: Row.FreeBytes,
      ReadOnly: Flags.includes('read-only'),
      Health: Details ? Details.Health : null,
    });
  }
  return Volumes;
}

// A disk's name, kind and SMART verdict do not change while it stays attached,
// and diskutil is the slow part of a sample, so each device's answer is reused
// for this long.
const INFO_TTL_MS = 5 * 60 * 1000;
const InfoCache = new Map<string, { At: number; Info: DiskutilInfo }>();

async function DiskutilInfoFor(Device: string, Now: number): Promise<DiskutilInfo | null> {
  const Cached = InfoCache.get(Device);
  if (Cached && Now - Cached.At < INFO_TTL_MS) return Cached.Info;
  const [Error_, Output] = await RunCommand('diskutil', ['info', '-plist', Device], CLocaleEnv());
  if (Error_ || Output === null) return Cached ? Cached.Info : null;
  const Info = ParseDiskutilInfo(Output);
  InfoCache.set(Device, { At: Now, Info });
  return Info;
}

export async function CollectMacStorage(
  Now: number = Date.now()
): Promise<Result<StorageVolume[]>> {
  const DfResult = await RunDf(['-kP']);
  const Df = ParseDfOutput(DfResult.Output);
  if (!Df.length) return [DfResult.Error || new Error('df printed nothing'), null];
  const [MountError, MountOutput] = await RunCommand('mount', [], CLocaleEnv());
  if (MountError || MountOutput === null) {
    return [MountError || new Error('mount printed nothing'), null];
  }
  const Mounts = ParseMacMountOutput(MountOutput);
  const Shown = new Set(
    Mounts.filter((Mount) => IsShown(Mount) && !IsNetwork(Mount)).map((Mount) => Mount.Device)
  );
  const Info = new Map<string, DiskutilInfo>();
  for (const Device of Shown) {
    if (!Device.startsWith('/dev/')) continue;
    const Details = await DiskutilInfoFor(Device, Now);
    if (Details) Info.set(Device, Details);
  }
  // Forget disks that have gone, so a re-attached one is looked at afresh.
  for (const Device of InfoCache.keys()) if (!Shown.has(Device)) InfoCache.delete(Device);
  return [null, BuildMacVolumes(Df, Mounts, Info)];
}

export const _internal = { InfoCache, INFO_TTL_MS };
