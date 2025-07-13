const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');

const { Manager: AdoptionClientManager } = require('./Modules/AdoptionClient');
const { Manager: MainClientManager } = require('./Modules/MainClient');
const path = require('path');
const fs = require('fs');
const { Manager: UUIDManager } = require('./Modules/UUID');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
const { Manager: USBMonitorManager } = require('./Modules/USBMonitor');
const { Manager: AppDataManager } = require('./Modules/AppData');


const profilePath = path.join(__dirname, 'Profile.json');

// ReinitializeService
BroadcastManager.on('ReinitializeService', async () => {
    await BonjourManager.Terminate();
    await AdoptionClientManager.Terminate();
    await MainClientManager.Terminate();
    await Main();
});

async function Main() {
    await AppDataManager.Initialize();
    if (!fs.existsSync(profilePath)) {
        Logger.log('Profile.json does not exist.');
        // Create a default Profile.json
        const DefaultProfile = {
            UUID: UUIDManager.Generate(),
            Adopted: false,
        };
        fs.writeFileSync(profilePath, JSON.stringify(DefaultProfile, null, 2));
        Logger.log('Default Profile.json created.');
    }

    const Profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));

    if (Profile.Adopted && Profile.Server && Profile.Server.IP && Profile.Server.Port) {
        Logger.log('Profile loaded [Adopted]');
        await BootWithStoredSettings();
    } else {
        Logger.log('Profile loaded [Unadopted]');
        const { Manager: BonjourManager } = require('./Modules/Bonjour');
        BonjourManager.OnFind(async (Server) => {
            await AdoptionClientManager.Init(Profile.UUID, Server.addresses[0], Server.port);
        })
    }
  
}

async function BootWithStoredSettings() {
    const Profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    Logger.log(`Attempting connection to ${Profile.Server.IP}:${Profile.Server.Port}`);
    await MainClientManager.Init(Profile.UUID, Profile.Server.IP, Profile.Server.Port);
}

Main();





