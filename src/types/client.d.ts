// Client-internal shapes. These are NOT wire types — anything exchanged with
// the server over Socket.IO belongs in the @showtrak/protocol submodule instead.

/**
 * Go-style `[error, value]` tuple returned by the client's async managers.
 * The error slot is `null` on success; the value slot is `null` on failure.
 */
export type Result<T> = [error: unknown, value: T | null];

/** Source tier a hardware identity was resolved from, best first. */
export type IdentitySource = 'firmware' | 'mac' | 'random';

/**
 * A resolved hardware identity. Discriminated on `Source` so the MAC branch can
 * rely on `Witness` being present — only the random fallback has no evidence.
 *
 * `Witness` is the evidence the UUID was derived from (a lower-cased firmware
 * id, or physical MACs joined by `|`), re-checked against live hardware on
 * every boot to detect a cloned disk image.
 */
export type ResolvedIdentity =
  | { UUID: string; Source: 'firmware'; Witness: string }
  | { UUID: string; Source: 'mac'; Witness: string }
  | { UUID: string; Source: 'random'; Witness: null };

/** Identity block persisted inside Profile.json. */
export interface ProfileIdentity {
  Version: number;
  Source: IdentitySource;
  Witness: string | null;
  ResolvedAt: number;
}

/** Server endpoint the client is adopted to. */
export interface ProfileServer {
  IP?: string | null;
  Port?: number | null;
  ServerIdentity?: string | null;
  AdoptionTime?: number;
  /** Set when recovery re-pointed the client at a rediscovered server. */
  LastRecoveredAt?: number;
}

/**
 * Operator-defined server endpoint, stored separately from Profile.json in
 * ManualServer.json so a factory reset of the profile does not lose it.
 * `Host` may be an IPv4/IPv6 literal or a DNS name.
 */
export interface ManualServer {
  Host: string;
  Port: number;
}

/** Contents of Profile.json, plus the manual endpoint attached on read. */
export interface ClientProfile {
  UUID?: string;
  Adopted?: boolean;
  Server?: ProfileServer | null;
  Identity?: ProfileIdentity;
  ManualServer?: ManualServer;
  /**
   * Survives an unadopt so the client only re-adopts to the same server it was
   * previously locked to.
   */
  ServerIdentityLock?: string;
  [key: string]: unknown;
}

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

/**
 * Health of the running-applications monitor, as broadcast to the renderer.
 * Mirrors the wire type `RunningApplicationsStatus` but with `Platform`
 * required, since the client always fills it in.
 */
export type ProcessMonitorState = 'unknown' | 'ok' | 'error' | 'permission_denied';

export interface ProcessMonitorStatus {
  State: ProcessMonitorState;
  Message: string | null;
  Platform: string;
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

/** How a script's console output is filtered before it is surfaced as status. */
export interface ScriptConsoleFilter {
  Mode: 'none' | 'includes' | 'startsWith' | 'regex' | string;
  Pattern: string;
  /** Remove the matched text from the surfaced line, leaving the remainder. */
  Strip?: boolean;
}

/** One file (or directory) in a deployed script's payload. */
export interface ScriptFile {
  Path: string;
  Type: 'file' | 'directory' | string;
  Checksum?: string | null;
}

/**
 * A script as deployed by the server. Field names mirror the server's catalog;
 * `Enabled`/`isEnabled` and `Platforms`/`Path` both exist because scripts
 * authored before the cross-platform schema are still supported.
 */
export interface ClientScript {
  ID: string;
  Name?: string;
  Description?: string;
  Colour?: number;
  Weight?: number;
  Confirmation?: boolean;
  Timeout?: number;
  Enabled?: boolean;
  isEnabled?: boolean;
  /** Per-OS relative script path, keyed 'Windows' | 'macOS' | 'Linux'. */
  Platforms?: Record<string, string | undefined>;
  /** Per-OS argument string, same keys as Platforms. */
  Arguments?: Record<string, string | undefined>;
  ConsoleFilter?: ScriptConsoleFilter;
  isValid?: boolean;
  ParseError?: string;
  Files?: ScriptFile[];
  /** Legacy single-path scripts, predating `Platforms`. */
  Path?: string;
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
  Script: ClientScript;
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

/** Payload driving the on-screen Identify overlay. */
export interface IdentifyOverlayPayload {
  Hostname?: string | null;
  Nickname?: string | null;
  IPs?: string[];
}
