const { execFile } = require('child_process');
const os = require('os');

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ProcessMonitor');
const { Manager: BroadcastManager } = require('../Broadcast');

const POLL_INTERVAL_MS = 30000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_REPORTED_APPLICATIONS = 64;

let monitorInterval = null;
let activeSocket = null;
let lastSignature = null;
let lastStatusSignature = null;
let currentStatus = {
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

function clearMonitorInterval() {
  if (!monitorInterval) return;
  clearInterval(monitorInterval);
  monitorInterval = null;
}

function execFileAsync(command, args) {
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

function normalizeNames(names) {
  const counts = new Map();
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

function buildSnapshot(names) {
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

function normalizeStatus(status) {
  const state =
    typeof status?.State === 'string' && status.State.trim().length > 0
      ? status.State.trim().toLowerCase()
      : 'unknown';
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

function setStatus(status) {
  const next = normalizeStatus(status);
  const signature = `${next.State}|${next.Message || ''}|${next.Platform}`;
  if (lastStatusSignature === signature) return;
  lastStatusSignature = signature;
  currentStatus = next;
  BroadcastManager.emit('ProcessMonitorStatus', currentStatus);
}

function classifyCollectionError(error) {
  const message = String(
    error && error.message ? error.message : error || 'Unknown process monitor error'
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

async function collectWindowsApplications() {
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

async function collectMacApplications() {
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

async function collectLinuxApplications() {
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

async function collectRunningApplications() {
  if (process.platform === 'win32') return collectWindowsApplications();
  if (process.platform === 'darwin') return collectMacApplications();
  return collectLinuxApplications();
}

async function emitSnapshot(force = false) {
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

const Manager = {
  Start: async (Socket) => {
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
  Stop: async () => {
    clearMonitorInterval();
    activeSocket = null;
    lastSignature = null;
    setStatus({ State: 'unknown', Message: null });
  },
  GetStatus: () => ({ ...currentStatus }),
};

module.exports = {
  Manager,
};
