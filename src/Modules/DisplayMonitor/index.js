const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('DisplayMonitor');

const {
  GetDisplayIdentities,
  matchDisplaysToIdentities,
  _internal: IdentityInternal,
} = require('./identity');
const { physicalWidth, physicalHeight } = IdentityInternal;

// The Electron `screen` module is only usable in the main process after the app
// is ready. We resolve it defensively so this module can also be required by
// unit tests (which do not run inside Electron) without throwing at import time.
let screen = null;
try {
  ({ screen } = require('electron'));
} catch (_error) {
  screen = null;
}

const Manager = {};

const Internal = {};

// Short-lived cache of the (relatively expensive) OS identity lookup. It is
// invalidated whenever the display topology changes so a freshly plugged-in
// monitor is identified promptly.
const IDENTITY_CACHE_TTL_MS = 30000;
Internal.identityCache = { at: 0, value: [] };
Internal.GetDisplayIdentities = GetDisplayIdentities;

Internal.ResolveIdentitiesCached = async () => {
  const now = Date.now();
  if (
    Internal.identityCache.value.length &&
    now - Internal.identityCache.at < IDENTITY_CACHE_TTL_MS
  ) {
    return Internal.identityCache.value;
  }
  let identities = [];
  try {
    identities = await Internal.GetDisplayIdentities();
  } catch (error) {
    Logger.error('Error resolving display identities:', error);
    identities = [];
  }
  Internal.identityCache = { at: now, value: Array.isArray(identities) ? identities : [] };
  return Internal.identityCache.value;
};

Internal.InvalidateIdentityCache = () => {
  Internal.identityCache = { at: 0, value: [] };
};

Internal.FormatDisplay = (Display, PrimaryID, Index = 0) => {
  const Size = (Display && Display.size) || {};
  const Bounds = (Display && Display.bounds) || {};
  return {
    // Runtime handle from Electron. NOT stable across reboots — kept only for
    // matching against the OS identity list and as a last-resort fallback id.
    SessionID: String(Display.id),
    // 1-based position in Electron's display enumeration. This is the same
    // number the Identify overlay paints on each screen, so operators can
    // correlate a physical monitor with the list shown on the server.
    ScreenNumber: Number(Index) + 1,
    // Populated later by ApplyStableIdentities(); defaults to the session id so
    // the feature still works when hardware identity is unavailable.
    DisplayID: `session:${Display.id}`,
    HardwareID: null,
    IsStableIdentity: false,
    IdentitySource: 'session',
    Label: Display && Display.label ? String(Display.label) : null,
    Width: Size.width || Bounds.width || 0,
    Height: Size.height || Bounds.height || 0,
    ScaleFactor: typeof Display.scaleFactor === 'number' ? Display.scaleFactor : 1,
    RefreshRate: typeof Display.displayFrequency === 'number' ? Display.displayFrequency : null,
    Rotation: typeof Display.rotation === 'number' ? Display.rotation : 0,
    Internal: !!(Display && Display.internal),
    Primary: PrimaryID != null && String(Display.id) === String(PrimaryID),
    Bounds: {
      x: Bounds.x || 0,
      y: Bounds.y || 0,
      width: Bounds.width || 0,
      height: Bounds.height || 0,
    },
  };
};

// Resolve the most durable id we can for a single display, given its (possibly
// null) matched OS identity. Every tier here is stable across reboots — we no
// longer fall back to a volatile session handle except in the degenerate case
// where Electron reports no usable data at all.
//
// Tier 1 — EDID hardware fingerprint (manufacturer+product+serial). Independent
//          of resolution, so a res/refresh change is reported as a mismatch.
// Tier 2 — Physical port/connector (e.g. DisplayPort output, Windows instance
//          path). Also independent of resolution -> mismatch on change.
// Tier 3 — Composite of the values we know stay stable across reboot: vendor +
//          product (when known) + resolution + refresh rate. Because the config
//          is baked into the id, changing resolution/refresh or unplugging the
//          panel makes the critical display appear missing (which flags it).
function buildStableIdentity(Display, Identity) {
  if (Identity && Identity.Fingerprint) {
    return {
      DisplayID: Identity.Fingerprint,
      HardwareID: Identity.Fingerprint,
      IsStableIdentity: true,
      IdentitySource: 'edid',
    };
  }

  if (Identity && Identity.ConnectorKey) {
    return {
      DisplayID: `port:${Identity.ConnectorKey}`,
      HardwareID: null,
      IsStableIdentity: true,
      IdentitySource: 'port',
    };
  }

  const Width = physicalWidth(Display);
  const Height = physicalHeight(Display);
  if (Width && Height) {
    const Refresh =
      Display.RefreshRate != null && Number.isFinite(Number(Display.RefreshRate))
        ? Math.round(Number(Display.RefreshRate))
        : 0;
    const Manufacturer = Identity && Identity.Manufacturer ? String(Identity.Manufacturer) : '';
    const Product = Identity && Identity.Product != null ? String(Identity.Product) : '';
    const Panel = Display.Internal ? 'i' : 'e';
    return {
      DisplayID: `attr:${Manufacturer}:${Product}:${Width}x${Height}@${Refresh}:${Panel}`,
      HardwareID: null,
      IsStableIdentity: true,
      IdentitySource: 'attributes',
    };
  }

  return {
    DisplayID: `session:${Display.SessionID}`,
    HardwareID: null,
    IsStableIdentity: false,
    IdentitySource: 'session',
  };
}

// Merge OS hardware identities into the Electron display list, assigning each
// display the most durable id we can determine (see buildStableIdentity).
Internal.ApplyStableIdentities = (Displays, Identities) => {
  const Matches = matchDisplaysToIdentities(Displays, Identities);
  for (const Display of Displays) {
    const Identity = Matches.get(Display.SessionID) || null;
    const Resolved = buildStableIdentity(Display, Identity);
    Display.DisplayID = Resolved.DisplayID;
    Display.HardwareID = Resolved.HardwareID;
    Display.IsStableIdentity = Resolved.IsStableIdentity;
    Display.IdentitySource = Resolved.IdentitySource;
    if (Identity && Identity.Name && !Display.Label) {
      Display.Label = Identity.Name;
    }
  }
  return Displays;
};

Manager.GetDisplays = async () => {
  try {
    if (!screen || typeof screen.getAllDisplays !== 'function') {
      return [null, []];
    }
    const PrimaryID =
      typeof screen.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay().id : null;
    const Displays = screen
      .getAllDisplays()
      .map((Display, Index) => Internal.FormatDisplay(Display, PrimaryID, Index));

    const Identities = await Internal.ResolveIdentitiesCached();
    Internal.ApplyStableIdentities(Displays, Identities);

    const StableCount = Displays.filter((d) => d.IsStableIdentity).length;
    Logger.log(
      `Found ${Displays.length} display${
        Displays.length === 1 ? '' : 's'
      } (${StableCount} with stable hardware id)`
    );
    return [null, Displays];
  } catch (error) {
    Logger.error('Error getting displays:', error);
    return [error, null];
  }
};

Manager.OnDisplayChange = (callback) => {
  if (!screen || typeof screen.on !== 'function') return;
  const handler = () => {
    // Topology changed — force a fresh hardware-identity lookup next poll.
    Internal.InvalidateIdentityCache();
    try {
      callback();
    } catch (error) {
      Logger.error('Display change handler error:', error);
    }
  };
  screen.on('display-added', handler);
  screen.on('display-removed', handler);
  screen.on('display-metrics-changed', handler);
};

module.exports = {
  Manager,
  _internal: Internal,
};
