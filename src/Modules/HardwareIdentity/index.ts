// Resolves this machine's durable identity.
//
// The client's UUID must survive re-imaging (same machine -> same UUID) while
// differing between two machines cloned from one image. That rules out any
// on-disk value; see ./fingerprint.ts for the full reasoning.
//
// Resolution order:
//   1. Firmware (SMBIOS/DMI/IOPlatformUUID) - ideal, truly per-machine.
//   2. Physical MAC addresses          - survives imaging, lives in the NIC.
//   3. Random                          - last resort so we never crash-loop.

// randomUUID is Node's own RFC 4122 v4 generator — the `uuid` package is still
// a dependency here, but only for v5 (namespaced, deterministic), which node:crypto
// has no equivalent for. See ./fingerprint.
import { randomUUID } from 'crypto';

import type { ResolvedIdentity } from '../../types/client';
import { CreateLogger } from '../Logger';
import { GetFirmwareId } from './probes';
import { IsTrustworthyFirmwareId, GetPhysicalMacs, DeriveUUID, MacWitness } from './fingerprint';

const Logger = CreateLogger('HardwareIdentity');

// Outer guard for a child process that ignores the execFile timeout/SIGTERM.
const RESOLVE_TIMEOUT_MS = 6000;

async function ResolveOnce(): Promise<ResolvedIdentity> {
  const FirmwareId = await GetFirmwareId();

  if (FirmwareId && IsTrustworthyFirmwareId(FirmwareId)) {
    const Witness = FirmwareId.trim().toLowerCase();
    return {
      UUID: DeriveUUID('firmware', Witness),
      Source: 'firmware',
      Witness,
    };
  }

  if (FirmwareId) {
    Logger.warn(
      `Firmware reported an untrustworthy machine id (${FirmwareId.trim()}); falling back to MAC.`
    );
  }

  const Macs = GetPhysicalMacs();
  if (Macs.length) {
    const Witness = MacWitness(Macs);
    return {
      UUID: DeriveUUID('mac', Witness),
      Source: 'mac',
      Witness,
    };
  }

  return {
    UUID: randomUUID(),
    Source: 'random',
    Witness: null,
  };
}

// Identity derived without the firmware probe, for when it times out or throws.
function FallbackIdentity(): ResolvedIdentity {
  const Macs = GetPhysicalMacs();
  if (Macs.length) {
    const Witness = MacWitness(Macs);
    return { UUID: DeriveUUID('mac', Witness), Source: 'mac', Witness };
  }
  return { UUID: randomUUID(), Source: 'random', Witness: null };
}

async function ResolveGuarded(TimeoutMs: number = RESOLVE_TIMEOUT_MS): Promise<ResolvedIdentity> {
  let Identity: ResolvedIdentity;
  let Timer: NodeJS.Timeout | null = null;

  try {
    // Outer cap in case a child process ignores execFile's own timeout/SIGTERM.
    // The timer is deliberately NOT unref'd -- it must be able to fire on its
    // own -- so it is always cleared below, including on the happy path.
    const Timeout = new Promise<ResolvedIdentity>((resolve) => {
      Timer = setTimeout(() => {
        Logger.error('Hardware identity probe timed out; deriving without firmware.');
        resolve(FallbackIdentity());
      }, TimeoutMs);
    });

    Identity = await Promise.race([ResolveOnce(), Timeout]);
  } catch (Err) {
    Logger.error('Hardware identity resolution failed unexpectedly', Err);
    Identity = FallbackIdentity();
  } finally {
    if (Timer) clearTimeout(Timer);
  }

  switch (Identity.Source) {
    case 'firmware':
      Logger.log(`Identity resolved from firmware machine id (${Identity.UUID}).`);
      break;
    case 'mac':
      Logger.warn(
        `No trustworthy firmware machine id; identity derived from ${
          Identity.Witness.split('|').length
        } physical MAC(s) (${Identity.UUID}).`
      );
      break;
    default:
      Logger.error(
        'No firmware id and no physical MAC available; identity is RANDOM and will not survive ' +
          're-imaging or disk cloning. This machine may collide with a clone.'
      );
      break;
  }

  return Identity;
}

// Memoized for the process lifetime: hardware does not change mid-session, and
// GetProfile() (the caller) runs on every reconnect and UI refresh, so an
// unmemoized probe would respawn PowerShell repeatedly.
let ResolutionPromise: Promise<ResolvedIdentity> | null = null;

export const Manager = {
  async Resolve(): Promise<ResolvedIdentity> {
    if (!ResolutionPromise) ResolutionPromise = ResolveGuarded();
    return ResolutionPromise;
  },

  // Test seam only.
  _reset(): void {
    ResolutionPromise = null;
  },
};

export const _internal = {
  ResolveOnce,
  ResolveGuarded,
  RESOLVE_TIMEOUT_MS,
};
