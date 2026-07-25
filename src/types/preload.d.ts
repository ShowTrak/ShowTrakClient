// Typed contracts for the client's Electron preload bridges.
//
// These describe the ONLY surfaces the renderer windows can reach. Each preload
// implements the matching interface, and the renderer augments `Window` with it,
// so a channel added on one side and not the other fails to compile.
//
// This is the client's own bridge — distinct from `preload.d.ts` in
// @showtrak/protocol, which describes the SERVER's much larger `window.API`.

import type { ClientProfile, ManualServer, ProcessMonitorStatus } from './client';

/**
 * Status of the app self-update flow, surfaced in the config window.
 *
 * Lower-case field names, unlike most of the client's payloads: these come
 * straight from electron-updater / Squirrel events and are passed through
 * largely as-is. The renderer reads `state`, `info.version`, `info.tag` and
 * `percent`.
 */
export type AppUpdateState =
  | 'checking'
  | 'available'
  | 'none'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'error';

export interface AppUpdateStatus {
  state: AppUpdateState;
  /** Passed through from electron-updater's UpdateInfo, or a Squirrel stand-in. */
  info?: { version?: string; tag?: string };
  /** Download progress 0-100, present during 'downloading'. */
  percent?: number;
  error?: string;
}

/** Progress of reconnecting to (or rediscovering) the server. */
export interface ServerRecoveryStatus {
  State: string;
  Message?: string;
  Metrics?: Record<string, unknown>;
}

/** Unsubscribe function returned by every `On*` subscription. */
export type Unsubscribe = () => void;

/**
 * IPC handlers answer with a Go-style `[error, value]` tuple so a rejected
 * validation never throws across the bridge.
 */
export type IpcResult<T = undefined> = [error: string | null, value?: T];

/** Everything the config window needs to paint its first frame. */
export interface LoadedSnapshot {
  Profile: ClientProfile;
  ProcessMonitorStatus: ProcessMonitorStatus;
  ServerRecoveryStatus: ServerRecoveryStatus;
  AppUpdateStatus: AppUpdateStatus | null;
}

/** `window.API` in the main config window (src/preload.ts). */
export interface ClientPreloadAPI {
  Loaded(): Promise<IpcResult<LoadedSnapshot>>;
  GetVersion(): Promise<string>;
  Shutdown(): Promise<unknown>;
  Minimise(): Promise<unknown>;
  ResetClientFactoryDefaults(): Promise<unknown>;
  SetManualServer(Host: string, Port: number): Promise<IpcResult<ManualServer>>;
  ClearManualServer(): Promise<unknown>;
  CheckForAppUpdates(): Promise<unknown>;
  InstallAppUpdate(): Promise<unknown>;
  OnAppUpdateStatus(callback: (status: AppUpdateStatus) => void): Unsubscribe;
  OnProcessMonitorStatus(callback: (status: ProcessMonitorStatus) => void): Unsubscribe;
  OnServerRecoveryStatus(callback: (status: ServerRecoveryStatus) => void): Unsubscribe;
  SetProfile(callback: (profile: ClientProfile) => void): Unsubscribe;
}

/** `window.IdentifyAPI` in the identify overlay windows. */
export interface IdentifyPreloadAPI {
  Close(): Promise<unknown>;
}

/** `window.LaunchCountdownAPI` in the launch countdown window. */
export interface LaunchCountdownPreloadAPI {
  Cancel(): Promise<unknown>;
}
