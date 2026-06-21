const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ProfileManager');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: UUIDManager } = require('../UUID');

const path = require('node:path');
const fs = require('node:fs');

const ProfilePath = path.join(AppDataManager.GetProfileDirectory(), 'Profile.json');
const ManualServerPath = path.join(AppDataManager.GetProfileDirectory(), 'ManualServer.json');

const Manager = {};

// Normalize a manually configured server endpoint. Returns a sanitized
// { Host, Port } object or null when the input is invalid. Host may be an
// IPv4/IPv6 literal or a DNS hostname so the agent can reach a server that
// lives on a different VLAN/subnet where mDNS discovery cannot reach.
function NormalizeManualServer(Host, Port) {
  const NormalizedHost = typeof Host === 'string' ? Host.trim() : '';
  if (!NormalizedHost) return null;
  const NormalizedPort = Number(Port);
  if (!Number.isInteger(NormalizedPort) || NormalizedPort < 1 || NormalizedPort > 65535) {
    return null;
  }
  return { Host: NormalizedHost, Port: NormalizedPort };
}

function ReadManualServerFromDisk() {
  if (!fs.existsSync(ManualServerPath)) return null;
  try {
    const Stored = JSON.parse(fs.readFileSync(ManualServerPath, 'utf-8'));
    return Stored ? NormalizeManualServer(Stored.Host, Stored.Port) : null;
  } catch (Error) {
    Logger.error('Failed to read ManualServer.json', Error);
    return null;
  }
}

function WriteManualServerToDisk(ManualServer) {
  fs.writeFileSync(ManualServerPath, JSON.stringify(ManualServer, null, 2));
}

function DeleteManualServerFromDisk() {
  try {
    if (fs.existsSync(ManualServerPath)) fs.unlinkSync(ManualServerPath);
  } catch (Error) {
    Logger.error('Failed to remove ManualServer.json', Error);
  }
}

function AttachManualServer(Profile) {
  const ManualServer = ReadManualServerFromDisk();
  return ManualServer ? { ...Profile, ManualServer } : Profile;
}

function StripLegacyManualServer(Profile) {
  if (!Profile || !Profile.ManualServer) return Profile;
  const ManualServer = NormalizeManualServer(Profile.ManualServer.Host, Profile.ManualServer.Port);
  const SanitizedProfile = { ...Profile };
  delete SanitizedProfile.ManualServer;
  fs.writeFileSync(ProfilePath, JSON.stringify(SanitizedProfile, null, 2));
  if (ManualServer) {
    WriteManualServerToDisk(ManualServer);
    Logger.log('Migrated legacy manual server endpoint to ManualServer.json');
  }
  return SanitizedProfile;
}

Manager.GetProfile = async () => {
  AppDataManager.Initialize();
  if (!fs.existsSync(ProfilePath)) {
    Logger.log('Profile.json does not exist.');
    const NewProfile = {
      UUID: UUIDManager.Generate(),
      Adopted: false,
    };
    fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
    BroadcastManager.emit('ProfileUpdated', NewProfile);
    Logger.log('Default Profile.json created.');
  }
  var Profile = JSON.parse(fs.readFileSync(ProfilePath, 'utf-8'));
  if (!Profile || !Profile.UUID || !Profile.UUID.length) {
    await Manager.ForceResetProfile();
    Profile = JSON.parse(fs.readFileSync(ProfilePath, 'utf-8'));
  }
  Profile = StripLegacyManualServer(Profile);
  Logger.log('Profile Generated');
  return AttachManualServer(Profile);
};

Manager.ForceResetProfile = async () => {
  const NewProfile = {
    UUID: UUIDManager.Generate(),
    Adopted: false,
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  DeleteManualServerFromDisk();
  Logger.log('Profile.json overwritten');
};

Manager.Adopt = async (IP, Port, Options = {}) => {
  const Profile = await Manager.GetProfile();
  const ServerIdentity =
    Options && typeof Options.ServerIdentity === 'string' && Options.ServerIdentity.trim()
      ? Options.ServerIdentity.trim()
      : null;

  const NewProfile = {
    UUID: Profile.UUID,
    Adopted: true,
    Server: {
      IP: IP,
      Port: Port,
      AdoptionTime: Date.now(),
      ...(ServerIdentity ? { ServerIdentity } : {}),
    },
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log('Profile updated with adoption details.');
  BroadcastManager.emit('ProfileUpdated', AttachManualServer(NewProfile));
  return;
};

Manager.UpdateServerEndpoint = async (IP, Port) => {
  const Profile = await Manager.GetProfile();
  if (!Profile || !Profile.Adopted || !Profile.Server) {
    return;
  }

  const CurrentIP = Profile.Server.IP;
  const CurrentPort = Profile.Server.Port;
  if (CurrentIP === IP && CurrentPort === Port) {
    return;
  }

  const NewProfile = {
    UUID: Profile.UUID,
    Adopted: true,
    Server: {
      IP,
      Port,
      AdoptionTime: Profile.Server.AdoptionTime || Date.now(),
      LastRecoveredAt: Date.now(),
      ...(Profile.Server && Profile.Server.ServerIdentity
        ? { ServerIdentity: Profile.Server.ServerIdentity }
        : {}),
    },
  };

  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log(`Profile server endpoint updated to ${IP}:${Port}`);
  BroadcastManager.emit('ProfileUpdated', AttachManualServer(NewProfile));
};

Manager.ResetAdopption = async () => {
  const Profile = await Manager.GetProfile();
  const NewProfile = {
    UUID: Profile.UUID,
    Adopted: false,
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  Logger.log('Reset adoption state to pending.');
  BroadcastManager.emit('ProfileUpdated', AttachManualServer(NewProfile));
  return;
};

// Persist an operator-defined server endpoint. Bypasses mDNS discovery so the
// agent can adopt against / recover to a server on a different VLAN/subnet.
Manager.SetManualServer = async (Host, Port) => {
  const ManualServer = NormalizeManualServer(Host, Port);
  if (!ManualServer) {
    throw new Error(
      'Invalid manual server endpoint. Provide a host and a port between 1 and 65535.'
    );
  }
  const Profile = await Manager.GetProfile();
  WriteManualServerToDisk(ManualServer);
  Logger.log(`Manual server endpoint set to ${ManualServer.Host}:${ManualServer.Port}`);
  BroadcastManager.emit('ProfileUpdated', { ...Profile, ManualServer });
  return ManualServer;
};

// Remove the operator-defined server endpoint and fall back to mDNS discovery.
Manager.ClearManualServer = async () => {
  const Profile = await Manager.GetProfile();
  if (!Profile.ManualServer) return;
  DeleteManualServerFromDisk();
  const NewProfile = { ...Profile };
  delete NewProfile.ManualServer;
  Logger.log('Manual server endpoint cleared; reverting to automatic discovery.');
  BroadcastManager.emit('ProfileUpdated', NewProfile);
  return;
};

// Return the sanitized manual server endpoint, or null when not configured.
Manager.GetManualServer = async () => {
  return ReadManualServerFromDisk();
};

Manager.ResetProfileToFactoryDefaults = async () => {
  const NewProfile = {
    UUID: UUIDManager.Generate(),
    Adopted: false,
  };
  fs.writeFileSync(ProfilePath, JSON.stringify(NewProfile, null, 2));
  DeleteManualServerFromDisk();
  Logger.log('Profile reset to factory defaults.');
  BroadcastManager.emit('ProfileUpdated', NewProfile);
  return;
};

module.exports = {
  Manager,
};
