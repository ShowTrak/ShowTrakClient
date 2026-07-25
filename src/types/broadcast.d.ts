// Typed event map for the in-process Broadcast bus (src/Modules/Broadcast).
//
// This is the client's internal main-process event bus — module-to-module
// signalling, NOT the Socket.IO wire (see @showtrak/protocol for that). It was
// previously a bare EventEmitter, so a mistyped channel name failed silently;
// every channel now has to appear here to compile.

import type { LaunchConfigPayload } from '@showtrak/protocol';
import type {
  ClientProfile,
  ClientScript,
  LanUpdateRequest,
  IdentifyOverlayPayload,
  MainClientConnectionStatus,
  ProcessMonitorStatus,
  ServerAdoptionRejectedInfo,
  ServerConnectFailedInfo,
} from './client';

/** Node-style completion callback used by the update channels. */
export type BroadcastErrorCallback = (error: string | null) => void | Promise<void>;

/** Progress reporter for the LAN software update. */
export type BroadcastProgressCallback = (progress: number, statusText: string) => void;

export interface ClientBroadcastEvents {
  /** The profile changed on disk; re-render anything showing it. */
  ProfileUpdated: (profile: ClientProfile) => void;

  /** Socket lifecycle transitions from MainClient. */
  MainClientConnectionStatus: (info: MainClientConnectionStatus) => void;
  /** The configured server is unreachable; main drives recovery/rediscovery. */
  ServerConnectFailed: (info: ServerConnectFailedInfo) => void;
  /** The server refused this client's adoption. */
  ServerAdoptionRejected: (info: ServerAdoptionRejectedInfo) => void;
  /** Adoption succeeded; tear down the adoption lane and start the main client. */
  ReinitializeService: () => void;

  /** Identify overlay control. */
  ShowIdentifyOverlay: (payload: IdentifyOverlayPayload) => void;
  HideIdentifyOverlay: () => void;
  /** The operator dismissed the overlay locally; tell the server. */
  IdentifyStoppedByUser: () => void;

  /**
   * The on-disk script catalog changed; refresh the tray submenu. The new
   * catalog is passed along, though the only current listener ignores it and
   * re-reads via ScriptManager.
   */
  ScriptsUpdated: (scripts: ClientScript[]) => void;
  /** Run-on-launch handoff: main shows the countdown and executes. */
  RunLaunchAction: (config: LaunchConfigPayload) => void;

  /** Running-applications monitor health. */
  ProcessMonitorStatus: (status: ProcessMonitorStatus) => void;

  /** Server-triggered app update via the public feed. */
  UpdateSoftware: (callback: BroadcastErrorCallback) => void;
  /** Server-triggered app update served from the server's own LAN feed. */
  UpdateSoftwareFromLAN: (
    request: LanUpdateRequest,
    progress: BroadcastProgressCallback,
    callback: BroadcastErrorCallback
  ) => void;
}

/**
 * EventEmitter narrowed to `ClientBroadcastEvents`. Only the surface the client
 * actually uses is exposed; add methods here as they are needed rather than
 * widening back to the untyped emitter.
 */
export interface TypedBroadcastEmitter {
  emit<E extends keyof ClientBroadcastEvents>(
    event: E,
    ...args: Parameters<ClientBroadcastEvents[E]>
  ): boolean;
  on<E extends keyof ClientBroadcastEvents>(event: E, listener: ClientBroadcastEvents[E]): this;
  once<E extends keyof ClientBroadcastEvents>(event: E, listener: ClientBroadcastEvents[E]): this;
  off<E extends keyof ClientBroadcastEvents>(event: E, listener: ClientBroadcastEvents[E]): this;
  removeListener<E extends keyof ClientBroadcastEvents>(
    event: E,
    listener: ClientBroadcastEvents[E]
  ): this;
  removeAllListeners(event?: keyof ClientBroadcastEvents): this;
  listenerCount(event: keyof ClientBroadcastEvents): number;
  setMaxListeners(n: number): this;
}
