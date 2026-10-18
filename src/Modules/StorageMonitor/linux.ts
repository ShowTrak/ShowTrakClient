import fs from 'node:fs';
import path from 'node:path';

import type { StorageVolume, StorageVolumeKind } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { ParseDfOutput, RunDf, type DfRow } from './df';

// Linux: /proc/mounts says what is mounted where and how, `df -kP` sizes the
// mounts chosen from it, /dev/disk/by-label names them and sysfs says which
// sit on USB. Drive health is not reported: SMART needs root (smartctl), which
// the client does not have.
//
// What counts as a disk: anything mounted from a block device, plus network
// shares. Kernel and container plumbing (proc, tmpfs, cgroups, overlay), snap
// squashfs images and loop devices are left out, and so is a second mount of a
// device already listed (a bind mount, or a btrfs subvolume of the same pool),
// since its free space is the same space.

export interface LinuxMount {
  Device: string;
  MountPoint: string;
  FileSystem: string;
  Options: string[];
}

/** /proc/mounts escapes space, tab, newline and backslash as octal. */
function Unescape(Field: string): string {
  return Field.replace(/\\([0-7]{3})/g, (_Match, Octal: string) =>
    String.fromCharCode(parseInt(Octal, 8))
  );
}

export function ParseProcMounts(Text: string): LinuxMount[] {
  const Mounts: LinuxMount[] = [];
  for (const Line of String(Text || '').split('\n')) {
    const Fields = Line.trim().split(/\s+/);
    if (Fields.length < 4) continue;
    Mounts.push({
      Device: Unescape(Fields[0]!),
      MountPoint: Unescape(Fields[1]!),
      FileSystem: Fields[2]!,
      Options: Fields[3]!.split(','),
    });
  }
  return Mounts;
}

const NETWORK_FILESYSTEMS: ReadonlySet<string> = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  'fuse.sshfs',
  'davfs',
  'fuse.davfs2',
]);
const SKIPPED_FILESYSTEMS: ReadonlySet<string> = new Set(['squashfs', 'iso9660', 'udf']);
// Kernel, runtime and container trees. /run/media is not one of them: it is
// where udisks mounts USB drives on most desktops.
const SKIPPED_TREES = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker'];

function IsUnder(MountPoint: string, Tree: string): boolean {
  return MountPoint === Tree || MountPoint.startsWith(`${Tree}/`);
}

function IsSkippedTree(MountPoint: string): boolean {
  if (IsUnder(MountPoint, '/run/media')) return false;
  return SKIPPED_TREES.some((Tree) => IsUnder(MountPoint, Tree));
}

/** The mounts worth reporting, in mount order, one per device (see the header). */
export function SelectLinuxMounts(Mounts: LinuxMount[]): LinuxMount[] {
  const Selected: LinuxMount[] = [];
  const Devices = new Set<string>();
  for (const Mount of Mounts) {
    const Network = NETWORK_FILESYSTEMS.has(Mount.FileSystem);
    const Block = Mount.Device.startsWith('/dev/') && !Mount.Device.startsWith('/dev/loop');
    if (!Network && !Block) continue;
    if (SKIPPED_FILESYSTEMS.has(Mount.FileSystem) || IsSkippedTree(Mount.MountPoint)) continue;
    if (Devices.has(Mount.Device)) continue;
    Devices.add(Mount.Device);
    Selected.push(Mount);
  }
  return Selected;
}

/** Filesystem access for the sysfs/by-label lookups, injectable so tests need no /sys. */
export interface LinuxFsReader {
  ReadDir(Directory: string): string[];
  ReadFile(File: string): string | null;
  /** The resolved path, or null when it does not exist. */
  RealPath(Path: string): string | null;
}

export const NodeLinuxFsReader: LinuxFsReader = {
  ReadDir: (Directory) => {
    try {
      return fs.readdirSync(Directory);
    } catch (_error) {
      return [];
    }
  },
  ReadFile: (File) => {
    try {
      return fs.readFileSync(File, 'utf8');
    } catch (_error) {
      return null;
    }
  },
  RealPath: (Target) => {
    try {
      return fs.realpathSync(Target);
    } catch (_error) {
      return null;
    }
  },
};

/** Device (resolved) → filesystem label, from the /dev/disk/by-label symlinks. */
export function ReadLinuxLabels(Reader: LinuxFsReader = NodeLinuxFsReader): Map<string, string> {
  const Labels = new Map<string, string>();
  const Directory = '/dev/disk/by-label';
  for (const Entry of Reader.ReadDir(Directory)) {
    const Device = Reader.RealPath(path.posix.join(Directory, Entry));
    if (!Device) continue;
    // udev escapes unsafe characters as \xHH ("My\x20Disk").
    const Label = Entry.replace(/\\x([0-9a-f]{2})/gi, (_Match, Hex: string) =>
      String.fromCharCode(parseInt(Hex, 16))
    );
    Labels.set(Device, Label);
  }
  return Labels;
}

/**
 * Internal or external, from where sysfs places the block device: anything
 * under a USB controller is external, as is a disk the kernel marks removable
 * (an SD card reader). A device-mapper or md device reads as internal.
 */
export function LinuxDeviceKind(
  Device: string,
  Reader: LinuxFsReader = NodeLinuxFsReader
): StorageVolumeKind {
  const Resolved = Reader.RealPath(Device) || Device;
  const Name = path.posix.basename(Resolved);
  const SysPath = Reader.RealPath(`/sys/class/block/${Name}`);
  if (!SysPath) return 'unknown';
  if (SysPath.includes('/usb')) return 'external';
  // A partition's "removable" flag lives on its parent disk.
  const Disk =
    Reader.ReadFile(path.posix.join(SysPath, 'partition')) !== null
      ? path.posix.dirname(SysPath)
      : SysPath;
  if ((Reader.ReadFile(path.posix.join(Disk, 'removable')) || '').trim() === '1') return 'external';
  return 'internal';
}

export function BuildLinuxVolumes(
  Selected: LinuxMount[],
  Df: DfRow[],
  Labels: ReadonlyMap<string, string>,
  KindOf: (Device: string) => StorageVolumeKind,
  RealPath: (Device: string) => string | null
): StorageVolume[] {
  const DfByMount = new Map(Df.map((Row) => [Row.MountPoint, Row]));
  const Volumes: StorageVolume[] = [];
  for (const Mount of Selected) {
    const Row = DfByMount.get(Mount.MountPoint);
    if (!Row || !(Row.TotalBytes > 0)) continue;
    const Network = NETWORK_FILESYSTEMS.has(Mount.FileSystem);
    const Resolved = Network ? null : RealPath(Mount.Device) || Mount.Device;
    Volumes.push({
      MountPoint: Mount.MountPoint,
      Name: (Resolved && Labels.get(Resolved)) || (Network ? Mount.Device : null),
      FileSystem: Mount.FileSystem || null,
      Kind: Network ? 'network' : KindOf(Mount.Device),
      TotalBytes: Row.TotalBytes,
      FreeBytes: Row.FreeBytes,
      ReadOnly: Mount.Options.includes('ro'),
      Health: null,
    });
  }
  return Volumes;
}

export async function CollectLinuxStorage(
  Reader: LinuxFsReader = NodeLinuxFsReader
): Promise<Result<StorageVolume[]>> {
  const MountsText = Reader.ReadFile('/proc/mounts');
  if (MountsText === null) return [new Error('/proc/mounts could not be read'), null];
  const Selected = SelectLinuxMounts(ParseProcMounts(MountsText));
  if (!Selected.length) return [null, []];
  // Only the chosen mounts are sized, so a hung share elsewhere cannot stall
  // the sample — and one of these that hangs is cut off by the command timeout.
  const Df = await RunDf(['-kP', '--', ...Selected.map((Mount) => Mount.MountPoint)]);
  const Rows = ParseDfOutput(Df.Output);
  if (!Rows.length) return [Df.Error || new Error('df printed nothing'), null];
  return [
    null,
    BuildLinuxVolumes(
      Selected,
      Rows,
      ReadLinuxLabels(Reader),
      (Device) => LinuxDeviceKind(Device, Reader),
      (Device) => Reader.RealPath(Device)
    ),
  ];
}
