// Recovery status: the last pushed payload, and the running metrics that
// decorate it.
//
// Split out from recovery.ts so it can be shared without a cycle. recovery.ts
// drives the state machine and mutates the metrics; service-lifecycle.ts pushes
// status during boot and adoption; ipc-handlers.ts reads the last payload to fill
// the config window's first frame. All three need this, none of them need each
// other.
//
// This is what the operator actually sees on a client PC, and often the only
// thing they see — so "what is the client doing about the server being gone" has
// to be answerable from here alone.

import type { ServerRecoveryStatus } from '../types/preload';
import { CreateLogger } from '../Modules/Logger';
import { PushToRenderer } from './renderer-bus';

const Logger = CreateLogger('Recovery');

const RECOVERY_COOLDOWN_MS = 15000;

/** Running totals shown in the recovery status panel. */
interface RecoveryMetrics {
  Attempts: number;
  LastAttemptAt: number;
  LastFailureAt: number;
  LastFailureReason: string | null;
  LastRecoveredAt: number;
}

// A shared mutable record rather than exported `let`s: the fields are written by
// recovery.ts and read here when decorating a status push, and an object keeps
// that sharing explicit and referentially stable across module boundaries.
const recoveryMetrics: RecoveryMetrics = {
  Attempts: 0,
  LastAttemptAt: 0,
  LastFailureAt: 0,
  LastFailureReason: null,
  LastRecoveredAt: 0,
};

let currentRecoveryStatus: ServerRecoveryStatus = { State: 'idle', Message: '' };

function getRecoveryStatus(): ServerRecoveryStatus {
  return currentRecoveryStatus;
}

// Record a status, decorate it with the current metrics, and push it to the
// config window (if one is open).
function sendRecoveryStatus(payload: ServerRecoveryStatus): void {
  const base = payload || { State: 'idle', Message: '' };
  currentRecoveryStatus = {
    ...base,
    Metrics: {
      Attempts: recoveryMetrics.Attempts,
      LastAttemptAt: recoveryMetrics.LastAttemptAt,
      LastFailureAt: recoveryMetrics.LastFailureAt,
      LastFailureReason: recoveryMetrics.LastFailureReason,
      LastRecoveredAt: recoveryMetrics.LastRecoveredAt,
      MaxAttempts: null,
      CooldownMs: RECOVERY_COOLDOWN_MS,
    },
  };
  Logger.log('[Recovery] Status event', currentRecoveryStatus);
  PushToRenderer('ServerRecoveryStatus', currentRecoveryStatus);
}

export { RECOVERY_COOLDOWN_MS, getRecoveryStatus, recoveryMetrics, sendRecoveryStatus };
export type { RecoveryMetrics };
