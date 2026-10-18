import { execFile } from 'node:child_process';

// `df -kP`: capacity and free space per mount, the one reading macOS and Linux
// share. POSIX output, so one line per filesystem whatever the name lengths:
//
//   Filesystem     1024-blocks       Used Available Capacity  Mounted on
//   /dev/disk3s1s1  1948455240   12343216 193563092     6%    /
//   //tk@nas/Show    976762584  512000000 464762584    53%    /Volumes/Show
//
// Both the device and the mount point may contain spaces, so a line is read
// from its numeric columns outwards rather than split on whitespace. Free space
// is the Available column — what the client's user can actually write, which
// on Linux excludes the blocks reserved for root and on APFS is the whole
// container's free space, as Finder shows it.

export interface DfRow {
  Device: string;
  MountPoint: string;
  TotalBytes: number;
  FreeBytes: number;
}

const LINE = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/;

export function ParseDfOutput(Output: string): DfRow[] {
  const Rows: DfRow[] = [];
  for (const Raw of String(Output || '').split(/\r?\n/)) {
    const Match = LINE.exec(Raw.trimEnd());
    if (!Match) continue;
    Rows.push({
      Device: Match[1]!.trim(),
      MountPoint: Match[6]!,
      TotalBytes: Number(Match[2]) * 1024,
      FreeBytes: Number(Match[4]) * 1024,
    });
  }
  return Rows;
}

/** The environment df and mount run under: untranslated output, whatever the locale. */
export function CLocaleEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

// A hung network share can block df indefinitely; this bounds a sample.
const DF_TIMEOUT_MS = 10000;

/**
 * Run df and keep what it printed even when it exits non-zero: df reports every
 * filesystem it can and fails overall when any one of them cannot be read (a
 * share gone stale, a permission refused), and the rest are still good.
 */
export function RunDf(Args: string[]): Promise<{ Error: unknown; Output: string }> {
  return new Promise((resolve) => {
    execFile(
      'df',
      Args,
      { timeout: DF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: CLocaleEnv() },
      (Error_, Stdout) => resolve({ Error: Error_ || null, Output: String(Stdout || '') })
    );
  });
}
