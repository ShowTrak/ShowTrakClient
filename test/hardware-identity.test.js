const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

const fingerprintPath = path.join(
  __dirname,
  '..',
  'src',
  'Modules',
  'HardwareIdentity',
  'fingerprint.js'
);
const probesPath = path.join(__dirname, '..', 'src', 'Modules', 'HardwareIdentity', 'probes.js');

const {
  IsTrustworthyFirmwareId,
  NormalizeMac,
  SelectPhysicalMacs,
  DeriveUUID,
  MacWitness,
  ParseMacWitness,
} = require(fingerprintPath);

// The server validates the handshake UUID against this exact pattern
// (ShowTrakServer/src/Modules/Validation/primitives.ts). Asserting it here
// guards the client/server contract without a cross-repo import.
const SERVER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

test('IsTrustworthyFirmwareId rejects known-bogus firmware ids', () => {
  const bogus = [
    '00000000-0000-0000-0000-000000000000',
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    '03000200-0400-0500-0006-000700080009',
    '03020100-0504-0706-0809-0a0b0c0d0e0f',
    '00020003-0004-0005-0006-000700080009',
    '12345678-1234-5678-1234-567812345678',
    'Not Settable',
    'Default string',
    'To Be Filled By O.E.M.',
    'System Serial Number',
    'Unknown',
    'None',
    'N/A',
    '0',
    '',
    '   ',
  ];

  for (const value of bogus) {
    assert.equal(
      IsTrustworthyFirmwareId(value),
      false,
      `expected reject: ${JSON.stringify(value)}`
    );
  }
});

test('IsTrustworthyFirmwareId rejects malformed and non-string values', () => {
  for (const value of [null, undefined, 42, {}, [], 'not-a-uuid', 'deadbeef']) {
    assert.equal(IsTrustworthyFirmwareId(value), false);
  }
});

test('IsTrustworthyFirmwareId rejects low-entropy placeholders', () => {
  assert.equal(IsTrustworthyFirmwareId('11111111-1111-1111-1111-111111111111'), false);
  assert.equal(IsTrustworthyFirmwareId('00000000-0000-0000-0000-000000000001'), false);
});

test('IsTrustworthyFirmwareId accepts real vendor firmware ids', () => {
  // Dell encodes the service tag as 4C4C4544-*; it is legitimate and must not
  // be rejected by a naive vendor-prefix blocklist.
  assert.equal(IsTrustworthyFirmwareId('4C4C4544-0037-5710-8036-B7C04F564432'), true);
  // A real macOS IOPlatformUUID.
  assert.equal(IsTrustworthyFirmwareId('0855C949-4843-5BCC-B2D2-5F993C960C6E'), true);
  assert.equal(IsTrustworthyFirmwareId('  0855c949-4843-5bcc-b2d2-5f993c960c6e  '), true);
});

test('NormalizeMac normalizes and rejects unusable values', () => {
  assert.equal(NormalizeMac('AA:BB:CC:DD:EE:FF'), 'aabbccddeeff');
  assert.equal(NormalizeMac('aa-bb-cc-dd-ee-ff'), 'aabbccddeeff');
  assert.equal(NormalizeMac('00:00:00:00:00:00'), null);
  assert.equal(NormalizeMac('aa:bb:cc'), null);
  assert.equal(NormalizeMac(''), null);
  assert.equal(NormalizeMac(null), null);
});

test('SelectPhysicalMacs keeps physical NICs and sorts deterministically', () => {
  const interfaces = {
    en0: [{ mac: 'b8:e8:56:11:22:33', internal: false }],
    eth0: [{ mac: '3c:97:0e:aa:bb:cc', internal: false }],
  };

  assert.deepEqual(SelectPhysicalMacs(interfaces), ['3c970eaabbcc', 'b8e856112233']);

  // Enumeration order must not affect the result, or the UUID would flap.
  const reordered = { eth0: interfaces.eth0, en0: interfaces.en0 };
  assert.deepEqual(SelectPhysicalMacs(reordered), SelectPhysicalMacs(interfaces));
});

test('SelectPhysicalMacs excludes virtual, internal and randomized adapters', () => {
  const interfaces = {
    lo0: [{ mac: '00:00:00:00:00:00', internal: true }],
    en0: [{ mac: 'b8:e8:56:11:22:33', internal: false }],
    docker0: [{ mac: '02:42:ac:11:00:01', internal: false }],
    'vEthernet (Default Switch)': [{ mac: '00:15:5d:01:02:03', internal: false }],
    vmnet1: [{ mac: '00:50:56:c0:00:01', internal: false }],
    vboxnet0: [{ mac: '08:00:27:aa:bb:cc', internal: false }],
    utun3: [{ mac: 'aa:bb:cc:dd:ee:ff', internal: false }],
    // Locally-administered bit set (randomized Wi-Fi / QEMU) on a plain name.
    eth9: [{ mac: '52:54:00:12:34:56', internal: false }],
  };

  assert.deepEqual(SelectPhysicalMacs(interfaces), ['b8e856112233']);
});

test('SelectPhysicalMacs dedupes and tolerates junk input', () => {
  const interfaces = {
    en0: [
      { mac: 'b8:e8:56:11:22:33', internal: false },
      { mac: 'B8:E8:56:11:22:33', internal: false },
    ],
    en1: [{ mac: 'b8:e8:56:11:22:33', internal: false }],
  };
  assert.deepEqual(SelectPhysicalMacs(interfaces), ['b8e856112233']);

  assert.deepEqual(SelectPhysicalMacs({}), []);
  assert.deepEqual(SelectPhysicalMacs(null), []);
  assert.deepEqual(SelectPhysicalMacs({ en0: null }), []);
  assert.deepEqual(SelectPhysicalMacs({ en0: [null, { internal: false }] }), []);
});

test('DeriveUUID is deterministic and server-compatible', () => {
  const a = DeriveUUID('firmware', 'witness-value');
  const b = DeriveUUID('firmware', 'witness-value');

  assert.equal(a, b, 'same evidence must always yield the same UUID');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(a, SERVER_IDENTIFIER_PATTERN);
});

test('DeriveUUID separates sources so firmware and MAC evidence cannot collide', () => {
  assert.notEqual(DeriveUUID('firmware', 'same'), DeriveUUID('mac', 'same'));
  assert.notEqual(DeriveUUID('firmware', 'a'), DeriveUUID('firmware', 'b'));
});

test('MacWitness round-trips through ParseMacWitness', () => {
  const macs = ['3c970eaabbcc', 'b8e856112233'];
  assert.equal(MacWitness(macs), '3c970eaabbcc|b8e856112233');
  assert.deepEqual(ParseMacWitness(MacWitness(macs)), macs);
  assert.deepEqual(ParseMacWitness(''), []);
  assert.deepEqual(ParseMacWitness(null), []);
});

test('probes parse macOS ioreg output', () => {
  const { _internal } = require(probesPath);
  const stdout = [
    '+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000253, registered>',
    '    {',
    '      "IOPlatformSerialNumber" = "LY6XG66DN2"',
    '      "IOPlatformUUID" = "0855C949-4843-5BCC-B2D2-5F993C960C6E"',
    '    }',
  ].join('\n');

  assert.equal(_internal.parseMacUUID(stdout), '0855C949-4843-5BCC-B2D2-5F993C960C6E');
  assert.equal(_internal.parseMacUUID('no match here'), null);
  assert.equal(_internal.parseMacUUID(null), null);
});

test('probes parse Windows PowerShell output including trailing CRLF', () => {
  const { _internal } = require(probesPath);

  assert.equal(
    _internal.parseWindowsUUID('4C4C4544-0037-5710-8036-B7C04F564432\r\n'),
    '4C4C4544-0037-5710-8036-B7C04F564432'
  );
  assert.equal(_internal.parseWindowsUUID('   \r\n'), null);
  assert.equal(_internal.parseWindowsUUID(null), null);
});

test('probes return null when the platform command fails', async () => {
  const { _internal } = require(probesPath);
  const failingExec = async () => null;

  assert.equal(await _internal.getMacFirmwareId(failingExec), null);
  assert.equal(await _internal.getWindowsFirmwareId(failingExec), null);
});

test('Linux probe walks DMI paths and degrades when unreadable', () => {
  const { _internal } = require(probesPath);

  const readable = (p) => {
    if (p === '/sys/class/dmi/id/product_uuid') return 'dmi-uuid\n';
    throw new Error('ENOENT');
  };
  assert.equal(_internal.getLinuxFirmwareId(readable), 'dmi-uuid');

  // product_uuid is root-only; an unprivileged client falls through.
  const fallsThrough = (p) => {
    if (p === '/sys/class/dmi/id/board_serial') return 'board-serial\n';
    throw new Error('EACCES');
  };
  assert.equal(_internal.getLinuxFirmwareId(fallsThrough), 'board-serial');

  const allDenied = () => {
    throw new Error('EACCES');
  };
  assert.equal(_internal.getLinuxFirmwareId(allDenied), null);
});

function loadResolver(mocks) {
  return loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'HardwareIdentity', 'index.js'),
    {
      '../Logger': {
        CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
      },
      ...mocks,
    }
  );
}

test('resolver prefers firmware when it is trustworthy', async () => {
  const { Manager } = loadResolver({
    './probes': { GetFirmwareId: async () => '4C4C4544-0037-5710-8036-B7C04F564432' },
  });

  const identity = await Manager.Resolve();
  assert.equal(identity.Source, 'firmware');
  assert.equal(identity.Witness, '4c4c4544-0037-5710-8036-b7c04f564432');
  assert.equal(identity.UUID, DeriveUUID('firmware', '4c4c4544-0037-5710-8036-b7c04f564432'));
});

test('resolver falls back to MAC when firmware is bogus', async () => {
  const { Manager } = loadResolver({
    './probes': { GetFirmwareId: async () => '03000200-0400-0500-0006-000700080009' },
    './fingerprint': {
      ...require(fingerprintPath),
      GetPhysicalMacs: () => ['b8e856112233'],
    },
  });

  const identity = await Manager.Resolve();
  assert.equal(identity.Source, 'mac');
  assert.equal(identity.Witness, 'b8e856112233');
  assert.equal(identity.UUID, DeriveUUID('mac', 'b8e856112233'));
});

test('resolver falls back to random only when there is no firmware and no NIC', async () => {
  const { Manager } = loadResolver({
    './probes': { GetFirmwareId: async () => null },
    './fingerprint': { ...require(fingerprintPath), GetPhysicalMacs: () => [] },
  });

  const identity = await Manager.Resolve();
  assert.equal(identity.Source, 'random');
  assert.equal(identity.Witness, null);
  assert.match(identity.UUID, SERVER_IDENTIFIER_PATTERN);
});

test('resolver memoizes so repeated GetProfile calls do not respawn probes', async () => {
  let probeCalls = 0;
  const { Manager } = loadResolver({
    './probes': {
      GetFirmwareId: async () => {
        probeCalls += 1;
        return '4C4C4544-0037-5710-8036-B7C04F564432';
      },
    },
  });

  const first = await Manager.Resolve();
  const second = await Manager.Resolve();

  assert.equal(probeCalls, 1);
  assert.equal(first.UUID, second.UUID);
});

test('resolver settles even when a probe hangs forever', async () => {
  const { _internal } = loadResolver({
    './probes': { GetFirmwareId: () => new Promise(() => {}) },
    './fingerprint': {
      ...require(fingerprintPath),
      GetPhysicalMacs: () => ['b8e856112233'],
    },
  });

  // A wedged probe must never wedge boot: the cap fires and we derive from MAC.
  const identity = await _internal.ResolveGuarded(20);
  assert.equal(identity.Source, 'mac');
  assert.equal(identity.UUID, DeriveUUID('mac', 'b8e856112233'));
});

test('resolver timeout cap is bounded and fires without an active event loop', () => {
  const { _internal } = loadResolver({
    './probes': { GetFirmwareId: async () => null },
  });
  assert.ok(_internal.RESOLVE_TIMEOUT_MS > 0 && _internal.RESOLVE_TIMEOUT_MS <= 6000);
});
