import { io } from 'socket.io-client';

import type { ClientDisplay } from '@showtrak/protocol';
import type { ClientScript } from '../../types/client';
import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as OS } from '../OS';
import { Config } from '../Config';
import { Manager as USBMonitorManager } from '../USBMonitor';
import { Manager as DisplayMonitorManager } from '../DisplayMonitor';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as NetworkMonitor } from '../NetworkMonitor';
import { Manager as ProcessMonitor } from '../ProcessMonitor';
import { Manager as ProfileManager } from '../ProfileManager';
import { Manager as LaunchConfigManager } from '../LaunchConfig';
import { Manager as ServerCapabilities } from '../ServerCapabilities';
import { DiffByKey, ErrorMessage, IsEmptyDiff, ReadIdentityToken, Wait } from '../Utils';

const Logger = CreateLogger('MainClient');

// Cadence of the full USB / display list resyncs. See the comment at the
// setInterval calls for why these are a reconciliation channel rather than the
// primary signal.
const FULL_LIST_RESYNC_INTERVAL_MS = 60000;

let Socket: ShowTrakSocket | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let sysInfoInterval: NodeJS.Timeout | null = null;
let deviceListInterval: NodeJS.Timeout | null = null;
let displayListInterval: NodeJS.Timeout | null = null;
let usbListenersRegistered = false;
let displayListenersRegistered = false;
let lastDisplaySignature: string | null = null;
// Last display list actually reported, and so the baseline the next delta is
// computed against. Cleared on disconnect along with the signature.
let lastDisplayList: ClientDisplay[] = [];
let consecutiveConnectErrors = 0;
let connectFailureReported = false;
// Run-on-launch fires at most once per client process, on the first successful
// connection. This module-level flag survives reconnects/service restarts (the
// module instance is cached for the process lifetime), so it never re-runs.
let launchSequenceStarted = false;

// When the identify overlay is dismissed locally (esc/click), tell the server
// so it can clear identify state and stop the tile pulsing. Guarded for unit
// tests that provide a partial BroadcastManager mock.
if (BroadcastManager && typeof BroadcastManager.on === 'function') {
  BroadcastManager.on('IdentifyStoppedByUser', () => {
    if (Socket && Socket.connected) Socket.emit('IdentifyStopped');
  });
}

function clearIntervals(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (sysInfoInterval) {
    clearInterval(sysInfoInterval);
    sysInfoInterval = null;
  }
  if (deviceListInterval) {
    clearInterval(deviceListInterval);
    deviceListInterval = null;
  }
  if (displayListInterval) {
    clearInterval(displayListInterval);
    displayListInterval = null;
  }
}

function markConnected(IP: string, Port: number): void {
  consecutiveConnectErrors = 0;
  connectFailureReported = false;
  BroadcastManager.emit('MainClientConnectionStatus', {
    State: 'connected',
    IP,
    Port,
  });
}

function markConnectionError(IP: string, Port: number, Error: unknown): void {
  consecutiveConnectErrors += 1;
  const message = ErrorMessage(Error, 'Unknown connection error');
  BroadcastManager.emit('MainClientConnectionStatus', {
    State: 'connect_error',
    IP,
    Port,
    Error: message,
    ConsecutiveErrors: consecutiveConnectErrors,
  });

  if (!connectFailureReported && consecutiveConnectErrors >= 3) {
    connectFailureReported = true;
    BroadcastManager.emit('ServerConnectFailed', {
      IP,
      Port,
      Error: message,
      ConsecutiveErrors: consecutiveConnectErrors,
    });
  }
}

async function UpdateDeviceList(): Promise<void> {
  if (!Socket || !Socket.connected) {
    Logger.warn('Socket not connected, aborting UpdateDeviceList');
    return;
  }
  const [Err, DeviceList] = await USBMonitorManager.GetUSBDevices();
  if (Err) Logger.error('Error getting USB devices:', Err);
  if (Err || !DeviceList || DeviceList.length == 0) {
    Socket.emit('USBDeviceList', []);
    return;
  }
  Socket.emit('USBDeviceList', DeviceList);
}

function registerUSBListeners(): void {
  if (usbListenersRegistered) return;

  // The connect/disconnect events are the real-time signal: the server applies
  // each one to its connected list incrementally. A full list used to be sent
  // straight after every event as well, which meant plugging in a hub emitted
  // one complete device list per port; the periodic resync below covers drift.
  USBMonitorManager.OnUSBConnect((Device) => {
    if (!Socket || !Socket.connected) {
      Logger.warn('Socket not connected, aborting OnUSBConnect');
      return;
    }
    Socket.emit('USBDeviceConnected', Device);
  });

  USBMonitorManager.OnUSBDisconnect((Device) => {
    if (!Socket || !Socket.connected) {
      Logger.warn('Socket not connected, aborting OnUSBDisconnect');
      return;
    }
    Socket.emit('USBDeviceDisconnected', Device);
  });

  usbListenersRegistered = true;
}

/** Everything about a display the server stores, so any change is reported. */
function displaySignature(Display: ClientDisplay): string {
  try {
    return JSON.stringify(Display);
  } catch (_error) {
    return String(Display && Display.DisplayID);
  }
}

/**
 * Report the display topology.
 *
 * `Force` sends the full list unconditionally and is what the periodic resync
 * and the on-connect report use — the full list is the authority the server
 * replaces its state from. Otherwise this reports the change only:
 *
 *  - against a server that supports deltas, as a `DisplayDelta`;
 *  - against an older one, as a full `DisplayList`, exactly as before.
 *
 * Either way nothing is sent when nothing we report has changed.
 * `display-metrics-changed` fires for changes that do not affect this payload at
 * all — the dock auto-hiding moves every display's workArea, for one — so an
 * unconditional emit turned routine desktop activity into traffic from every
 * client on the rig.
 */
async function UpdateDisplayList(Force = false): Promise<void> {
  if (!Socket || !Socket.connected) {
    Logger.warn('Socket not connected, aborting UpdateDisplayList');
    return;
  }
  const [Err, DisplayList] = await DisplayMonitorManager.GetDisplays();
  if (Err) Logger.error('Error getting displays:', Err);
  const Payload = Err || !Array.isArray(DisplayList) ? [] : DisplayList;
  let Signature: string | null;
  try {
    Signature = JSON.stringify(Payload);
  } catch (_error) {
    Signature = null; // Unserialisable payload: fall through and always emit.
  }

  if (!Force) {
    if (Signature !== null && Signature === lastDisplaySignature) return;
    if (ServerCapabilities.SupportsDeltas()) {
      const Delta = DiffByKey(
        lastDisplayList,
        Payload,
        (Display) => (Display && Display.DisplayID ? String(Display.DisplayID) : null),
        displaySignature
      );
      // A change that produced no diff means every display lacked a usable id;
      // fall through to the full list rather than reporting nothing.
      if (!IsEmptyDiff(Delta)) {
        lastDisplaySignature = Signature;
        lastDisplayList = Payload;
        Socket.emit('DisplayDelta', Delta);
        return;
      }
    }
  }

  lastDisplaySignature = Signature;
  lastDisplayList = Payload;
  Socket.emit('DisplayList', Payload);
}

function registerDisplayListeners(): void {
  if (displayListenersRegistered) return;

  DisplayMonitorManager.OnDisplayChange(async () => {
    if (!Socket || !Socket.connected) {
      Logger.warn('Socket not connected, aborting OnDisplayChange');
      return;
    }
    await UpdateDisplayList();
  });

  displayListenersRegistered = true;
}

// Run-on-launch orchestration (client side). Runs at most once per process,
// after the first successful connection. Ensures the script catalog (metadata +
// files on disk) and the auto-start settings are up to date with the server,
// then hands off to the main process to show the countdown and execute. Any
// accidental repeat is a no-op thanks to launchSequenceStarted + the main-side
// LaunchActionsHandled guard.
async function RunLaunchSequence(
  ActiveSocket: ShowTrakSocket,
  IP: string,
  Port: number
): Promise<void> {
  try {
    // 1. Fetch the auto-start settings fresh from the server (single source of
    // truth — the client keeps no local copy). If nothing is configured, stop
    // here so we don't needlessly re-sync scripts on every launch.
    const LaunchConfig = await new Promise<unknown>((resolve) => {
      ActiveSocket.emit('GetLaunchConfig', (Result) => resolve(Result));
    });
    const Normalized = LaunchConfigManager.Normalize(LaunchConfig);
    if (!Normalized.ScriptID) return;

    // 2. A launch script is configured: ensure the catalog + files are current
    // on disk before we run it.
    const Scripts = await new Promise<ClientScript[]>((resolve) => {
      ActiveSocket.emit('GetScripts', (Result) =>
        resolve(Array.isArray(Result) ? (Result as ClientScript[]) : [])
      );
    });
    try {
      await ScriptManager.DownloadScripts(IP, Port, Scripts);
    } catch (Err) {
      // A partial deployment failure shouldn't abort launch; the main-side
      // runnable check will skip the specific script if its file is missing.
      Logger.warn(`Run-on-launch: script sync reported issues: ${(Err as Error).message}`);
    }

    // 3. Hand off to the main process: countdown + execution. The config is
    // passed in the event payload — nothing is written to disk.
    Logger.log('Run-on-launch: scripts + settings synced, handing off to launch action');
    BroadcastManager.emit('RunLaunchAction', Normalized);
  } catch (Err) {
    Logger.error('Run-on-launch sequence failed', Err);
  }
}

export const Manager = {
  async Terminate(): Promise<void> {
    clearIntervals();
    try {
      await ProcessMonitor.Stop();
    } catch (_error) {
      Logger.warn('Failed to stop process monitor during termination');
    }
    try {
      await NetworkMonitor.Stop();
    } catch (_error) {
      Logger.warn('Failed to stop network monitor during termination');
    }
    if (Socket) {
      Socket.disconnect();
      Socket = null;
      Logger.log('MainClientManager terminated.');
    } else {
      Logger.log('No active socket to terminate.');
    }
  },

  async Init(UUID: string, IP: string, Port: number): Promise<void> {
    clearIntervals();
    consecutiveConnectErrors = 0;
    connectFailureReported = false;

    const Profile = await ProfileManager.GetProfile();
    const ExpectedServerIdentity = ReadIdentityToken(Profile && Profile.Server);

    if (Socket) {
      Socket.disconnect();
    }

    registerUSBListeners();
    registerDisplayListeners();

    // Create a Socket.IO client instance
    Socket = io(`http://${IP}:${Port}`, {
      autoConnect: true,
      transports: ['websocket'],
      query: {
        UUID: UUID,
        Adopted: true,
        ...(ExpectedServerIdentity ? { ExpectedServerIdentity } : {}),
      },
    });

    // Handlers below are bound to THIS socket instance. Capturing it locally
    // (rather than reading the module-level `Socket`, which a later Init would
    // have replaced) keeps each handler emitting on the connection it belongs
    // to, and gives the compiler a non-null value to work with inside closures.
    const ActiveSocket: ShowTrakSocket = Socket;

    ActiveSocket.on('connect', async () => {
      Logger.success('Connected to server successfully');
      markConnected(IP, Port);
      // Ask what this server understands before any telemetry goes out. An
      // older server never answers, and everything stays on full lists.
      ServerCapabilities.Probe(ActiveSocket);
      ActiveSocket.emit('GetScripts', async (Scripts) => {
        await ScriptManager.SetScripts(Array.isArray(Scripts) ? (Scripts as ClientScript[]) : []);
      });
      // Run-on-launch: on the FIRST successful connection this launch, sync
      // scripts + auto-start settings and then run (see RunLaunchSequence).
      // Guarded so reconnects never re-trigger it.
      if (!launchSequenceStarted) {
        launchSequenceStarted = true;
        RunLaunchSequence(ActiveSocket, IP, Port);
      }
      Heartbeat();
      await Wait(1000);
      SysInfo();
      await Wait(1000);
      UpdateDeviceList();
      await Wait(1000);
      // Forced: a reconnecting client must resend its list even when the
      // hardware has not changed, because this server may never have seen it.
      UpdateDisplayList(true);
      await Wait(1000);
      ReportNetworkInterfaces();
      try {
        await ProcessMonitor.Start(ActiveSocket);
      } catch (_error) {
        Logger.warn('Failed to start process monitor on connect');
      }
      try {
        await NetworkMonitor.Start(ActiveSocket);
      } catch (_error) {
        Logger.warn('Failed to start network monitor on connect');
      }
    });

    ActiveSocket.on('disconnect', () => {
      Logger.warn('Disconnected from server');
      // Drop the change-detection baseline: the next connection starts from a
      // clean slate rather than suppressing an emit the new server never got.
      lastDisplaySignature = null;
      lastDisplayList = [];
      ServerCapabilities.Reset();
      BroadcastManager.emit('MainClientConnectionStatus', {
        State: 'disconnected',
        IP,
        Port,
      });
      // Never leave the identify overlay stuck on screen if the link drops.
      BroadcastManager.emit('HideIdentifyOverlay');
      try {
        ProcessMonitor.Stop();
      } catch (_error) {
        Logger.warn('Failed to stop process monitor on disconnect');
      }
      try {
        NetworkMonitor.Stop();
      } catch (_error) {
        Logger.warn('Failed to stop network monitor on disconnect');
      }
    });

    ActiveSocket.on('connect_error', (Error) => {
      Logger.warn(
        `Connection error to ${IP}:${Port}`,
        Error && Error.message ? Error.message : Error
      );
      // Treat connection failures as link loss for identify UI purposes.
      BroadcastManager.emit('HideIdentifyOverlay');
      markConnectionError(IP, Port, Error);
    });

    ActiveSocket.on('UpdateSoftware', async (RequestID) => {
      Logger.log('Received UpdateSoftware request');
      BroadcastManager.emit('UpdateSoftware', async (Err) => {
        Logger.log(`UpdateSoftware callback executed for RequestID: ${RequestID}`);
        ActiveSocket.emit('ScriptExecutionResponse', RequestID, Err);
      });
    });

    ActiveSocket.on('UpdateSoftwareFromLAN', async (RequestID, Payload = {}) => {
      Logger.log('Received UpdateSoftwareFromLAN request');
      BroadcastManager.emit(
        'UpdateSoftwareFromLAN',
        {
          FeedURL: `http://${IP}:${Port}${Payload && Payload.FeedPath ? Payload.FeedPath : '/updates/client/latest/'}`,
          ReleaseVersion: Payload && Payload.ReleaseVersion ? Payload.ReleaseVersion : null,
        },
        (Progress = 0, StatusText = '') => {
          if (!ActiveSocket.connected) return;
          ActiveSocket.emit('ScriptExecutionProgress', RequestID, Progress, StatusText);
        },
        async (Err) => {
          Logger.log(`UpdateSoftwareFromLAN callback executed for RequestID: ${RequestID}`);
          if (!ActiveSocket.connected) return;
          ActiveSocket.emit('ScriptExecutionResponse', RequestID, Err || null);
        }
      );
    });

    ActiveSocket.on('DeleteScripts', async (RequestID) => {
      await ScriptManager.DeleteScripts();
      ActiveSocket.emit('ScriptExecutionResponse', RequestID, null);
    });

    ActiveSocket.on('UpdateScripts', async (RequestID) => {
      try {
        ActiveSocket.emit('GetScripts', async (Scripts) => {
          try {
            await ScriptManager.DownloadScripts(
              IP,
              Port,
              Array.isArray(Scripts) ? (Scripts as ClientScript[]) : []
            );
            ActiveSocket.emit('ScriptExecutionResponse', RequestID, null);
          } catch (Err) {
            const Message =
              Err && (Err as Error).message
                ? (Err as Error).message
                : String(Err || 'Failed to deploy scripts');
            Logger.error('UpdateScripts failed during download', Message);
            ActiveSocket.emit('ScriptExecutionResponse', RequestID, Message);
          }
        });
      } catch (Err) {
        const Message =
          Err && (Err as Error).message
            ? (Err as Error).message
            : String(Err || 'Failed to deploy scripts');
        Logger.error('UpdateScripts failed before download', Message);
        ActiveSocket.emit('ScriptExecutionResponse', RequestID, Message);
      }
    });

    ActiveSocket.on('Unadopt', async (Info) => {
      BroadcastManager.emit('ServerAdoptionRejected', {
        IP,
        Port,
        Reason: Info && Info.Reason ? String(Info.Reason) : null,
        ServerIdentity: ReadIdentityToken(Info) || null,
      });
    });

    ActiveSocket.on('ExecuteScript', async (RequestID, ScriptID) => {
      Logger.log(`Received ExecuteScript for RequestID: ${RequestID}, ScriptID: ${ScriptID}`);
      // Relay per-stage progress back to the server so the operator's execution
      // panel can fill a progress bar / show a running spinner for this client.
      const ReportProgress = (Progress = 0, StatusText = '') => {
        if (!ActiveSocket.connected) return;
        ActiveSocket.emit('ScriptExecutionProgress', RequestID, Progress, StatusText);
      };
      const [Err, Success] = await ScriptManager.Execute(RequestID, ScriptID, ReportProgress);
      if (Err) {
        Logger.error(`Error executing script: ${Err}`);
        ActiveSocket.emit('ScriptExecutionResponse', RequestID, Err, null);
      } else {
        Logger.success(`Script executed successfully: ${RequestID} ${ScriptID}`);
        ActiveSocket.emit('ScriptExecutionResponse', RequestID, null, Success);
      }
    });

    // Identify mode: show a full-screen overlay so an operator can locate this
    // machine. The overlay windows live in the main process (IdentifyOverlay).
    ActiveSocket.on('Identify', async (Payload = {}) => {
      const Nickname =
        Payload && typeof Payload.Nickname === 'string' && Payload.Nickname.trim()
          ? Payload.Nickname.trim()
          : null;
      BroadcastManager.emit('ShowIdentifyOverlay', {
        Hostname: OS.Hostname,
        Nickname,
        IPs: OS.GetLocalIPv4Addresses(),
      });
    });

    ActiveSocket.on('StopIdentify', async () => {
      BroadcastManager.emit('HideIdentifyOverlay');
    });

    async function Heartbeat(): Promise<void> {
      if (!ActiveSocket.connected) return;
      const ScriptsFingerprint = await ScriptManager.GetLastAppliedDeploymentFingerprint();
      ActiveSocket.volatile.emit('Heartbeat', {
        Version: Config.Application.Version,
        Vitals: await OS.GetVitals(),
        ScriptsFingerprint,
      });
    }
    heartbeatInterval = setInterval(Heartbeat, 1000);

    async function SysInfo(): Promise<void> {
      if (!ActiveSocket.connected) return;
      const [MacError, MacAddresses] = await OS.GetMacAddresses();
      if (MacError) {
        Logger.error(MacError);
        return;
      }
      ActiveSocket.emit('SystemInfo', {
        Hostname: OS.Hostname,
        OperatingSystem: OS.OperatingSystem,
        MacAddresses: MacAddresses ?? {},
      });
    }

    sysInfoInterval = setInterval(SysInfo, 20000);
    // USB and display changes both reach the server as events the moment they
    // happen (libusb hotplug and Electron's screen events respectively), so
    // these full lists are purely a reconciliation channel: they exist to
    // correct drift if an event was missed or the server restarted, not to
    // deliver the news. A minute is frequent enough for that job.
    deviceListInterval = setInterval(UpdateDeviceList, FULL_LIST_RESYNC_INTERVAL_MS);
    displayListInterval = setInterval(
      () => void UpdateDisplayList(true),
      FULL_LIST_RESYNC_INTERVAL_MS
    );

    // Network Interfaces Reporting (initial snapshot)
    async function ReportNetworkInterfaces(): Promise<void> {
      if (!ActiveSocket.connected) {
        Logger.warn('Socket not connected, aborting ReportNetworkInterfaces');
        return;
      }
      const [Err, Interfaces] = await OS.GetNetworkInterfaces();
      if (Err) {
        Logger.error('Error getting network interfaces:', Err);
        return;
      }
      ActiveSocket.emit('NetworkInterfaces', Interfaces || []);
    }
  },
};
