const AutoLaunch = require('auto-launch');
const { app } = require('electron');

const { CreateLogger } = require('../Logger');
const { Config } = require('../Config');

const Logger = CreateLogger('Startup');

function createAutoLaunch() {
  return new AutoLaunch({
    name: Config.Application.Name || 'ShowTrak Client',
    path: process.execPath,
    isHidden: true,
  });
}

async function EnsureEnabled() {
  if (!app.isPackaged) {
    Logger.log('Skipping autostart registration while unpackaged');
    return false;
  }

  try {
    const launcher = createAutoLaunch();
    const alreadyEnabled = await launcher.isEnabled();
    if (alreadyEnabled) {
      Logger.log('Autostart already enabled');
      return true;
    }

    await launcher.enable();
    Logger.log('Autostart enabled');
    return true;
  } catch (error) {
    Logger.warn('Failed to configure autostart', String(error));
    return false;
  }
}

module.exports = {
  Manager: {
    EnsureEnabled,
  },
};