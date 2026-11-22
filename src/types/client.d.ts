// Client-internal shapes: the module-to-module wiring inside the main process.
//
// Anything that crosses a process or network boundary is NOT here. The Socket.IO
// wire to the server (including the script catalog, ScriptCatalogWireEntry) is
// in @showtrak/protocol; the preload bridges, IPC results, the persisted profile
// and the other state files are in @showtrak/protocol/client.

import type { ScriptCatalogWireEntry } from '@showtrak/protocol';
import type { ClientProfile } from '@showtrak/protocol/client';

/**
 * Go-style `[error, value]` tuple returned by the client's async managers.
 * The error slot is `null` on success; the value slot is `null` on failure.
 *
 * Looser than the shared `Result` on purpose: these managers hand back whatever
 * they caught (an Error, a string), and the caller decides how to report it.
 */
export type Result<T> = [error: unknown, value: T | null];

/**
 * A resolved hardware identity. Discriminated on `Source` so the MAC branch can
 * rely on `Witness` being present — only the random fallback has no evidence.
 *
 * `Witness` is the evidence the UUID was derived from (a lower-cased firmware
 * id, or physical MACs joined by `|`), re-checked against live hardware on
 * every boot to detect a cloned disk image. Persisted as the profile's
 * ProfileIdentity.
 */
export type ResolvedIdentity =
  | { UUID: string; Source: 'firmware'; Witness: string }
  | { UUID: string; Source: 'mac'; Witness: string }
  | { UUID: string; Source: 'random'; Witness: null };

/**
 * A profile as returned by `ProfileManager.GetProfile()`.
 *
 * `UUID` is optional on `ClientProfile` because raw Profile.json may be missing
 * or truncated, but GetProfile self-heals that case (ForceResetProfile then
 * re-reads), so every caller is guaranteed an identity.
 */
export interface ResolvedClientProfile extends ClientProfile {
  UUID: string;
}

/** Connection state broadcast by MainClient as the socket comes and goes. */
export interface MainClientConnectionStatus {
  State: 'connected' | 'disconnected' | 'connect_error';
  IP: string | null;
  Port: number | null;
  Error?: string;
  ConsecutiveErrors?: number;
}

/** Emitted when the socket cannot reach the configured server. */
export interface ServerConnectFailedInfo {
  IP: string | null;
  Port: number | null;
  Error: string;
  ConsecutiveErrors: number;
}

/** Emitted when the server actively refuses this client's adoption. */
export interface ServerAdoptionRejectedInfo {
  IP: string | null;
  Port: number | null;
  Reason: string | null;
  ServerIdentity: string | null;
}

/** Whether a script can actually be launched on this machine right now. */
export interface ScriptLaunchState {
  Enabled: boolean;
  DisabledReason: string;
  RelativePath?: string;
  /** Absolute path to the resolved platform script file. */
  ScriptPath?: string;
}

/** A script plus its runnability, as rendered in the tray submenu. */
export interface TrayScriptEntry {
  Script: ScriptCatalogWireEntry;
  Enabled: boolean;
  DisabledReason: string;
}

/**
 * Internal LAN-update request handed from MainClient to the main process.
 *
 * NOTE this is NOT the wire payload: the server sends `UpdateSoftwareFromLANPayload`
 * with a relative `FeedPath`, and MainClient resolves it against the connected
 * server's origin into an absolute `FeedURL` before broadcasting.
 */
export interface LanUpdateRequest {
  FeedURL: string;
  ReleaseVersion: string | null;
}

/**
 * Payload driving the on-screen Identify overlay, from MainClient to the
 * IdentifyOverlay module. The overlay window itself receives the normalised
 * IdentifyOverlayDetails in its query string.
 */
export interface IdentifyOverlayPayload {
  Hostname?: string | null;
  Nickname?: string | null;
  IPs?: string[];
}
