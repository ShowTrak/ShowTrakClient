const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain: RPC } = require('electron');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Client is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');
}

const { Manager: AdoptionClientManager } = require('./Modules/AdoptionClient');
const { Manager: MainClientManager } = require('./Modules/MainClient');
const path = require('path');
const fs = require('fs');
const { Manager: UUIDManager } = require('./Modules/UUID');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
const { Manager: AppDataManager } = require('./Modules/AppData');

const { Config } = require('./Modules/Config');

const profilePath = path.join(__dirname, 'Profile.json');

let tray;
let mainWindow;
app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 600,
    height: 320,    
    maxWidth: 600,
    maxHeight: 320,
    resizable: false,
    fullscreenable: false,
    webPreferences: { 
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  })

  mainWindow.loadFile(path.join(__dirname, 'UI', 'index.html'))

  let IconPath = path.join(__dirname, 'images', 'icon.ico');
  const icon = nativeImage.createFromPath(IconPath) 
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Stop Service',
      click: async () => {
        app.quit();
      }
    }
  ])

  tray.setToolTip('ShowTrak Client Service')
  tray.setContextMenu(contextMenu)
  tray.setIgnoreDoubleClickEvents(true)
  tray.on('click', function(e){
    if (!mainWindow) return; 
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
    }
  });

  RPC.handle('Minimise', async () => {
    console.log(1);
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    return;
  })

  RPC.handle('Shutdown', async () => {
    app.quit();
    return;
  })

  RPC.handle('GetVersion', async () => {
    return Config.Application.Version;
  })

})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ReinitializeService
BroadcastManager.on('ReinitializeService', async () => {
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





