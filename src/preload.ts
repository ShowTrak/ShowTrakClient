/**
 * Exposes a secure API to the renderer process via Electron's contextBridge.
 *
 * The two allowlists below are the security boundary: the renderer can only
 * reach channels named here. The contract is `ClientPreloadAPI` in
 * @showtrak/protocol/client: the object handed to `exposeInMainWorld` is checked
 * against it, each method is typed through the channel it uses (InvokeMap,
 * PushMap), and the renderer consumes the same interface via its `Window`
 * augmentation.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  AssertTrue,
  ChannelListCheck,
  ClientPreloadAPI,
  InvokeChannel,
  InvokeMap,
  PushChannel,
  PushMap,
  Unsubscribe,
} from '@showtrak/protocol/client';

// Inlined rather than imported: this preload is all the renderer can reach, and
// the checks below prove each list names exactly the channels the contract
// declares, so one added on either side and not the other fails to compile.
const INVOKE_CHANNEL_LIST = [
  'Loaded',
  'GetVersion',
  'Shutdown',
  'Minimise',
  'Profile:FactoryReset',
  'Profile:SetManualServer',
  'Profile:ClearManualServer',
  'AppUpdate:Check',
  'AppUpdate:Install',
  'AppUpdate:SetChannel',
] as const;

const SUBSCRIBE_CHANNEL_LIST = [
  'SetProfile',
  'AppUpdate:Status',
  'ProcessMonitorStatus',
  'ServerRecoveryStatus',
] as const;

type _InvokeChannelsMatch = AssertTrue<ChannelListCheck<InvokeChannel, typeof INVOKE_CHANNEL_LIST>>;
type _SubscribeChannelsMatch = AssertTrue<
  ChannelListCheck<PushChannel, typeof SUBSCRIBE_CHANNEL_LIST>
>;

const INVOKE_CHANNELS: ReadonlySet<string> = new Set(INVOKE_CHANNEL_LIST);
const SUBSCRIBE_CHANNELS: ReadonlySet<string> = new Set(SUBSCRIBE_CHANNEL_LIST);

function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeMap[C]['Args']
): Promise<InvokeMap[C]['Result']> {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked invoke channel: ${channel}`);
  }
  // The main process registers each handler against the same InvokeMap
  // (src/main/ipc-handlers.ts), so its answer is the channel's declared result.
  const Answer: Promise<unknown> = ipcRenderer.invoke(channel, ...args);
  return Answer as Promise<InvokeMap[C]['Result']>;
}

function subscribe<C extends PushChannel>(
  channel: C,
  callback: (...payload: PushMap[C]) => void,
  mapper: (...payload: unknown[]) => unknown[] = (...payload) => payload
): Unsubscribe {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Blocked subscribe channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback for ${channel} must be a function`);
  }

  // The main process pushes each channel's PushMap payload (PushToRenderer in
  // src/main/renderer-bus.ts); Electron hands it over untyped.
  const handler = (_event: IpcRendererEvent, ...payload: unknown[]) => {
    (callback as (...args: unknown[]) => void)(...mapper(...payload));
  };

  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const API: ClientPreloadAPI = {
  Loaded: async () => invoke('Loaded'),
  GetVersion: async () => invoke('GetVersion'),
  Shutdown: async () => invoke('Shutdown'),
  Minimise: async () => invoke('Minimise'),
  ResetClientFactoryDefaults: async () => invoke('Profile:FactoryReset'),
  SetManualServer: async (Host, Port) => invoke('Profile:SetManualServer', Host, Port),
  ClearManualServer: async () => invoke('Profile:ClearManualServer'),
  CheckForAppUpdates: async () => invoke('AppUpdate:Check'),
  SetUpdateChannel: async (Channel) => invoke('AppUpdate:SetChannel', Channel),
  InstallAppUpdate: async () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (cb) => subscribe('AppUpdate:Status', cb),
  OnProcessMonitorStatus: (cb) => subscribe('ProcessMonitorStatus', cb),
  OnServerRecoveryStatus: (cb) => subscribe('ServerRecoveryStatus', cb),
  SetProfile: (Callback) => subscribe('SetProfile', Callback),
};

contextBridge.exposeInMainWorld('API', API);
