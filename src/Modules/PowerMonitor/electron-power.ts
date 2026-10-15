// Electron's powerMonitor, resolved defensively.
//
// The power and temperature monitors both listen to it, and both are loaded by
// unit tests that do not run inside Electron (where `require('electron')` is the
// path to the Electron binary, not the API). The module object is captured at
// import time — so a test's mocked 'electron' is the one used — but its
// `powerMonitor` property is only read when a monitor starts: Electron refuses
// powerMonitor before the app is ready, and nothing starts before then.

/** The slice of Electron's powerMonitor the monitors use. */
export interface PowerMonitorLike {
  on(Event: string, Listener: (...Args: unknown[]) => void): unknown;
  removeListener(Event: string, Listener: (...Args: unknown[]) => void): unknown;
  isOnBatteryPower?(): boolean;
  /** macOS only. */
  getCurrentThermalState?(): string;
}

let ElectronModule: unknown = null;
try {
  ElectronModule = require('electron');
} catch (_error) {
  ElectronModule = null;
}

/** Electron's powerMonitor, or null outside Electron (or before it is usable). */
export function GetPowerMonitor(): PowerMonitorLike | null {
  if (!ElectronModule || typeof ElectronModule !== 'object') return null;
  try {
    const Candidate = (ElectronModule as { powerMonitor?: unknown }).powerMonitor;
    if (
      Candidate &&
      typeof (Candidate as PowerMonitorLike).on === 'function' &&
      typeof (Candidate as PowerMonitorLike).removeListener === 'function'
    ) {
      return Candidate as PowerMonitorLike;
    }
  } catch (_error) {
    // Read before the app was ready; treated as unavailable.
  }
  return null;
}

/**
 * A set of powerMonitor listeners that can be attached once and detached once.
 *
 * The monitors keep their listeners across a disconnect (a machine going to
 * sleep is usually what CAUSES the disconnect, and that suspend must still be
 * timestamped) and drop them only on a full teardown. Attaching is idempotent,
 * so a reconnect or a service restart can never stack a second copy.
 */
export function CreateListenerSet(Listeners: Record<string, (...Args: unknown[]) => void>) {
  let Attached: PowerMonitorLike | null = null;
  return {
    /** Attach to the current powerMonitor; a no-op when already attached or unavailable. */
    Attach(): boolean {
      if (Attached) return true;
      const Monitor = GetPowerMonitor();
      if (!Monitor) return false;
      for (const [Event, Listener] of Object.entries(Listeners)) Monitor.on(Event, Listener);
      Attached = Monitor;
      return true;
    },
    Detach(): void {
      const Monitor = Attached;
      Attached = null;
      if (!Monitor) return;
      for (const [Event, Listener] of Object.entries(Listeners)) {
        try {
          Monitor.removeListener(Event, Listener);
        } catch (_error) {
          // Already gone with the app; nothing to undo.
        }
      }
    },
    IsAttached(): boolean {
      return Attached !== null;
    },
  };
}
