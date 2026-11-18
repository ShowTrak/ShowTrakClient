import type { Display } from 'electron';

import type { ClientDisplay, DisplayIdentitySource } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import {
  DisposeIdentityHost,
  GetDisplayIdentities,
  matchDisplaysToIdentities,
  _internal as IdentityInternal,
  type DisplayIdentity,
} from './identity';

const Logger = CreateLogger('DisplayMonitor');

const { physicalWidth, physicalHeight } = IdentityInternal;

// The Electron `screen` module is only usable in the main process after the app
// is ready. We resolve it defensively so this module can also be required by
// unit tests (which do not run inside Electron) without throwing at import time.
let screen: typeof import('electron').screen | null = null;
try {
  ({ screen } = require('electron') as typeof import('electron'));
} catch (_error) {
  screen = null;
}

/** The identity fields buildStableIdentity resolves for a display. */
interface ResolvedDisplayIdentity {
  DisplayID: string;
  HardwareID: string | null;
  IsStableIdentity: boolean;
  IdentitySource: DisplayIdentitySource;
}

// Cache of the (relatively expensive) OS identity lookup: system_profiler on
// macOS, a WMI query on Windows. Which monitors are attached only changes with a
// screen event, and every screen event invalidates the cache, so the answer is
// kept until then. It used to expire after 30 seconds — shorter than the
// minute's forced display resync, so every resync paid for a fresh lookup. The
// TTL is now only a safety net for a change no event announced.
const IDENTITY_CACHE_TTL_MS = 30 * 60 * 1000;
// An empty answer (no EDID readable, a lookup that failed) is asked again
// sooner, but still not on every resync.
const EMPTY_IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;

// Electron's screen events arrive in bursts: plugging a monitor in fires
// display-added followed by several display-metrics-changed as the OS settles
// the layout, and metrics-changed also fires for things as minor as the dock
// auto-hiding (it moves every display's workArea). Each one invalidates the
// identity cache, and the resulting lookup costs ~250ms on macOS
// (system_profiler) and more on Windows (a PowerShell WMI query) — so an
// undebounced burst is the most expensive thing this module can do. Coalescing
// a burst into one callback keeps a genuine hotplug near-instant while making a
// noisy one cheap.
const DISPLAY_EVENT_DEBOUNCE_MS = 300;

const Internal = {
  identityCache: { at: 0, value: [] as DisplayIdentity[], valid: false },

  GetDisplayIdentities,

  async ResolveIdentitiesCached(): Promise<DisplayIdentity[]> {
    const now = Date.now();
    const cache = Internal.identityCache;
    const ttl = cache.value.length ? IDENTITY_CACHE_TTL_MS : EMPTY_IDENTITY_CACHE_TTL_MS;
    if (cache.valid && now - cache.at < ttl) {
      return cache.value;
    }
    let identities: DisplayIdentity[];
    try {
      identities = await Internal.GetDisplayIdentities();
    } catch (error) {
      Logger.error('Error resolving display identities:', error);
      identities = [];
    }
    Internal.identityCache = {
      at: now,
      value: Array.isArray(identities) ? identities : [],
      valid: true,
    };
    return Internal.identityCache.value;
  },

  InvalidateIdentityCache(): void {
    Internal.identityCache = { at: 0, value: [], valid: false };
  },

  FormatDisplay(Display: Display, PrimaryID: number | null, Index = 0): ClientDisplay {
    const Size = Display?.size ?? ({} as Display['size']);
    const Bounds = Display?.bounds ?? ({} as Display['bounds']);
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
  },

  // Merge OS hardware identities into the Electron display list, assigning each
  // display the most durable id we can determine (see buildStableIdentity).
  ApplyStableIdentities(Displays: ClientDisplay[], Identities: DisplayIdentity[]): ClientDisplay[] {
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
  },
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
function buildStableIdentity(
  Display: ClientDisplay,
  Identity: DisplayIdentity | null
): ResolvedDisplayIdentity {
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

export const Manager = {
  async GetDisplays(): Promise<Result<ClientDisplay[]>> {
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
      Logger.debug(
        `Found ${Displays.length} display${
          Displays.length === 1 ? '' : 's'
        } (${StableCount} with stable hardware id)`
      );
      return [null, Displays];
    } catch (error) {
      Logger.error('Error getting displays:', error);
      return [error, null];
    }
  },

  OnDisplayChange(callback: () => void): void {
    if (!screen || typeof screen.on !== 'function') return;
    let debounceTimer: NodeJS.Timeout | null = null;
    const handler = (...args: unknown[]) => {
      // display-metrics-changed names what moved. A work-area change alone (the
      // dock or taskbar showing, hiding or moving) changes nothing this module
      // reports or identifies, and is by far the most frequent screen event.
      if (IsWorkAreaOnly(args[2])) return;
      // Topology changed — force a fresh hardware-identity lookup next poll.
      Internal.InvalidateIdentityCache();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        try {
          callback();
        } catch (error) {
          Logger.error('Display change handler error:', error);
        }
      }, DISPLAY_EVENT_DEBOUNCE_MS);
      // Never hold the process open waiting to report a display change.
      if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
    };
    screen.on('display-added', handler);
    screen.on('display-removed', handler);
    screen.on('display-metrics-changed', handler);
  },

  /**
   * Called when the connection drops. The Windows lookup runs in the shared WMI
   * PowerShell host, which stops itself after a few idle minutes, so there is
   * nothing resident to release here any more.
   */
  Dispose(): void {
    DisposeIdentityHost();
  },
};

/** Whether a display-metrics-changed `changedMetrics` list names the work area alone. */
export function IsWorkAreaOnly(ChangedMetrics: unknown): boolean {
  return (
    Array.isArray(ChangedMetrics) &&
    ChangedMetrics.length > 0 &&
    ChangedMetrics.every((Metric) => Metric === 'workArea')
  );
}

export const _internal = Internal;
export const _constants = {
  DISPLAY_EVENT_DEBOUNCE_MS,
  IDENTITY_CACHE_TTL_MS,
  EMPTY_IDENTITY_CACHE_TTL_MS,
};
