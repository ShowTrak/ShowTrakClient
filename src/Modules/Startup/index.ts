import AutoLaunch from 'auto-launch';
import { app } from 'electron';

import { CreateLogger } from '../Logger';
import { Config } from '../Config';

const Logger = CreateLogger('Startup');

function createAutoLaunch(): AutoLaunch {
  return new AutoLaunch({
    name: Config.Application.Name || 'ShowTrak Client',
    path: process.execPath,
    isHidden: true,
  });
}

async function EnsureEnabled(): Promise<boolean> {
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

export const Manager = {
  EnsureEnabled,
};
