const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MainClient');

const { Manager: BroadcastManager } = require('../Broadcast');
const { io } = require('socket.io-client');
var Socket = null;
const { Manager: OS } = require('../OS');
const { Config } = require('../Config');

const { Manager: USBMonitorManager } = require('../USBMonitor');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: ProfileManager } = require('../ProfileManager');
const { Manager: NetworkMonitor } = require('../NetworkMonitor');
const { Manager: ProcessMonitor } = require('../ProcessMonitor');

const { Wait } = require('../Utils');

let heartbeatInterval = null;
let sysInfoInterval = null;
let deviceListInterval = null;
let usbListenersRegistered = false;

function clearIntervals() {
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
}

async function UpdateDeviceList() {
  if (!Socket || !Socket.connected)
    return Logger.warn('Socket not connected, aborting UpdateDeviceList');
  let [Err, DeviceList] = await USBMonitorManager.GetUSBDevices();
  if (Err) Logger.error('Error getting USB devices:', Err);
  if (Err || !DeviceList || DeviceList.length == 0) return Socket.emit('USBDeviceList', []);
  Socket.emit('USBDeviceList', DeviceList);
}

function registerUSBListeners() {
  if (usbListenersRegistered) return;

  USBMonitorManager.OnUSBConnect(async (Device) => {
    if (!Socket || !Socket.connected)
      return Logger.warn('Socket not connected, aborting OnUSBConnect');
    Socket.emit('USBDeviceConnected', Device);
    await UpdateDeviceList();
  });

  USBMonitorManager.OnUSBDisconnect(async (Device) => {
    if (!Socket || !Socket.connected)
      return Logger.warn('Socket not connected, aborting OnUSBDisconnect');
    Socket.emit('USBDeviceDisconnected', Device);
    await UpdateDeviceList();
  });

  usbListenersRegistered = true;
}

const Manager = {
  Terminate: async () => {
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
  Init: async (UUID, IP, Port) => {
    clearIntervals();

    if (Socket) {
      Socket.disconnect();
    }

    registerUSBListeners();

    // Create a Socket.IO client instance
    Socket = io(`http://${IP}:${Port}`, {
      autoConnect: true,
      transports: ['websocket'],
      query: {
        UUID: UUID,
        Adopted: true,
      },
    });

    Socket.on('connect', async () => {
      Logger.success('Connected to server successfully');
      Socket.emit('GetScripts', async (Scripts) => {
        await ScriptManager.SetScripts(Scripts);
      });
      Heartbeat();
      await Wait(1000);
      SysInfo();
      await Wait(1000);
      UpdateDeviceList();
      await Wait(1000);
      ReportNetworkInterfaces();
      try {
        await ProcessMonitor.Start(Socket);
      } catch (_error) {
        Logger.warn('Failed to start process monitor on connect');
      }
      try {
        await NetworkMonitor.Start(Socket);
      } catch (_error) {
        Logger.warn('Failed to start network monitor on connect');
      }
    });

    Socket.on('disconnect', () => {
      Logger.warn('Disconnected from server');
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

    Socket.on('UpdateSoftware', async (RequestID) => {
      Logger.log('Received UpdateSoftware request');
      BroadcastManager.emit('UpdateSoftware', async (Err) => {
        Logger.log(`UpdateSoftware callback executed for RequestID: ${RequestID}`);
        Socket.emit('ScriptExecutionResponse', RequestID, Err);
      });
    });

    Socket.on('UpdateSoftwareFromLAN', async (RequestID, Payload = {}) => {
      Logger.log('Received UpdateSoftwareFromLAN request');
      BroadcastManager.emit(
        'UpdateSoftwareFromLAN',
        {
          FeedURL: `http://${IP}:${Port}${Payload && Payload.FeedPath ? Payload.FeedPath : '/updates/client/latest/'}`,
          ReleaseVersion: Payload && Payload.ReleaseVersion ? Payload.ReleaseVersion : null,
        },
        async (Progress = 0, StatusText = '') => {
          if (!Socket || !Socket.connected) return;
          Socket.emit('ScriptExecutionProgress', RequestID, Progress, StatusText);
        },
        async (Err) => {
          Logger.log(`UpdateSoftwareFromLAN callback executed for RequestID: ${RequestID}`);
          if (!Socket || !Socket.connected) return;
          Socket.emit('ScriptExecutionResponse', RequestID, Err || null);
        }
      );
    });

    Socket.on('DeleteScripts', async (RequestID) => {
      await ScriptManager.DeleteScripts();
      Socket.emit('ScriptExecutionResponse', RequestID, null);
    });

    Socket.on('UpdateScripts', async (RequestID) => {
      try {
        Socket.emit('GetScripts', async (Scripts) => {
          try {
            await ScriptManager.DownloadScripts(IP, Port, Scripts);
            Socket.emit('ScriptExecutionResponse', RequestID, null);
          } catch (Err) {
            const Message = Err && Err.message ? Err.message : String(Err || 'Failed to deploy scripts');
            Logger.error('UpdateScripts failed during download', Message);
            Socket.emit('ScriptExecutionResponse', RequestID, Message);
          }
        });
      } catch (Err) {
        const Message = Err && Err.message ? Err.message : String(Err || 'Failed to deploy scripts');
        Logger.error('UpdateScripts failed before download', Message);
        Socket.emit('ScriptExecutionResponse', RequestID, Message);
      }
    });

    Socket.on('Unadopt', async () => {
      await ProfileManager.ResetAdopption();
      BroadcastManager.emit('ReinitializeService');
    });

    Socket.on('ExecuteScript', async (RequestID, ScriptID) => {
      console.log(`Received ExecuteScript for RequestID: ${RequestID}, ScriptID: ${ScriptID}`);
      let [Err, Success] = await ScriptManager.Execute(RequestID, ScriptID);
      if (Err) {
        Logger.error(`Error executing script: ${Err}`);
        Socket.emit('ScriptExecutionResponse', RequestID, Err, null);
      } else {
        Logger.success(`Script executed successfully: ${RequestID} ${ScriptID}`);
        Socket.emit('ScriptExecutionResponse', RequestID, null, Success);
      }
    });

    async function Heartbeat() {
      if (!Socket || !Socket.connected) return;
      const ScriptsFingerprint = await ScriptManager.GetLastAppliedDeploymentFingerprint();
      Socket.volatile.emit('Heartbeat', {
        Version: Config.Application.Version,
        Vitals: await OS.GetVitals(),
        ScriptsFingerprint,
      });
    }
    heartbeatInterval = setInterval(Heartbeat, 1000);

    async function SysInfo() {
      if (!Socket || !Socket.connected) return;
      const [MacError, MacAddresses] = await OS.GetMacAddresses();
      if (MacError) return Logger.error(MacError);
      Socket.emit('SystemInfo', {
        Hostname: OS.Hostname,
        OperatingSystem: OS.OperatingSystem,
        MacAddresses: MacAddresses,
      });
    }

    sysInfoInterval = setInterval(SysInfo, 20000);
    deviceListInterval = setInterval(UpdateDeviceList, 60000);

    // Network Interfaces Reporting (initial snapshot)
    async function ReportNetworkInterfaces() {
      if (!Socket || !Socket.connected)
        return Logger.warn('Socket not connected, aborting ReportNetworkInterfaces');
      const [Err, Interfaces] = await OS.GetNetworkInterfaces();
      if (Err) return Logger.error('Error getting network interfaces:', Err);
      Socket.emit('NetworkInterfaces', Interfaces || []);
    }
  },
};

module.exports = {
  Manager,
};
