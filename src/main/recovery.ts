// Server-recovery state machine.
//
// When the socket to the adopted server dies, this is what decides whether an
// unattended client ever comes back. It is the highest-consequence logic in the
// client and, before this extraction, sat in the middle of a 1,600-line main.ts
// at ~50% coverage.
//
// Shape of a recovery attempt:
//
//   primary failed -> [cooldown gate] -> terminate socket -> [backoff wait] ->
//   find a candidate (manual endpoint, else mDNS constrained to the expected
//   ServerIdentity) -> connect -> wait for the connection to stabilise ->
//   persist the new endpoint
//
// Any failure short of the last step falls through to restartService(), which
// re-runs the normal boot decision rather than leaving the client wedged.
//
// TWO delay mechanisms deliberately overlap and are NOT redundant:
//   - RECOVERY_COOLDOWN_MS (15s) rate-limits how often an attempt may START, and
//     is measured from the last attempt.
//   - the exponential backoff (1s..10s) delays discovery WITHIN an attempt, so a
//     server that is rebooting gets progressively more time to come back.
// The backoff ceiling sits below the cooldown floor by design: the cooldown is
// the outer rate limit and the backoff only shapes the inside of one attempt.

import type { MainClientConnectionStatus, ServerAdoptionRejectedInfo } from '../types/client';
import type { ServerConnectFailedInfo } from '../types/client';

import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as MainClientManager } from '../Modules/MainClient';
import { Manager as ProfileManager } from '../Modules/ProfileManager';
import { ErrorMessage, ReadIdentityToken, Wait } from '../Modules/Utils';
import { discoverSingleServer, type ServerCandidate } from './discovery';
import { RECOVERY_COOLDOWN_MS, recoveryMetrics, sendRecoveryStatus } from './recovery-status';
import { isServiceReinitializing, restartService } from './service-lifecycle';

const Logger = CreateLogger('Recovery');

const RECOVERY_BACKOFF_BASE_MS = 1000;
const RECOVERY_BACKOFF_MAX_MS = 10000;

let recoveryInProgress = false;
let pendingRecoveryCandidate: ServerCandidate | null = null;
let recoveryRetryTimer: NodeJS.Timeout | null = null;
let recoveryRetryInfo: ServerConnectFailedInfo | null = null;

/** Outcome of waiting for a rediscovered server to accept this client. */
interface RecoveryValidation {
  ok: boolean;
  reason?: 'rejected' | 'timeout';
}

function isRecoveryInProgress(): boolean {
  return recoveryInProgress;
}

function getPendingRecoveryCandidate(): ServerCandidate | null {
  return pendingRecoveryCandidate;
}

function clearRecoveryRetryTimer(): void {
  if (recoveryRetryTimer) {
    clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = null;
  }
  recoveryRetryInfo = null;
}

// Record why an attempt failed, for the status panel.
function recordRecoveryFailure(Err: unknown): void {
  recoveryMetrics.LastFailureAt = Date.now();
  recoveryMetrics.LastFailureReason = ErrorMessage(Err, 'unknown_error');
}

function scheduleRecoveryRetry(waitMs: number, Info: ServerConnectFailedInfo): void {
  if (recoveryInProgress || isServiceReinitializing()) return;
  if (recoveryRetryTimer) return;
  const Delay = Math.max(0, Number(waitMs) || 0);
  recoveryRetryInfo = Info ?? null;
  recoveryRetryTimer = setTimeout(async () => {
    const pendingInfo = recoveryRetryInfo;
    clearRecoveryRetryTimer();
    if (recoveryInProgress || isServiceReinitializing()) return;
    // Unreachable in practice: clearRecoveryRetryTimer() nulls recoveryRetryInfo
    // and cancels this timer in the same call, so a fired callback always has
    // the info it was scheduled with. Kept to satisfy the compiler without
    // asserting non-null.
    if (!pendingInfo) return;
    try {
      await recoverFromPrimaryFailure(pendingInfo);
    } catch (Err) {
      recordRecoveryFailure(Err);
      Logger.error('Scheduled recovery flow failed', Err);
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'Unable to recover server connection automatically.',
      });
    }
  }, Delay);
}

// Entry point from the 'ServerConnectFailed' broadcast. Applies the cooldown gate
// and either starts an attempt or schedules one.
async function handlePrimaryFailure(Info: ServerConnectFailedInfo): Promise<void> {
  if (recoveryInProgress) return;

  clearRecoveryRetryTimer();

  const now = Date.now();
  const sinceLastAttempt = recoveryMetrics.LastAttemptAt
    ? now - recoveryMetrics.LastAttemptAt
    : Infinity;
  if (sinceLastAttempt < RECOVERY_COOLDOWN_MS) {
    const waitMs = RECOVERY_COOLDOWN_MS - sinceLastAttempt;
    sendRecoveryStatus({
      State: 'PrimaryFailed',
      Message: `Primary failed. Cooling down for ${Math.ceil(waitMs / 1000)}s before retry.`,
    });
    scheduleRecoveryRetry(waitMs, Info);
    return;
  }

  try {
    await recoverFromPrimaryFailure(Info);
  } catch (Err) {
    recordRecoveryFailure(Err);
    Logger.error('Recovery flow failed', Err);
    sendRecoveryStatus({
      State: 'RecoveryFailed',
      Message: 'Unable to recover server connection automatically.',
    });
  }
}

async function recoverFromPrimaryFailure(Info: ServerConnectFailedInfo): Promise<void> {
  clearRecoveryRetryTimer();
  recoveryMetrics.Attempts += 1;
  recoveryMetrics.LastAttemptAt = Date.now();
  recoveryInProgress = true;
  pendingRecoveryCandidate = null;

  const backoffDelay = Math.min(
    RECOVERY_BACKOFF_MAX_MS,
    RECOVERY_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, recoveryMetrics.Attempts - 1))
  );

  sendRecoveryStatus({
    State: 'PrimaryFailed',
    Message: `Primary server ${Info.IP || 'Unknown'}:${Info.Port || 'Unknown'} is unreachable. Retry attempt ${recoveryMetrics.Attempts}.`,
  });

  try {
    await MainClientManager.Terminate();
    if (backoffDelay > 0) {
      sendRecoveryStatus({
        State: 'PrimaryFailed',
        Message: `Waiting ${Math.ceil(backoffDelay / 1000)}s before discovery retry`,
      });
      await Wait(backoffDelay);
    }

    sendRecoveryStatus({
      State: 'Discovering',
      Message: 'Searching for Controlling Server on Local Network',
    });

    const Profile = await ProfileManager.GetProfile();
    const ExpectedServerIdentity = ReadIdentityToken(Profile && Profile.Server);

    // When an operator-defined endpoint is configured, recover against it
    // directly instead of relying on mDNS discovery (which cannot cross VLANs).
    const ManualServer = Profile && Profile.ManualServer ? Profile.ManualServer : null;
    let Candidate;
    if (ManualServer && ManualServer.Host && ManualServer.Port) {
      sendRecoveryStatus({
        State: 'ConnectingPrimary',
        Message: `Reconnecting to configured server ${ManualServer.Host}:${ManualServer.Port}`,
      });
      Candidate = {
        IP: ManualServer.Host,
        Port: ManualServer.Port,
        ServerIdentity: null,
      };
    } else {
      Candidate = await discoverSingleServer(12000, {
        ExpectedServerIdentity,
      });
    }
    if (!Candidate || !Candidate.IP || !Candidate.Port) {
      recoveryMetrics.LastFailureAt = Date.now();
      recoveryMetrics.LastFailureReason = 'discovery_no_candidate';
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'No server discovered for automatic recovery.',
      });
      await restartService('recovery-no-candidate');
      return;
    }

    pendingRecoveryCandidate = Candidate;
    sendRecoveryStatus({
      State: 'ValidatingIdentity',
      Message: `Validating discovered server at ${Candidate.IP}:${Candidate.Port}`,
    });

    await MainClientManager.Init(Profile.UUID, Candidate.IP, Candidate.Port);

    const Validation = await waitForRecoveryValidation(Candidate, 6000);
    if (!Validation.ok) {
      recoveryMetrics.LastFailureAt = Date.now();
      recoveryMetrics.LastFailureReason = Validation.reason || 'validation_failed';
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message:
          Validation.reason === 'rejected'
            ? 'Discovered server rejected adoption identity.'
            : 'Discovered server did not establish a stable connection.',
      });
      await restartService('recovery-validation-failed');
      return;
    }

    await ProfileManager.UpdateServerEndpoint(Candidate.IP, Candidate.Port);
    recoveryMetrics.Attempts = 0;
    recoveryMetrics.LastFailureAt = 0;
    recoveryMetrics.LastFailureReason = null;
    recoveryMetrics.LastRecoveredAt = Date.now();
    sendRecoveryStatus({
      State: 'Reconnected',
      Message: `Recovered connection to ${Candidate.IP}:${Candidate.Port}`,
    });
  } finally {
    recoveryInProgress = false;
    pendingRecoveryCandidate = null;
  }
}

// Wait for a freshly-connected candidate to prove itself: either it reports a
// stable connection, or it rejects us, or it goes quiet until the timeout.
//
// Both listeners filter on the candidate's IP+Port so a stray event from the old
// primary cannot satisfy (or fail) the validation for a different server.
async function waitForRecoveryValidation(
  Candidate: ServerCandidate,
  timeoutMs = 6000
): Promise<RecoveryValidation> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (Result: RecoveryValidation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      BroadcastManager.removeListener('ServerAdoptionRejected', onRejected);
      BroadcastManager.removeListener('MainClientConnectionStatus', onConnectionStatus);
      resolve(Result);
    };

    const onRejected = (Info: ServerAdoptionRejectedInfo) => {
      if (Info.IP === Candidate.IP && Number(Info.Port) === Number(Candidate.Port)) {
        finish({ ok: false, reason: 'rejected' });
      }
    };

    const onConnectionStatus = (Info: MainClientConnectionStatus) => {
      if (Info.IP !== Candidate.IP || Number(Info.Port) !== Number(Candidate.Port)) {
        return;
      }
      if (Info.State === 'connected') {
        finish({ ok: true });
      }
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    BroadcastManager.on('ServerAdoptionRejected', onRejected);
    BroadcastManager.on('MainClientConnectionStatus', onConnectionStatus);
  });
}

export {
  RECOVERY_BACKOFF_BASE_MS,
  RECOVERY_BACKOFF_MAX_MS,
  clearRecoveryRetryTimer,
  getPendingRecoveryCandidate,
  handlePrimaryFailure,
  isRecoveryInProgress,
  recoverFromPrimaryFailure,
  waitForRecoveryValidation,
};
export type { RecoveryValidation };
