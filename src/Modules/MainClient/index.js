const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MainClient');

const { Manager: BroadcastManager } = require('../Broadcast');
const { io } = require("socket.io-client");
var Socket = null;
const { Manager: OS } = require('../OS');
const { Config } = require('../Config');

const { Manager: USBMonitorManager } = require('../USBMonitor');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: ProfileManager } = require('../ProfileManager');

const { Wait } = require('../Utils');

const Manager = {
    Terminate: async () => {
        if (Socket) {
            Socket.disconnect();
            Socket = null;
            Logger.log('MainClientManager terminated.');
        } else {
            Logger.log('No active socket to terminate.');
        }
    },
    Init: async (UUID, IP, Port) => {

        if (Socket) {
            Socket.disconnect()
        }

        // Create a Socket.IO client instance
        Socket = io(`http://${IP}:${Port}`, {
            autoConnect: true,
            transports: ["websocket"],
            query: {
                UUID: UUID,
                Adopted: true,
            }
        });

        Socket.on("connect", async () => {
            Logger.success("Connected to server successfully");
            Heartbeat();
            await Wait(1000);
            SysInfo();
            await Wait(1000);
            UpdateDeviceList();
        });

        Socket.on("disconnect", () => {
            Logger.warn("Disconnected from server");
        });

        Socket.on("DeleteScripts", async (RequestID) => {
            await ScriptManager.DeleteScripts()
            Socket.emit("ScriptExecutionResponse", RequestID, null);
        })

        Socket.on("UpdateScripts", async (RequestID) => {
            Socket.emit("GetScripts", async (Scripts) => {
                await ScriptManager.DownloadScripts(IP, Port, Scripts)
                Socket.emit("ScriptExecutionResponse", RequestID, null);
            })
        });

        Socket.on("Unadopt", async () => {
            await ProfileManager.ResetAdopption();
            BroadcastManager.emit('ReinitializeService');
        });

        Socket.on("ExecuteScript", async (RequestID, ScriptID) => {
            console.log(`Received ExecuteScript for RequestID: ${RequestID}, ScriptID: ${ScriptID}`);
            let [Err, Success] = await ScriptManager.Execute(RequestID, ScriptID);
            if (Err) {
                Logger.error(`Error executing script: ${Err}`);
                Socket.emit("ScriptExecutionResponse", RequestID, Err, null);
            } else {
                Logger.success(`Script executed successfully: ${RequestID} ${ScriptID}`);
                Socket.emit("ScriptExecutionResponse", RequestID, null, Success);
            }
        });

        async function Heartbeat() {
            if (!Socket || !Socket.connected) return
            Socket.volatile.emit("Heartbeat", {
                Version: Config.Application.Version,
                Vitals: await OS.GetVitals(),
            });
        }
        setInterval(Heartbeat, 1000);

        async function SysInfo() {
            if (!Socket || !Socket.connected) return
            const [MacError, MacAddresses] = await OS.GetMacAddresses();
            if (MacError) return Logger.error(MacError);
            Socket.emit("SystemInfo", {
                Hostname: OS.Hostname,
                MacAddresses: MacAddresses,
            });
        }

        setInterval(SysInfo, 20000);

        // USB Monitoring

        async function UpdateDeviceList() {
            if (!Socket || !Socket.connected) return Logger.warn('Socket not connected, aborting UpdateDeviceList')
            let [Err, DeviceList] = await USBMonitorManager.GetUSBDevices();
            if (Err) Logger.error('Error getting USB devices:', Err);
            if (Err || !DeviceList || DeviceList.length == 0) return Socket.emit("USBDeviceList", []);
            Socket.emit("USBDeviceList", DeviceList);
        }

        setInterval(SysInfo, 60000);

        USBMonitorManager.OnUSBConnect(async (Device) => {
            if (!Socket || !Socket.connected) return Logger.warn('Socket not connected, aborting OnUSBConnect')
            Socket.emit("USBDeviceConnected", Device);
            UpdateDeviceList();
        })

        USBMonitorManager.OnUSBDisconnect(async (Device) => {
            if (!Socket || !Socket.connected) return Logger.warn('Socket not connected, aborting OnUSBDisconnect')
            Socket.emit("USBDeviceDisconnected", Device);
            UpdateDeviceList();
        })


    }
}

module.exports = {
    Manager
}