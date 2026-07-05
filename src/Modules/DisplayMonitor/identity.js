// Reboot-stable display identity resolution.
//
// Electron's `display.id` is a runtime handle that is NOT stable across
// reboots. To give each physical monitor a durable identity we read the panel's
// EDID (or the OS's already-parsed EDID data) per platform and derive a
// fingerprint from manufacturer + product code + serial number.
//
// Everything here is BEST-EFFORT and FAIL-SOFT: any resolver may return an
// empty list (permissions, missing tools, unusual hardware) and the caller
// falls back to a session-scoped id. Resolvers are also injectable so the
// matching logic can be unit-tested without touching the real OS.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { parseEdid, fingerprintFromEdid } = require('./edid');

function runCommand(command, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
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
// Linux: /sys/class/drm/<card>-<connector>/edid + connector name + native mode
// ---------------------------------------------------------------------------
async function getLinuxIdentities() {
  const base = '/sys/class/drm';
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (_error) {
    return [];
  }

  const identities = [];
  for (const entry of entries) {
    if (!entry.includes('-')) continue; // skip cardN (no connector)
    const dir = path.join(base, entry);

    let status = '';
    try {
      status = fs.readFileSync(path.join(dir, 'status'), 'utf8').trim();
    } catch (_error) {
      status = '';
    }
    if (status && status !== 'connected') continue;

    let edidBuffer = null;
    try {
      edidBuffer = fs.readFileSync(path.join(dir, 'edid'));
    } catch (_error) {
      edidBuffer = null;
    }
    if (!edidBuffer || edidBuffer.length === 0) continue;

    const parsed = parseEdid(edidBuffer);
    // Connector (e.g. "DP-1", "HDMI-A-1", "eDP-1") is itself reasonably stable
    // per physical port, so we keep it as a secondary fallback key.
    const connector = entry.replace(/^card\d+-/, '');

    let width = null;
    let height = null;
    try {
      const modes = fs.readFileSync(path.join(dir, 'modes'), 'utf8').trim().split('\n');
      const match = modes[0] && modes[0].match(/(\d+)x(\d+)/);
      if (match) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }
    } catch (_error) {
      /* native mode is optional */
    }

    identities.push({
      Fingerprint: fingerprintFromEdid(parsed),
      Manufacturer: parsed && parsed.manufacturer ? parsed.manufacturer : null,
      Product: parsed && parsed.productCode != null ? parsed.productCode : null,
      Name: parsed && parsed.name ? parsed.name : null,
      Serial:
        parsed && (parsed.serialString || parsed.serial)
          ? String(parsed.serialString || parsed.serial)
          : null,
      ConnectorKey: `linux:${connector}`,
      Width: width,
      Height: height,
      Primary: false,
    });
  }
  return identities;
}

// ---------------------------------------------------------------------------
// macOS: system_profiler SPDisplaysDataType -json (vendor/product/serial)
// ---------------------------------------------------------------------------
function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

async function getMacIdentities() {
  const stdout = await runCommand('system_profiler', ['SPDisplaysDataType', '-json']);
  if (!stdout) return [];

  let json;
  try {
    json = JSON.parse(stdout);
  } catch (_error) {
    return [];
  }

  const gpus = Array.isArray(json.SPDisplaysDataType) ? json.SPDisplaysDataType : [];
  const identities = [];
  for (const gpu of gpus) {
    const displays = Array.isArray(gpu.spdisplays_ndrvs) ? gpu.spdisplays_ndrvs : [];
    for (const display of displays) {
      const name = pick(display, ['_name']);
      const serial = pick(display, [
        '_spdisplays_display-serial-number',
        'spdisplays_display-serial-number',
        '_spdisplays_displayserialnumber',
      ]);
      const vendor = pick(display, [
        '_spdisplays_display-vendor-id',
        'spdisplays_display-vendor-id',
      ]);
      const product = pick(display, [
        '_spdisplays_display-product-id',
        'spdisplays_display-product-id',
      ]);

      // Prefer native pixels for matching against Electron's physical size.
      const resString = pick(display, [
        '_spdisplays_pixels',
        '_spdisplays_resolution',
        'spdisplays_resolution',
      ]);
      let width = null;
      let height = null;
      const match = resString && String(resString).match(/(\d+)\s*x\s*(\d+)/);
      if (match) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }

      const isPrimary = pick(display, ['spdisplays_main']) === 'spdisplays_yes';

      let fingerprint = null;
      if (serial || (vendor && product)) {
        fingerprint = `mac:${vendor || ''}:${product || ''}:${serial || ''}`;
      }

      identities.push({
        Fingerprint: fingerprint,
        Manufacturer: vendor ? String(vendor) : null,
        Product: product != null ? product : null,
        Name: name,
        Serial: serial ? String(serial) : null,
        ConnectorKey: null,
        Width: width,
        Height: height,
        Primary: isPrimary,
      });
    }
  }
  return identities;
}

// ---------------------------------------------------------------------------
// Windows: PowerShell WmiMonitorID (manufacturer + product + serial + name)
// ---------------------------------------------------------------------------
const WINDOWS_PS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$ids = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID;',
  '$out = foreach ($m in $ids) {',
  '  $decode = { param($a) if ($a) { ($a | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join "" } else { "" } };',
  '  [pscustomobject]@{',
  '    Manufacturer = (& $decode $m.ManufacturerName);',
  '    Name         = (& $decode $m.UserFriendlyName);',
  '    Serial       = (& $decode $m.SerialNumberID);',
  '    Product      = (& $decode $m.ProductCodeID);',
  '    Instance     = $m.InstanceName;',
  '  }',
  '};',
  '$out | ConvertTo-Json -Compress',
].join(' ');

async function getWindowsIdentities() {
  const stdout = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_SCRIPT],
    { timeout: 10000 }
  );
  if (!stdout || !stdout.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_error) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const identities = [];
  for (const row of rows) {
    if (!row) continue;
    const manufacturer = row.Manufacturer ? String(row.Manufacturer).trim() : '';
    const product = row.Product ? String(row.Product).trim() : '';
    const serial = row.Serial ? String(row.Serial).trim() : '';
    let fingerprint = null;
    if (manufacturer || product) {
      fingerprint = `edid:${manufacturer}:${product}:${serial}`;
    }
    identities.push({
      Fingerprint: fingerprint,
      Manufacturer: manufacturer || null,
      Product: product || null,
      Name: row.Name ? String(row.Name).trim() : null,
      Serial: serial || null,
      // The instance path is stable per adapter output while cabling is fixed.
      ConnectorKey: row.Instance ? `win:${String(row.Instance)}` : null,
      Width: null,
      Height: null,
      Primary: false,
    });
  }
  return identities;
}

// Dispatch to the correct platform resolver. Fail-soft: never throws.
async function GetDisplayIdentities() {
  try {
    switch (os.platform()) {
      case 'linux':
        return await getLinuxIdentities();
      case 'darwin':
        return await getMacIdentities();
      case 'win32':
        return await getWindowsIdentities();
      default:
        return [];
    }
  } catch (_error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure matcher: associate each Electron display with an OS identity.
// ---------------------------------------------------------------------------
//
// Electron gives us the live list (resolution, refresh, primary, order) but no
// hardware identity. The OS resolvers give hardware identity but imperfect
// positional data. We correlate them with a layered strategy:
//   1. Primary flag (when a resolver reports it, e.g. macOS).
//   2. Unique physical-resolution match.
//   3. Positional order for whatever remains.
// Ambiguous cases (identical monitors) may mis-assign; callers should treat the
// result as best-effort and rely on IsStableIdentity to know the confidence.
function physicalWidth(display) {
  const width = parseInt(display && display.Width, 10) || 0;
  const scale = display && display.ScaleFactor ? Number(display.ScaleFactor) : 1;
  return Math.round(width * (Number.isFinite(scale) && scale > 0 ? scale : 1));
}
function physicalHeight(display) {
  const height = parseInt(display && display.Height, 10) || 0;
  const scale = display && display.ScaleFactor ? Number(display.ScaleFactor) : 1;
  return Math.round(height * (Number.isFinite(scale) && scale > 0 ? scale : 1));
}

function matchDisplaysToIdentities(displays, identities) {
  const result = new Map();
  const pool = (Array.isArray(identities) ? identities : []).slice();
  const remaining = (Array.isArray(displays) ? displays : []).slice();

  const take = (predicate) => {
    const index = pool.findIndex(predicate);
    if (index === -1) return null;
    return pool.splice(index, 1)[0];
  };

  // Pass 1: primary flag.
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const display = remaining[i];
    if (!display || !display.Primary) continue;
    const identity = take((entry) => entry && entry.Primary);
    if (identity) {
      result.set(display.SessionID, identity);
      remaining.splice(i, 1);
    }
  }

  // Pass 2: unique physical-resolution match.
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const display = remaining[i];
    const pw = physicalWidth(display);
    const ph = physicalHeight(display);
    if (!pw || !ph) continue;
    const candidates = pool.filter((entry) => entry && entry.Width === pw && entry.Height === ph);
    if (candidates.length === 1) {
      const identity = take((entry) => entry === candidates[0]);
      if (identity) {
        result.set(display.SessionID, identity);
        remaining.splice(i, 1);
      }
    }
  }

  // Pass 3: positional order for anything still unmatched.
  for (const display of remaining) {
    if (pool.length === 0) break;
    const identity = pool.shift();
    result.set(display.SessionID, identity);
  }

  return result;
}

module.exports = {
  GetDisplayIdentities,
  matchDisplaysToIdentities,
  // Exposed for tests.
  _internal: {
    getLinuxIdentities,
    getMacIdentities,
    getWindowsIdentities,
    physicalWidth,
    physicalHeight,
  },
};
