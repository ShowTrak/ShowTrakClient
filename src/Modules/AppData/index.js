const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');
const appDataPath = path.join(process.env.APPDATA, 'ShowTrakClient');

const Manager = {};

Manager.Initialize = () => {
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }

  let AppDataFolders = [
    'Logs',
    'Scripts',
    'Profile',
  ]
  AppDataFolders.forEach(folder => {
    const folderPath = path.join(appDataPath, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  });
}

Manager.GetProfileDirectory = () => {
  return path.join(appDataPath, 'Profile');
}

Manager.GetLogsDirectory = () => {
  return path.join(appDataPath, 'Logs');
}

Manager.GetScriptsDirectory = () => {
  return path.join(appDataPath, 'Scripts');
}

Manager.OpenFolder = (FolderPath) => {
  if (fs.existsSync(FolderPath)) {
    require('child_process').exec(`start "" "${FolderPath}"`);
    return true;
  } else {
    return false;
  }
}

module.exports = {
    Manager,
}