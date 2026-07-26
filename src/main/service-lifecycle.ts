// Service boot and restart.
//
// `Main()` is the client's entry decision: adopted profile -> connect to the
// stored endpoint; unadopted -> advertise for adoption, preferring a manually
// configured endpoint over mDNS. `restartService()` tears the socket layer down
// and re-runs that decision, and is the single recovery lever every other module
// pulls (IPC handlers after a profile change, the broadcast bridge on an external
// reinitialize, and the recovery state machine when a candidate does not work
// out).
//
// Nothing here calls into recovery.ts, which is what keeps the dependency
// one-way: recovery.ts imports restartService, not the reverse.

import { CreateLogger } from '../Modules/Logger';
import { Manager as AdoptionClientManager } from '../Modules/AdoptionClient';
import { Manager as BonjourManager } from '../Modules/Bonjour';
import { Manager as MainClientManager } from '../Modules/MainClient';
import { Manager as ProfileManager } from '../Modules/ProfileManager';
import { discoverSingleServer } from './discovery';
import { sendRecoveryStatus } from './recovery-status';

const Logger = CreateLogger('ServiceLifecycle');

// Guards against overlapping restarts. Also read by recovery.ts, which must not
// schedule a retry into the middle of one.
let isReinitializing = false;

function isServiceReinitializing(): boolean {
  return isReinitializing;
}

async function restartService(reason: string): Promise<void> {
  if (isReinitializing) {
    Logger.warn(`restartService ignored while already running (${reason})`);
    return;
  }
  isReinitializing = true;
  try {
    try {
      await BonjourManager.Stop();
    } catch (Err) {
      Logger.debug('Bonjour stop failed during restart', String(Err));
    }
    await AdoptionClientManager.Terminate();
    await MainClientManager.Terminate();
    await Main();
  } finally {
    isReinitializing = false;
  }
}

async function BootWithStoredSettings(): Promise<void> {
  const Profile = await ProfileManager.GetProfile();
  // Main() only reaches here once it has verified Adopted + Server.IP + Port,
  // so this is a restatement of that precondition rather than a new code path.
  const Server = Profile.Server;
  if (!Server || !Server.IP || !Server.Port) {
    Logger.error('BootWithStoredSettings called without a stored server endpoint; ignoring.');
    return;
  }
  sendRecoveryStatus({
    State: 'ConnectingPrimary',
    Message: `Connecting to saved server ${Server.IP}:${Server.Port}`,
  });
  Logger.log(`Attempting connection to ${Server.IP}:${Server.Port}`);
  await MainClientManager.Init(Profile.UUID, Server.IP, Server.Port);
}

async function Main(): Promise<void> {
  const Profile = await ProfileManager.GetProfile();
  if (Profile.Adopted && Profile.Server && Profile.Server.IP && Profile.Server.Port) {
    Logger.log('Profile loaded [Adopted]');
    await BootWithStoredSettings();
  } else {
    Logger.log('Profile loaded [Unadopted]');

    // Prefer an operator-defined endpoint so adoption works across VLANs where
    // mDNS/Bonjour multicast cannot reach the server.
    const ManualServer = Profile.ManualServer || null;
    if (ManualServer && ManualServer.Host && ManualServer.Port) {
      sendRecoveryStatus({
        State: 'ConnectingPrimary',
        Message: `Connecting to configured server ${ManualServer.Host}:${ManualServer.Port} for adoption...`,
      });
      await AdoptionClientManager.Init(Profile.UUID, ManualServer.Host, ManualServer.Port, {
        ServerIdentity: null,
      });
      return;
    }

    sendRecoveryStatus({
      State: 'Discovering',
      Message: 'Searching for ShowTrak Server for adoption...',
    });

    const Candidate = await discoverSingleServer(12000);
    if (!Candidate || !Candidate.IP || !Candidate.Port) {
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'No ShowTrak Server discovered for adoption.',
      });
      return;
    }

    await AdoptionClientManager.Init(Profile.UUID, Candidate.IP, Candidate.Port, {
      ServerIdentity: Candidate.ServerIdentity || null,
    });
  }
}

export { BootWithStoredSettings, Main, isServiceReinitializing, restartService };
