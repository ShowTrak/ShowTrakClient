import { execFile } from 'child_process';
import os from 'os';

import type { RunningApplicationItem } from '@showtrak/protocol';
import type { ProcessMonitorState, ProcessMonitorStatus, Result } from '../../types/client';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';

const Logger = CreateLogger('ProcessMonitor');

const POLL_INTERVAL_MS = 20000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_REPORTED_APPLICATIONS = 64;

/** The states setStatus is ever called with; anything else degrades to unknown. */
const KNOWN_STATES: ReadonlySet<string> = new Set<ProcessMonitorState>([
  'unknown',
  'ok',
  'error',
  'permission_denied',
]);

let monitorInterval: NodeJS.Timeout | null = null;
let activeSocket: ShowTrakSocket | null = null;
let lastSignature: string | null = null;
let lastStatusSignature: string | null = null;
let currentStatus: ProcessMonitorStatus = {
  State: 'unknown',
  Message: null,
  Platform: process.platform,
};

const IGNORED_APPLICATION_NAMES = new Set([
  'bash',
  'cmd',
  'conhost',
  'dbus-daemon',
  'electron',
  'explorer',
  'fish',
  'gnome-shell',
  'init',
  'loginwindow',
  'node',
  'osascript',
  'powershell',
  'powershell_ise',
  'showtrak client',
  'showtrak-client',
  'sh',
  'systemd',
  'terminal',
  'windowserver',
  'zsh',
]);

function clearMonitorInterval(): void {
  if (!monitorInterval) return;
  clearInterval(monitorInterval);
  monitorInterval = null;
}

function execFileAsync(command: string, args: string[]): Promise<[unknown, string]> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve([error, '']);
        return resolve([null, String(stdout || '')]);
      }
    );
  });
}

interface NormalizedNames {
  Items: RunningApplicationItem[];
  TotalCount: number;
  Truncated: boolean;
}

function normalizeNames(names: unknown): NormalizedNames {
  const counts = new Map<string, RunningApplicationItem>();
  for (const rawName of Array.isArray(names) ? names : []) {
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (IGNORED_APPLICATION_NAMES.has(key)) continue;
    const current = counts.get(key);
    if (current) {
      current.Count += 1;
      continue;
    }
    counts.set(key, {
      Name: name,
      Count: 1,
    });
  }

  const items = Array.from(counts.values()).sort((left, right) => {
    if (right.Count !== left.Count) return right.Count - left.Count;
    return left.Name.localeCompare(right.Name);
  });

  const totalCount = items.length;
  const limitedItems = items.slice(0, MAX_REPORTED_APPLICATIONS);
  return {
    Items: limitedItems,
    TotalCount: totalCount,
    Truncated: totalCount > limitedItems.length,
  };
}

interface ApplicationsSnapshot {
  SampledAt: number;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationItem[];
  Signature: string;
}

function buildSnapshot(names: unknown): ApplicationsSnapshot {
  const normalized = normalizeNames(names);
  const signature = normalized.Items.map((item) => `${item.Name}:${item.Count}`).join('|');
  return {
    SampledAt: Date.now(),
    TotalCount: normalized.TotalCount,
    Truncated: normalized.Truncated,
    Items: normalized.Items,
    Signature: signature,
  };
}

function normalizeStatus(status: { State?: unknown; Message?: unknown }): ProcessMonitorStatus {
  const rawState =
    typeof status?.State === 'string' && status.State.trim().length > 0
      ? status.State.trim().toLowerCase()
      : 'unknown';
  // Every internal call site passes one of KNOWN_STATES, so this narrowing is
  // a no-op at runtime; it exists so the state stays a closed union.
  const state = (KNOWN_STATES.has(rawState) ? rawState : 'unknown') as ProcessMonitorState;
  const message =
    typeof status?.Message === 'string' && status.Message.trim().length > 0
      ? status.Message.trim()
      : null;
  return {
    State: state,
    Message: message,
    Platform: process.platform,
  };
}

function setStatus(status: { State?: unknown; Message?: unknown }): void {
  const next = normalizeStatus(status);
  const signature = `${next.State}|${next.Message || ''}|${next.Platform}`;
  if (lastStatusSignature === signature) return;
  lastStatusSignature = signature;
  currentStatus = next;
  BroadcastManager.emit('ProcessMonitorStatus', currentStatus);
}

function classifyCollectionError(error: unknown): { State: ProcessMonitorState; Message: string } {
  const message = String(
    error && (error as Error).message
      ? (error as Error).message
      : error || 'Unknown process monitor error'
  );
  if (/-1743|not authorized|not permitted|automation|apple events|system events/i.test(message)) {
    return {
      State: 'permission_denied',
      Message:
        'macOS denied access to System Events. Allow automation permission for ShowTrak Client in System Settings > Privacy & Security > Automation.',
    };
  }
  return {
    State: 'error',
    Message: message,
  };
}

async function collectWindowsApplications(): Promise<Result<string[]>> {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    'Get-Process',
    '| Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName }',
    '| Select-Object -ExpandProperty ProcessName',
  ].join(' ');
  const [error, stdout] = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
  if (error) return [error, null];
  return [
    null,
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}

async function collectMacApplications(): Promise<Result<string[]>> {
  const script = [
    'set output to {}',
    'tell application "System Events"',
    'repeat with proc in (application processes where background only is false)',
    'set end of output to name of proc',
    'end repeat',
    'end tell',
    'set text item delimiters to linefeed',
    'return output as text',
  ].join('\n');
  const [error, stdout] = await execFileAsync('osascript', ['-e', script]);
  if (error) return [error, null];
  return [
    null,
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}

async function collectLinuxApplications(): Promise<Result<string[]>> {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch (_error) {
    // Fall back to process listing without user filtering.
  }
  const args = username ? ['-u', username, '-o', 'comm='] : ['-e', '-o', 'comm='];
  const [error, stdout] = await execFileAsync('ps', args);
  if (error) return [error, null];
  return [
    null,
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}

async function collectRunningApplications(): Promise<Result<string[]>> {
  if (process.platform === 'win32') return collectWindowsApplications();
  if (process.platform === 'darwin') return collectMacApplications();
  return collectLinuxApplications();
}

async function emitSnapshot(force = false): Promise<void> {
  if (!activeSocket || !activeSocket.connected) return;
  const [error, names] = await collectRunningApplications();
  if (error) {
    Logger.warn('Failed to collect running applications');
    const status = classifyCollectionError(error);
    setStatus(status);
    activeSocket.emit('RunningApplications', {
      SampledAt: Date.now(),
      TotalCount: 0,
      Truncated: false,
      Items: [],
      Status: currentStatus,
    });
    return;
  }
  setStatus({ State: 'ok', Message: null });
  const snapshot = buildSnapshot(names);
  if (!force && snapshot.Signature === lastSignature) {
    activeSocket.emit('RunningApplications', {
      SampledAt: Date.now(),
      TotalCount: snapshot.TotalCount,
      Truncated: snapshot.Truncated,
      Items: [],
      Status: currentStatus,
      NoChanges: true,
    });
    return;
  }
  lastSignature = snapshot.Signature;
  activeSocket.emit('RunningApplications', {
    SampledAt: snapshot.SampledAt,
    TotalCount: snapshot.TotalCount,
    Truncated: snapshot.Truncated,
    Items: snapshot.Items,
    Status: currentStatus,
  });
}

export const Manager = {
  async Start(Socket: ShowTrakSocket | null): Promise<void> {
    activeSocket = Socket || null;
    clearMonitorInterval();
    lastSignature = null;
    await emitSnapshot(true);
    monitorInterval = setInterval(() => {
      emitSnapshot(false).catch(() => {
        Logger.warn('Running applications poll failed');
      });
    }, POLL_INTERVAL_MS);
  },

  async Stop(): Promise<void> {
    clearMonitorInterval();
    activeSocket = null;
    lastSignature = null;
    setStatus({ State: 'unknown', Message: null });
  },

  GetStatus(): ProcessMonitorStatus {
    return { ...currentStatus };
  },
};
