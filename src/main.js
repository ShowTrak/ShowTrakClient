const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain: RPC } = require('electron');

if (require('electron-squirrel-startup')) app.quit();

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
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
const { Manager: AppDataManager } = require('./Modules/AppData');
const { Manager: ProfileManager } = require('./Modules/ProfileManager');
AppDataManager.Initialize();

const { Config } = require('./Modules/Config');

let tray;
let mainWindow;
app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 450,
    height: 320,
    maxWidth: 450,
    maxHeight: 320,
    resizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  })

  mainWindow.loadFile(path.join(__dirname, 'UI', 'index.html'))

  let IconPath = path.join(__dirname, 'Images', 'icon.ico');
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
  tray.on('click', function (_e) {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
    }
  });


  RPC.handle('Loaded', async () => {
    const Profile = await ProfileManager.GetProfile();
    mainWindow.webContents.send('SetProfile', Profile);
  })

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

  Main();

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

BroadcastManager.on('ProfileUpdated', async (Profile) => {
  if (mainWindow) mainWindow.webContents.send('SetProfile', Profile);
});

BroadcastManager.on('UpdateSoftware', async (Callback) => {
  if (!app.isPackaged) return Callback('App is not packaged, skipping update check');
  const { updateElectronApp } = require('update-electron-app')
  updateElectronApp({
    notifyUser: false,
    logger: Logger,
  })
  return Callback(null);
})

async function Main() {
  const Profile = await ProfileManager.GetProfile();
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
  const Profile = await ProfileManager.GetProfile();
  Logger.log(`Attempting connection to ${Profile.Server.IP}:${Profile.Server.Port}`);
  await MainClientManager.Init(Profile.UUID, Profile.Server.IP, Profile.Server.Port);
}

