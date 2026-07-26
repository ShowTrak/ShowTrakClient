import path from 'node:path';
import fs from 'node:fs';

import type {
  ClientProfile,
  ManualServer,
  ProfileIdentity,
  ResolvedClientProfile,
  ResolvedIdentity,
} from '../../types/client';
import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as HardwareIdentityManager } from '../HardwareIdentity';
import { ParseMacWitness } from '../HardwareIdentity/fingerprint';
import { ReadIdentityToken } from '../Utils';

const Logger = CreateLogger('ProfileManager');

const ProfilePath = path.join(AppDataManager.GetProfileDirectory(), 'Profile.json');
const ManualServerPath = path.join(AppDataManager.GetProfileDirectory(), 'ManualServer.json');

// Write Profile.json atomically. A torn write leaves a profile with no UUID,
// which trips the self-heal path below and silently changes the client's
// identity -- so the temp-file + rename is protecting identity, not just JSON.
function WriteProfileFile(Profile: ClientProfile): void {
  const TempPath = `${ProfilePath}.tmp`;
  fs.writeFileSync(TempPath, JSON.stringify(Profile, null, 2));
  fs.renameSync(TempPath, ProfilePath);
}

// Every mutation below rebuilds the profile object from scratch and carries
// only the fields it cares about. Identity must survive all of them: dropping
// it would make the next boot treat the profile as legacy and re-derive,
// unadopting the client for no reason.
function WriteProfile(Next: ClientProfile, Previous: ClientProfile | null): ClientProfile {
  const Merged: ClientProfile = {
    ...Next,
    ...(Previous && Previous.Identity ? { Identity: Previous.Identity } : {}),
  };
  WriteProfileFile(Merged);
  return Merged;
}

// Normalize a manually configured server endpoint. Returns a sanitized
// { Host, Port } object or null when the input is invalid. Host may be an
// IPv4/IPv6 literal or a DNS hostname so the agent can reach a server that
// lives on a different VLAN/subnet where mDNS discovery cannot reach.
function NormalizeManualServer(Host: unknown, Port: unknown): ManualServer | null {
  const NormalizedHost = typeof Host === 'string' ? Host.trim() : '';
  if (!NormalizedHost) return null;
  const NormalizedPort = Number(Port);
  if (!Number.isInteger(NormalizedPort) || NormalizedPort < 1 || NormalizedPort > 65535) {
    return null;
  }
  return { Host: NormalizedHost, Port: NormalizedPort };
}

function ReadManualServerFromDisk(): ManualServer | null {
  if (!fs.existsSync(ManualServerPath)) return null;
  try {
    const Stored = JSON.parse(fs.readFileSync(ManualServerPath, 'utf-8'));
    return Stored ? NormalizeManualServer(Stored.Host, Stored.Port) : null;
  } catch (Err) {
    Logger.error('Failed to read ManualServer.json', Err);
    return null;
  }
}

function WriteManualServerToDisk(ManualServer: ManualServer): void {
  fs.writeFileSync(ManualServerPath, JSON.stringify(ManualServer, null, 2));
}

function DeleteManualServerFromDisk(): void {
  try {
    if (fs.existsSync(ManualServerPath)) fs.unlinkSync(ManualServerPath);
  } catch (Err) {
    Logger.error('Failed to remove ManualServer.json', Err);
  }
}

function AttachManualServer(Profile: ClientProfile): ClientProfile {
  const ManualServer = ReadManualServerFromDisk();
  return ManualServer ? { ...Profile, ManualServer } : Profile;
}

function StripLegacyManualServer(Profile: ClientProfile): ClientProfile {
  if (!Profile || !Profile.ManualServer) return Profile;
  const ManualServer = NormalizeManualServer(Profile.ManualServer.Host, Profile.ManualServer.Port);
  const SanitizedProfile: ClientProfile = { ...Profile };
  delete SanitizedProfile.ManualServer;
  WriteProfileFile(SanitizedProfile);
  if (ManualServer) {
    WriteManualServerToDisk(ManualServer);
    Logger.log('Migrated legacy manual server endpoint to ManualServer.json');
  }
  return SanitizedProfile;
}

function BuildIdentityBlock(Identity: ResolvedIdentity): ProfileIdentity {
  return {
    Version: 1,
    Source: Identity.Source,
    Witness: Identity.Witness,
    ResolvedAt: Date.now(),
  };
}

// Decide whether the cached UUID still belongs to THIS machine.
//
// A cached UUID alone cannot be trusted: a Clonezilla image carries the source
// machine's Profile.json, so the clone would happily reuse its identity. We
// therefore also store the evidence ("Witness") the UUID was derived from and
// re-check it against live hardware on every boot.
//
// Returns the profile, rewritten only when the identity actually changed.
async function ReconcileIdentity(Profile: ClientProfile): Promise<ClientProfile> {
  const Live = await HardwareIdentityManager.Resolve();
  const Cached = Profile.Identity;

  // Never destroy a working identity because a probe hiccuped.
  if (Live.Source === 'random' && Cached && Profile.UUID) {
    Logger.warn('Could not resolve hardware identity this boot; keeping the cached UUID.');
    return Profile;
  }

  // Legacy profile (pre-hardware-identity). Adopt the hardware UUID. The client
  // will present as unknown to the server, which replies Unadopt, and main.ts
  // drops it back into the pending-adoption list. That one-time re-adopt is the
  // intended migration -- do not pre-empt it by clearing Adopted here.
  if (!Cached || !Cached.Source) {
    Logger.warn(
      `Migrating legacy profile to a hardware-derived UUID (${Profile.UUID} -> ${Live.UUID}). ` +
        'This client will need to be re-adopted once.'
    );
    const Migrated = { ...Profile, UUID: Live.UUID, Identity: BuildIdentityBlock(Live) };
    WriteProfileFile(Migrated);
    return Migrated;
  }

  // A machine that gains firmware access (e.g. a Linux client later run as
  // root) should graduate to the stronger source, once.
  if (Cached.Source === 'mac' && Live.Source === 'firmware') {
    Logger.warn('Firmware machine id is now readable; upgrading identity from MAC to firmware.');
    const Upgraded = { ...Profile, UUID: Live.UUID, Identity: BuildIdentityBlock(Live) };
    WriteProfileFile(Upgraded);
    return Upgraded;
  }

  if (Cached.Source === 'firmware' && Live.Source === 'firmware') {
    if (Cached.Witness === Live.Witness && Profile.UUID === Live.UUID) return Profile;
    Logger.warn(
      'Firmware machine id differs from the one this profile was built on ' +
        '(disk clone or motherboard swap); re-deriving identity.'
    );
    const Rederived = { ...Profile, UUID: Live.UUID, Identity: BuildIdentityBlock(Live) };
    WriteProfileFile(Rederived);
    return Rederived;
  }

  if (Cached.Source === 'mac' && Live.Source === 'mac') {
    const CachedMacs = ParseMacWitness(Cached.Witness);
    const LiveMacs = ParseMacWitness(Live.Witness);
    const Overlap = LiveMacs.some((Mac) => CachedMacs.includes(Mac));

    // Any shared NIC means this is still the same machine -- a dock or USB NIC
    // was just added or removed. Re-deriving on every set change would make the
    // client unadopt itself whenever someone plugged in a dock, so we keep the
    // UUID and refresh the witness. A clone shares no NIC with its source, so
    // it still falls through to re-derivation below.
    if (Overlap) {
      if (Cached.Witness !== Live.Witness) {
        Logger.log(
          'Physical MAC set changed but still overlaps; keeping UUID, refreshing witness.'
        );
        const Refreshed = { ...Profile, Identity: BuildIdentityBlock(Live) };
        WriteProfileFile(Refreshed);
        return Refreshed;
      }
      return Profile;
    }

    Logger.warn(
      'No overlap with the MAC set this profile was built on (disk clone or NIC swap); ' +
        're-deriving identity.'
    );
    const Rederived = { ...Profile, UUID: Live.UUID, Identity: BuildIdentityBlock(Live) };
    WriteProfileFile(Rederived);
    return Rederived;
  }

  // Firmware -> MAC (firmware became unreadable), or anything else unexpected.
  // Keep the cached UUID rather than churn identity on a degraded probe.
  if (Cached.Source === 'firmware' && Live.Source !== 'firmware') {
    Logger.warn('Firmware machine id is no longer readable; keeping the cached UUID.');
    return Profile;
  }

  return Profile;
}

export const Manager = {
  async GetProfile(): Promise<ResolvedClientProfile> {
    AppDataManager.Initialize();
    if (!fs.existsSync(ProfilePath)) {
      Logger.log('Profile.json does not exist.');
      const Identity = await HardwareIdentityManager.Resolve();
      const NewProfile: ClientProfile = {
        UUID: Identity.UUID,
        Adopted: false,
        Identity: BuildIdentityBlock(Identity),
      };
      WriteProfileFile(NewProfile);
      BroadcastManager.emit('ProfileUpdated', NewProfile);
      Logger.log('Default Profile.json created.');
    }

    let Profile: ClientProfile | null;
    try {
      Profile = JSON.parse(fs.readFileSync(ProfilePath, 'utf-8'));
    } catch (Err) {
      // A truncated/corrupt profile used to throw straight out of GetProfile and
      // take the app down with it.
      Logger.error('Profile.json is unreadable; resetting it.', Err);
      Profile = null;
    }

    if (!Profile || !Profile.UUID || !Profile.UUID.length) {
      await Manager.ForceResetProfile();
      Profile = JSON.parse(fs.readFileSync(ProfilePath, 'utf-8')) as ClientProfile;
    }

    Profile = await ReconcileIdentity(Profile);
    Profile = StripLegacyManualServer(Profile);
    Logger.log('Profile Generated');
    // The self-heal above (ForceResetProfile + re-read) guarantees a UUID, which
    // ClientProfile cannot express because raw Profile.json may lack one.
    return AttachManualServer(Profile) as ResolvedClientProfile;
  },

  // Resolves back to this machine's own hardware identity, so a reset is
  // idempotent w.r.t. the UUID. A reset must not orphan the client on the server.
  async ForceResetProfile(): Promise<void> {
    const Identity = await HardwareIdentityManager.Resolve();
    const NewProfile: ClientProfile = {
      UUID: Identity.UUID,
      Adopted: false,
      Identity: BuildIdentityBlock(Identity),
    };
    WriteProfileFile(NewProfile);
    DeleteManualServerFromDisk();
    Logger.log('Profile.json overwritten');
  },

  async Adopt(
    IP: string,
    Port: number,
    Options: { ServerIdentity?: string | null } = {}
  ): Promise<void> {
    const Profile = await Manager.GetProfile();
    const ServerIdentity = ReadIdentityToken(Options) || null;

    const NewProfile: ClientProfile = {
      UUID: Profile.UUID,
      Adopted: true,
      ...(ServerIdentity ? { ServerIdentityLock: ServerIdentity } : {}),
      Server: {
        IP: IP,
        Port: Port,
        AdoptionTime: Date.now(),
        ...(ServerIdentity ? { ServerIdentity } : {}),
      },
    };
    const Written = WriteProfile(NewProfile, Profile);
    Logger.log('Profile updated with adoption details.');
    BroadcastManager.emit('ProfileUpdated', AttachManualServer(Written));
    return;
  },

  async UpdateServerEndpoint(IP: string, Port: number): Promise<void> {
    const Profile = await Manager.GetProfile();
    if (!Profile || !Profile.Adopted || !Profile.Server) {
      return;
    }

    const CurrentIP = Profile.Server.IP;
    const CurrentPort = Profile.Server.Port;
    if (CurrentIP === IP && CurrentPort === Port) {
      return;
    }

    const NewProfile: ClientProfile = {
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

    const Written = WriteProfile(NewProfile, Profile);
    Logger.log(`Profile server endpoint updated to ${IP}:${Port}`);
    BroadcastManager.emit('ProfileUpdated', AttachManualServer(Written));
  },

  async ResetAdoption(): Promise<void> {
    const Profile = await Manager.GetProfile();
    const ExistingServerIdentity =
      Profile &&
      Profile.Server &&
      typeof Profile.Server.ServerIdentity === 'string' &&
      Profile.Server.ServerIdentity.trim()
        ? Profile.Server.ServerIdentity.trim()
        : Profile &&
            typeof Profile.ServerIdentityLock === 'string' &&
            Profile.ServerIdentityLock.trim()
          ? Profile.ServerIdentityLock.trim()
          : null;
    const NewProfile: ClientProfile = {
      UUID: Profile.UUID,
      Adopted: false,
      ...(ExistingServerIdentity ? { ServerIdentityLock: ExistingServerIdentity } : {}),
    };
    const Written = WriteProfile(NewProfile, Profile);
    Logger.log('Reset adoption state to pending.');
    BroadcastManager.emit('ProfileUpdated', AttachManualServer(Written));
    return;
  },

  // Persist an operator-defined server endpoint. Bypasses mDNS discovery so the
  // agent can adopt against / recover to a server on a different VLAN/subnet.
  async SetManualServer(Host: unknown, Port: unknown): Promise<ManualServer> {
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
  },

  // Remove the operator-defined server endpoint and fall back to mDNS discovery.
  async ClearManualServer(): Promise<void> {
    const Profile = await Manager.GetProfile();
    if (!Profile.ManualServer) return;
    DeleteManualServerFromDisk();
    const NewProfile: ClientProfile = { ...Profile };
    delete NewProfile.ManualServer;
    Logger.log('Manual server endpoint cleared; reverting to automatic discovery.');
    BroadcastManager.emit('ProfileUpdated', NewProfile);
    return;
  },

  // Return the sanitized manual server endpoint, or null when not configured.
  async GetManualServer(): Promise<ManualServer | null> {
    return ReadManualServerFromDisk();
  },

  // Like ForceResetProfile, this returns the machine to its OWN hardware identity
  // rather than minting a fresh random one -- a factory reset should not orphan
  // the client on the server.
  async ResetProfileToFactoryDefaults(): Promise<void> {
    const Identity = await HardwareIdentityManager.Resolve();
    const NewProfile: ClientProfile = {
      UUID: Identity.UUID,
      Adopted: false,
      Identity: BuildIdentityBlock(Identity),
    };
    WriteProfileFile(NewProfile);
    DeleteManualServerFromDisk();
    Logger.log('Profile reset to factory defaults.');
    BroadcastManager.emit('ProfileUpdated', NewProfile);
    return;
  },
};
