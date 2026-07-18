// Behavioural tests for the clone/re-image guarantees.
//
// The requirement these encode:
//   - two machines cloned from one Clonezilla image must NOT share a UUID
//   - re-imaging a machine must give it back the SAME UUID
//   - routine hardware churn (docks, USB NICs) must NOT change the UUID

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks } = require('./test-helpers');

const profileManagerPath = path.join(
  __dirname,
  '..',
  'src',
  'Modules',
  'ProfileManager',
  'index.js'
);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Load ProfileManager with a stubbed hardware resolver representing the machine
// the client is currently booting on.
function loadProfileManager(profileRoot, identity) {
  return loadWithMocks(profileManagerPath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
    },
    '../AppData': {
      Manager: { Initialize: () => {}, GetProfileDirectory: () => profileRoot },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../HardwareIdentity': { Manager: { Resolve: async () => identity } },
  });
}

function seedProfile(profileRoot, profile) {
  fs.writeFileSync(path.join(profileRoot, 'Profile.json'), JSON.stringify(profile, null, 2));
}

function readProfile(profileRoot) {
  return JSON.parse(fs.readFileSync(path.join(profileRoot, 'Profile.json'), 'utf-8'));
}

const SOURCE_MACHINE = {
  UUID: 'uuid-source',
  Source: 'firmware',
  Witness: 'firmware-source',
};

test('cloned disk does not inherit the source machine identity', async () => {
  const profileRoot = tempDir('showtrak-clone-');
  // The image carries the SOURCE machine's profile verbatim.
  seedProfile(profileRoot, {
    UUID: 'uuid-source',
    Adopted: true,
    Identity: { Version: 1, Source: 'firmware', Witness: 'firmware-source', ResolvedAt: 1 },
    Server: { IP: '10.0.0.1', Port: 9000 },
  });

  // ...but it is booting on DIFFERENT hardware.
  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-clone',
    Source: 'firmware',
    Witness: 'firmware-clone',
  });

  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-clone');
  assert.notEqual(profile.UUID, 'uuid-source');
  assert.equal(profile.Identity.Witness, 'firmware-clone');
  assert.equal(readProfile(profileRoot).UUID, 'uuid-clone', 'must persist, not just return');
});

test('re-imaging the same machine restores the same UUID', async () => {
  const profileRoot = tempDir('showtrak-reimage-');
  // A freshly imaged machine has no profile at all.
  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);

  const profile = await Manager.GetProfile();

  // The UUID comes from firmware, so it is the same one this machine had before
  // the wipe -- the server still recognises it.
  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Identity.Source, 'firmware');
});

test('unchanged firmware keeps the cached UUID and does not rewrite the profile', async () => {
  const profileRoot = tempDir('showtrak-stable-');
  seedProfile(profileRoot, {
    UUID: 'uuid-source',
    Adopted: true,
    Identity: { Version: 1, Source: 'firmware', Witness: 'firmware-source', ResolvedAt: 1 },
  });

  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);
  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Adopted, true, 'a stable machine must stay adopted');
  assert.equal(
    readProfile(profileRoot).Identity.ResolvedAt,
    1,
    'should not rewrite when unchanged'
  );
});

test('legacy profile migrates to the hardware UUID and keeps adoption for the server to reject', async () => {
  const profileRoot = tempDir('showtrak-legacy-');
  seedProfile(profileRoot, {
    UUID: 'random-v4-from-old-build',
    Adopted: true,
    Server: { IP: '10.0.0.1', Port: 9000, ServerIdentity: 'server-a' },
  });

  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);
  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Identity.Source, 'firmware');
  // Adoption is deliberately left intact: the server replies Unadopt and the
  // existing recovery flow drops the client into the pending-adoption list.
  assert.equal(profile.Adopted, true);
  assert.equal(profile.Server.ServerIdentity, 'server-a');
});

test('adding a dock or USB NIC keeps the UUID stable and refreshes the witness', async () => {
  const profileRoot = tempDir('showtrak-dock-');
  seedProfile(profileRoot, {
    UUID: 'uuid-mac-derived',
    Adopted: true,
    Identity: { Version: 1, Source: 'mac', Witness: 'aaaaaaaaaaaa|bbbbbbbbbbbb', ResolvedAt: 1 },
  });

  // A dock added a third NIC; the original two are still present.
  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-would-be-different',
    Source: 'mac',
    Witness: 'aaaaaaaaaaaa|bbbbbbbbbbbb|cccccccccccc',
  });

  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-mac-derived', 'a dock must not re-identify the machine');
  assert.equal(profile.Adopted, true);
  assert.equal(profile.Identity.Witness, 'aaaaaaaaaaaa|bbbbbbbbbbbb|cccccccccccc');
});

test('disabling one NIC still keeps the UUID stable while any NIC overlaps', async () => {
  const profileRoot = tempDir('showtrak-nic-off-');
  seedProfile(profileRoot, {
    UUID: 'uuid-mac-derived',
    Adopted: true,
    Identity: { Version: 1, Source: 'mac', Witness: 'aaaaaaaaaaaa|bbbbbbbbbbbb', ResolvedAt: 1 },
  });

  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-would-be-different',
    Source: 'mac',
    Witness: 'aaaaaaaaaaaa',
  });

  const profile = await Manager.GetProfile();
  assert.equal(profile.UUID, 'uuid-mac-derived');
});

test('a MAC-derived clone shares no NIC and therefore re-derives', async () => {
  const profileRoot = tempDir('showtrak-mac-clone-');
  seedProfile(profileRoot, {
    UUID: 'uuid-source',
    Adopted: true,
    Identity: { Version: 1, Source: 'mac', Witness: 'aaaaaaaaaaaa|bbbbbbbbbbbb', ResolvedAt: 1 },
  });

  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-clone',
    Source: 'mac',
    Witness: 'dddddddddddd|eeeeeeeeeeee',
  });

  const profile = await Manager.GetProfile();
  assert.equal(profile.UUID, 'uuid-clone');
});

test('a client that gains firmware access upgrades from MAC once', async () => {
  const profileRoot = tempDir('showtrak-upgrade-');
  seedProfile(profileRoot, {
    UUID: 'uuid-mac-derived',
    Adopted: true,
    Identity: { Version: 1, Source: 'mac', Witness: 'aaaaaaaaaaaa', ResolvedAt: 1 },
  });

  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);
  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Identity.Source, 'firmware');
});

test('a failed probe never destroys an established identity', async () => {
  const profileRoot = tempDir('showtrak-probe-fail-');
  seedProfile(profileRoot, {
    UUID: 'uuid-source',
    Adopted: true,
    Identity: { Version: 1, Source: 'firmware', Witness: 'firmware-source', ResolvedAt: 1 },
  });

  // Probe wedged/failed this boot -> resolver returned a random identity.
  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-random-garbage',
    Source: 'random',
    Witness: null,
  });

  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-source', 'a transient probe failure must not re-identify');
  assert.equal(profile.Adopted, true);
});

test('firmware becoming unreadable keeps the cached UUID rather than dropping to MAC', async () => {
  const profileRoot = tempDir('showtrak-fw-lost-');
  seedProfile(profileRoot, {
    UUID: 'uuid-source',
    Adopted: true,
    Identity: { Version: 1, Source: 'firmware', Witness: 'firmware-source', ResolvedAt: 1 },
  });

  const { Manager } = loadProfileManager(profileRoot, {
    UUID: 'uuid-mac-derived',
    Source: 'mac',
    Witness: 'aaaaaaaaaaaa',
  });

  const profile = await Manager.GetProfile();
  assert.equal(profile.UUID, 'uuid-source');
});

test('Identity survives Adopt, UpdateServerEndpoint and ResetAdopption', async () => {
  const profileRoot = tempDir('showtrak-identity-persist-');
  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);

  await Manager.GetProfile();

  await Manager.Adopt('127.0.0.1', 9000, { ServerIdentity: 'server-a' });
  assert.equal(readProfile(profileRoot).Identity.Witness, 'firmware-source');

  await Manager.UpdateServerEndpoint('127.0.0.2', 9000);
  assert.equal(readProfile(profileRoot).Identity.Witness, 'firmware-source');

  await Manager.ResetAdopption();
  const afterReset = readProfile(profileRoot);
  assert.equal(afterReset.Identity.Witness, 'firmware-source');
  assert.equal(afterReset.UUID, 'uuid-source');
});

test('factory reset returns the machine to its own hardware identity', async () => {
  const profileRoot = tempDir('showtrak-factory-');
  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);

  await Manager.GetProfile();
  await Manager.Adopt('127.0.0.1', 9000, {});

  // A reset must not orphan the client on the server by minting a new UUID.
  await Manager.ResetProfileToFactoryDefaults();
  const profile = await Manager.GetProfile();

  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Adopted, false);
});

test('a corrupt Profile.json self-heals back to the same hardware UUID', async () => {
  const profileRoot = tempDir('showtrak-corrupt-');
  fs.writeFileSync(path.join(profileRoot, 'Profile.json'), '{"UUID": "uuid-sou');

  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);
  const profile = await Manager.GetProfile();

  // Previously this threw out of GetProfile and took the app down. Now it
  // recovers, and because the UUID is hardware-derived it recovers to the SAME
  // identity rather than orphaning the client.
  assert.equal(profile.UUID, 'uuid-source');
  assert.equal(profile.Identity.Source, 'firmware');
});

test('profile writes are atomic and leave no temp file behind', async () => {
  const profileRoot = tempDir('showtrak-atomic-');
  const { Manager } = loadProfileManager(profileRoot, SOURCE_MACHINE);

  await Manager.GetProfile();
  await Manager.Adopt('127.0.0.1', 9000, {});

  assert.equal(fs.existsSync(path.join(profileRoot, 'Profile.json.tmp')), false);
  assert.equal(readProfile(profileRoot).UUID, 'uuid-source');
});
