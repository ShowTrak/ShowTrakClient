

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ProfileManager');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: BroadcastManager } = require('../Broadcast');

const path = require('path');
const fs = require('fs');

const ProfilePath = path.join(AppDataManager.GetProfileDirectory(), 'Profile.json');

const Manager = {};

Manager.GetProfile = async () => {
  AppDataManager.Initialize();
  if (!fs.existsSync(ProfilePath)) {
    Logger.log('Profile.json does not exist.');
    const NewProfile = {
      UUID: UUIDManager.Generate(),
      Adopted: false,
    };
    fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
    Logger.log('Default Profile.json created.');
  }
  const Profile = JSON.parse(fs.readFileSync(ProfilePath, 'utf-8'))
  Logger.log('Profile Generated')
  BroadcastManager.emit('ProfileUpdated', Profile);
  return Profile;
}

Manager.Adopt = async (IP, Port) => {
  const Profile = await Manager.GetProfile();

  const NewProfile = {
    UUID: Profile.UUID,
    Adopted: true,
    Server: {
      IP: IP,
      Port: Port,
      AdoptionTime: Date.now(),
    }
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log('Profile updated with adopption details.');
  BroadcastManager.emit('ProfileUpdated', NewProfile);
  return;
}

Manager.ResetAdopption = async () => {
  const Profile = await Manager.GetProfile();
  const NewProfile = {
    UUID: Profile.UUID,
    Adopted: false,
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log('Reset adoption state to pending.');
  BroadcastManager.emit('ProfileUpdated', NewProfile);
  return;
}

Manager.ResetProfileToFactoryDefaults = async () => {
  const NewProfile = {
    UUID: UUIDManager.Generate(),
    Adopted: false,
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log('Profile reset to factory defaults.');
  BroadcastManager.emit('ProfileUpdated', NewProfile);
  return;
}

module.exports = {
  Manager
}