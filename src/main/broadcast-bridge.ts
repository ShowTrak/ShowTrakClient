// Broadcast bus -> main-process actions.
//
// Everything the socket layer and the monitors need the main process to DO
// arrives as a BroadcastManager event, and this is the single place those are
// wired to their handlers. Previously these ten subscriptions were scattered
// through main.ts between unrelated function definitions, which made it hard to
// see what the main process actually reacts to.
//
// Registered once, from main.ts. Deliberately registered at import-of-main time
// rather than inside whenReady: the socket layer can emit before the app is
// ready, and dropping a ServerConnectFailed would strand the client.

import type { ServerAdoptionRejectedInfo } from '../types/client';

import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as IdentifyOverlay } from '../Modules/IdentifyOverlay';
import { Manager as ProfileManager } from '../Modules/ProfileManager';
import { PushToRenderer } from './renderer-bus';
import { refreshTrayContextMenu } from './tray';
import { RunLaunchActions } from './launch-actions';
import { sendRecoveryStatus } from './recovery-status';
import {
  getPendingRecoveryCandidate,
  handlePrimaryFailure,
  isRecoveryInProgress,
} from './recovery';
import { restartService } from './service-lifecycle';
import { handleRemoteLanUpdateRequest, handleRemoteUpdateRequest } from './app-updater';

const Logger = CreateLogger('BroadcastBridge');

// A server rejecting our adoption is ambiguous, and the three branches below are
// the disambiguation:
//
//  1. A DIFFERENT server identity rejected us — ignore it and restart. On a
//     shared LAN, honouring this would let any other ShowTrak server unadopt our
//     clients.
//  2. The candidate we are mid-recovery against rejected us — let the recovery
//     state machine handle it (it is waiting on exactly this).
//  3. Our own server rejected us — genuinely unadopted; reset to pending.
async function onServerAdoptionRejected(Info: ServerAdoptionRejectedInfo): Promise<void> {
  const Profile = await ProfileManager.GetProfile();
  const ExpectedServerIdentity =
    Profile && Profile.Server && typeof Profile.Server.ServerIdentity === 'string'
      ? Profile.Server.ServerIdentity.trim()
      : '';
  const RejectedByIdentity =
    Info && typeof Info.ServerIdentity === 'string' ? Info.ServerIdentity.trim() : '';

  if (
    ExpectedServerIdentity &&
    RejectedByIdentity &&
    ExpectedServerIdentity !== RejectedByIdentity
  ) {
    sendRecoveryStatus({
      State: 'RecoveryFailed',
      Message: 'Ignoring adoption rejection from a different server identity.',
    });
    await restartService('server-identity-mismatch');
    return;
  }

  const Candidate = getPendingRecoveryCandidate();
  if (isRecoveryInProgress() && Candidate) {
    if (Candidate.IP === Info.IP && Number(Candidate.Port) === Number(Info.Port)) {
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'Discovered server rejected adoption identity.',
      });
      return;
    }
  }

  Logger.warn('Server rejected client adoption; resetting profile to pending adoption state.');
  await ProfileManager.ResetAdoption();
  await restartService('server-unadopt');
}

function registerBroadcastBridge(): void {
  BroadcastManager.on('ReinitializeService', async () => {
    await restartService('external-reinitialize');
  });

  // MainClient fires this once per launch after the first successful connection
  // (with scripts + auto-start settings already refreshed). RunLaunchActions is
  // self-guarded, so any accidental repeat is a no-op.
  BroadcastManager.on('RunLaunchAction', (Config) => {
    RunLaunchActions(Config);
  });

  BroadcastManager.on('ShowIdentifyOverlay', (Payload) => {
    try {
      IdentifyOverlay.Show(Payload);
    } catch (Err) {
      Logger.error('Failed to show identify overlay', Err);
    }
  });

  BroadcastManager.on('HideIdentifyOverlay', () => {
    try {
      IdentifyOverlay.Hide();
    } catch (Err) {
      Logger.error('Failed to hide identify overlay', Err);
    }
  });

  BroadcastManager.on('ServerConnectFailed', async (Info) => {
    await handlePrimaryFailure(Info);
  });

  BroadcastManager.on('ServerAdoptionRejected', async (Info) => {
    await onServerAdoptionRejected(Info);
  });

  BroadcastManager.on('MainClientConnectionStatus', (Info) => {
    if (!Info || Info.State !== 'connected') return;
    const Candidate = getPendingRecoveryCandidate();
    if (!isRecoveryInProgress() || !Candidate) {
      sendRecoveryStatus({ State: 'idle', Message: '' });
      return;
    }

    if (Candidate.IP === Info.IP && Number(Candidate.Port) === Number(Info.Port)) {
      // Keep explicit state during candidate validation window.
      sendRecoveryStatus({
        State: 'ValidatingIdentity',
        Message: `Validating discovered server at ${Info.IP}:${Info.Port}`,
      });
    }
  });

  BroadcastManager.on('ProfileUpdated', async (Profile) => {
    PushToRenderer('SetProfile', Profile);
  });

  BroadcastManager.on('ProcessMonitorStatus', async (Status) => {
    PushToRenderer('ProcessMonitorStatus', Status || { State: 'unknown' });
  });

  BroadcastManager.on('ScriptsUpdated', () => {
    refreshTrayContextMenu();
  });

  BroadcastManager.on('UpdateSoftware', async (Callback) => {
    await handleRemoteUpdateRequest(Callback);
  });

  BroadcastManager.on('UpdateSoftwareFromLAN', async (Payload, ProgressCallback, Callback) => {
    await handleRemoteLanUpdateRequest(Payload, ProgressCallback, Callback);
  });

  Logger.log('Broadcast bridge registered');
}

export { registerBroadcastBridge };
