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

// Unadopted discovery retry. One 12s mDNS search is not enough for an
// unattended client: if the server is booting, on the far side of a flapping
// switch, or simply started after this machine, the client used to give up for
// good. It now searches again on a backoff until something is found or the
// service is restarted/stopped.
//
// This is deliberately separate from recovery.ts's retry: that one recovers an
// ADOPTED client against a known server identity and is driven by
// ServerConnectFailed, and importing it here would also break the one-way
// dependency described above.
const DISCOVERY_RETRY_BASE_MS = 5000;
const DISCOVERY_RETRY_MAX_MS = 30000;

let discoveryRetryTimer: NodeJS.Timeout | null = null;
let discoveryRetryAttempts = 0;

// Bumped by every restart, stop and boot. A discovery still in flight from an
// older boot compares its captured value against this when it returns, so it
// cannot start an adoption or schedule a retry on behalf of a service that has
// since moved on.
let bootGeneration = 0;

// Set once the app is quitting; nothing may boot or retry after that.
let serviceStopped = false;

// Guards against overlapping restarts. Also read by recovery.ts, which must not
// schedule a retry into the middle of one.
let isReinitializing = false;

function isServiceReinitializing(): boolean {
  return isReinitializing;
}

function cancelDiscoveryRetry(): void {
  if (discoveryRetryTimer) {
    clearTimeout(discoveryRetryTimer);
    discoveryRetryTimer = null;
  }
}

// Invalidate any boot in progress: its pending retry is cancelled and any
// discovery it is still waiting on will be ignored when it returns.
function invalidateBoot(): number {
  cancelDiscoveryRetry();
  bootGeneration += 1;
  return bootGeneration;
}

function scheduleDiscoveryRetry(Generation: number): void {
  if (serviceStopped || Generation !== bootGeneration) return;
  cancelDiscoveryRetry();
  discoveryRetryAttempts += 1;
  const Delay = Math.min(
    DISCOVERY_RETRY_MAX_MS,
    DISCOVERY_RETRY_BASE_MS * Math.pow(2, discoveryRetryAttempts - 1)
  );
  sendRecoveryStatus({
    State: 'Discovering',
    Message: `No ShowTrak Server found. Retrying in ${Math.ceil(Delay / 1000)}s…`,
  });
  Logger.log(`No server discovered; retry ${discoveryRetryAttempts} in ${Delay}ms`);
  discoveryRetryTimer = setTimeout(() => {
    discoveryRetryTimer = null;
    if (serviceStopped || Generation !== bootGeneration || isReinitializing) return;
    // Re-run the whole boot decision rather than just the search, so a profile
    // that changed in the meantime (adopted, or given a manual endpoint) is
    // honoured.
    Main().catch((Err) => {
      Logger.error('Discovery retry failed', Err);
    });
  }, Delay);
  // Never hold the process open just to search again.
  if (typeof discoveryRetryTimer.unref === 'function') discoveryRetryTimer.unref();
}

// Stop the service for good: called on app quit. Cancels any pending discovery
// retry and makes sure no in-flight boot or later restart starts anything new.
function stopService(): void {
  serviceStopped = true;
  invalidateBoot();
  discoveryRetryAttempts = 0;
}

async function restartService(reason: string): Promise<void> {
  if (serviceStopped) {
    Logger.warn(`restartService ignored after the service was stopped (${reason})`);
    return;
  }
  if (isReinitializing) {
    Logger.warn(`restartService ignored while already running (${reason})`);
    return;
  }
  isReinitializing = true;
  // A restart is a fresh start: drop any pending discovery retry and its
  // backoff, and disown a discovery the previous boot is still waiting on.
  invalidateBoot();
  discoveryRetryAttempts = 0;
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
    Message: `Connecting to saved server ${Server.IP}:${Server.Port}…`,
  });
  Logger.log(`Attempting connection to ${Server.IP}:${Server.Port}`);
  await MainClientManager.Init(Profile.UUID, Server.IP, Server.Port);
}

async function Main(): Promise<void> {
  if (serviceStopped) return;
  const Generation = invalidateBoot();
  const Profile = await ProfileManager.GetProfile();
  if (Generation !== bootGeneration) return;
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
        Message: `Connecting to configured server ${ManualServer.Host}:${ManualServer.Port} for adoption…`,
      });
      await AdoptionClientManager.Init(Profile.UUID, ManualServer.Host, ManualServer.Port, {
        ServerIdentity: null,
      });
      return;
    }

    sendRecoveryStatus({
      State: 'Discovering',
      Message: 'Searching for ShowTrak Server for adoption…',
    });

    const Candidate = await discoverSingleServer(12000);
    // The service was restarted or stopped while we searched; whatever replaced
    // this boot owns what happens next.
    if (Generation !== bootGeneration) return;
    if (!Candidate || !Candidate.IP || !Candidate.Port) {
      scheduleDiscoveryRetry(Generation);
      return;
    }

    discoveryRetryAttempts = 0;
    await AdoptionClientManager.Init(Profile.UUID, Candidate.IP, Candidate.Port, {
      ServerIdentity: Candidate.ServerIdentity || null,
    });
  }
}

export {
  BootWithStoredSettings,
  DISCOVERY_RETRY_BASE_MS,
  DISCOVERY_RETRY_MAX_MS,
  Main,
  isServiceReinitializing,
  restartService,
  stopService,
};
