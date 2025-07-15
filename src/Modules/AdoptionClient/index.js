const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('AdopptionClient');

const { io } = require("socket.io-client");
var Socket = null;
const { Config } = require('../Config');
const { Manager: OSManager } = require('../OS');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: AppDataManager } = require('../AppData');
const path = require('path');
const fs = require('fs');

const Manager = {
    Terminate: async () => {
        if (Socket) {
            Socket.disconnect();
            Socket = null;
            Logger.log('AdoptionClientManager terminated.');
        } else {
            Logger.log('No active socket to terminate.');
        }
    },
    Init: async (UUID, IP, Port) => {

        const BootTime = Date.now();

        if (Socket) Socket.disconnect()

        Socket = io(`http://${IP}:${Port}`, {
            autoConnect: true,
            transports: ["websocket"],
            query: {
                UUID: UUID,
                Adopted: false,
            }
        });

        // Example: Listen for connection
        Socket.on("connect", async () => {
            Logger.log("Connected to host and advertised for adoption. UUID:", UUID);
            await SendAdoptionHeartbeat();
        });

        async function SendAdoptionHeartbeat() {
            if (!Socket || !Socket.connected) return;
            Socket.emit("AdoptionHeartbeat", {
                BootTime: BootTime,
                Hostname: OSManager.Hostname,
                Version: Config.Application.Version,
            });
            return;
        }

        setInterval(SendAdoptionHeartbeat, 10000)

        Socket.on("disconnect", () => {
            Logger.log("Disconnected from server");
        });

        Socket.on("Adopt", () => {
            Logger.log("Adopt command received");
                    
            const profilePath = path.join(AppDataManager.GetProfileDirectory(), 'Profile.json');
            Logger.log('Profile Path:', profilePath);

            if (!fs.existsSync(profilePath)) {
                Logger.log('Profile.json does not exist.');
                throw new Error('Error with adoption: Profile.json not found.')
            }

            const Profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
            const DefaultProfile = {
                UUID: Profile.UUID,
                Adopted: true,
                Server: {
                    IP: IP,
                    Port: Port,
                    AdoptionTime: Date.now(),
                }
            };
            fs.writeFileSync(profilePath, JSON.stringify(DefaultProfile, null, 2));
            Logger.log('Profile updated, Adoption Complete.');
            BroadcastManager.emit('ReinitializeService');






        });

    }
}

module.exports = {
    Manager
}