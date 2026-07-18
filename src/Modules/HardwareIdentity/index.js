// Resolves this machine's durable identity.
//
// The client's UUID must survive re-imaging (same machine -> same UUID) while
// differing between two machines cloned from one image. That rules out any
// on-disk value; see ./fingerprint.js for the full reasoning.
//
// Resolution order:
//   1. Firmware (SMBIOS/DMI/IOPlatformUUID) - ideal, truly per-machine.
//   2. Physical MAC addresses          - survives imaging, lives in the NIC.
//   3. Random                          - last resort so we never crash-loop.

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('HardwareIdentity');

const { v4: uuidv4 } = require('uuid');

const { GetFirmwareId } = require('./probes');
const {
  IsTrustworthyFirmwareId,
  GetPhysicalMacs,
  DeriveUUID,
  MacWitness,
} = require('./fingerprint');

// Outer guard for a child process that ignores the execFile timeout/SIGTERM.
const RESOLVE_TIMEOUT_MS = 6000;

const Manager = {};

async function ResolveOnce() {
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
    UUID: uuidv4(),
    Source: 'random',
    Witness: null,
  };
}

// Identity derived without the firmware probe, for when it times out or throws.
function FallbackIdentity() {
  const Macs = GetPhysicalMacs();
  if (Macs.length) {
    const Witness = MacWitness(Macs);
    return { UUID: DeriveUUID('mac', Witness), Source: 'mac', Witness };
  }
  return { UUID: uuidv4(), Source: 'random', Witness: null };
}

async function ResolveGuarded(TimeoutMs = RESOLVE_TIMEOUT_MS) {
  let Identity;
  let Timer = null;

  try {
    // Outer cap in case a child process ignores execFile's own timeout/SIGTERM.
    // The timer is deliberately NOT unref'd -- it must be able to fire on its
    // own -- so it is always cleared below, including on the happy path.
    const Timeout = new Promise((resolve) => {
      Timer = setTimeout(() => {
        Logger.error('Hardware identity probe timed out; deriving without firmware.');
        resolve(FallbackIdentity());
      }, TimeoutMs);
    });

    Identity = await Promise.race([ResolveOnce(), Timeout]);
  } catch (Error) {
    Logger.error('Hardware identity resolution failed unexpectedly', Error);
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
let ResolutionPromise = null;

Manager.Resolve = async () => {
  if (!ResolutionPromise) ResolutionPromise = ResolveGuarded();
  return ResolutionPromise;
};

// Test seam only.
Manager._reset = () => {
  ResolutionPromise = null;
};

module.exports = {
  Manager,
  _internal: {
    ResolveOnce,
    ResolveGuarded,
    RESOLVE_TIMEOUT_MS,
  },
};
