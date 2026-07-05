const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const edidPath = path.join(__dirname, '..', 'src', 'Modules', 'DisplayMonitor', 'edid.js');
const identityPath = path.join(__dirname, '..', 'src', 'Modules', 'DisplayMonitor', 'identity.js');
const displayMonitorPath = path.join(
  __dirname,
  '..',
  'src',
  'Modules',
  'DisplayMonitor',
  'index.js'
);

const { parseEdid, fingerprintFromEdid } = require(edidPath);
const { matchDisplaysToIdentities } = require(identityPath);
const { _internal: DisplayMonitorInternal } = require(displayMonitorPath);

// Build a valid 128-byte EDID base block for tests.
function buildEdid({ manufacturerBytes, productCode, serial, nameText, serialText }) {
  const buf = Buffer.alloc(128, 0x00);
  // Header.
  buf[0] = 0x00;
  for (let i = 1; i <= 6; i += 1) buf[i] = 0xff;
  buf[7] = 0x00;
  // Manufacturer (bytes 8-9).
  buf[8] = manufacturerBytes[0];
  buf[9] = manufacturerBytes[1];
  // Product code little-endian (bytes 10-11).
  buf[10] = productCode & 0xff;
  buf[11] = (productCode >> 8) & 0xff;
  // Serial uint32 little-endian (bytes 12-15).
  buf[12] = serial & 0xff;
  buf[13] = (serial >> 8) & 0xff;
  buf[14] = (serial >> 16) & 0xff;
  buf[15] = (serial >> 24) & 0xff;
  buf[16] = 10; // week
  buf[17] = 34; // year offset -> 2024

  const writeDescriptor = (offset, type, text) => {
    buf[offset] = 0;
    buf[offset + 1] = 0;
    buf[offset + 2] = 0;
    buf[offset + 3] = type;
    buf[offset + 4] = 0;
    const body = Buffer.alloc(13, 0x20);
    const written = Buffer.from(text, 'latin1');
    written.copy(body, 0, 0, Math.min(written.length, 13));
    if (written.length < 13) body[written.length] = 0x0a; // terminator
    body.copy(buf, offset + 5);
  };
  if (serialText) writeDescriptor(54, 0xff, serialText);
  if (nameText) writeDescriptor(72, 0xfc, nameText);
  return buf;
}

test('parseEdid decodes manufacturer, product, serial, name', () => {
  // "GSM" -> value 0x1E6D.
  const edid = buildEdid({
    manufacturerBytes: [0x1e, 0x6d],
    productCode: 0x1234,
    serial: 0x01020304,
    nameText: 'Test Monitor',
    serialText: 'ABC123',
  });
  const parsed = parseEdid(edid);
  assert.equal(parsed.manufacturer, 'GSM');
  assert.equal(parsed.productCode, 0x1234);
  assert.equal(parsed.serial, 0x01020304);
  assert.equal(parsed.name, 'Test Monitor');
  assert.equal(parsed.serialString, 'ABC123');
  assert.equal(parsed.yearOfManufacture, 2024);
});

test('parseEdid rejects invalid headers and short buffers', () => {
  assert.equal(parseEdid(Buffer.alloc(10)), null);
  const bad = Buffer.alloc(128, 0x11);
  assert.equal(parseEdid(bad), null);
});

test('parseEdid accepts hex string input', () => {
  const edid = buildEdid({
    manufacturerBytes: [0x1e, 0x6d],
    productCode: 100,
    serial: 5,
    nameText: 'HexMon',
  });
  const parsed = parseEdid(edid.toString('hex'));
  assert.equal(parsed.manufacturer, 'GSM');
  assert.equal(parsed.name, 'HexMon');
});

test('fingerprintFromEdid prefers serial string and is stable', () => {
  const withString = fingerprintFromEdid({
    manufacturer: 'DEL',
    productCode: 4660,
    serial: 999,
    serialString: 'CN-0X1',
  });
  assert.equal(withString, 'edid:DEL:4660:CN-0X1');

  const numericOnly = fingerprintFromEdid({
    manufacturer: 'DEL',
    productCode: 4660,
    serial: 999,
    serialString: null,
  });
  assert.equal(numericOnly, 'edid:DEL:4660:999');

  // Not enough info -> null.
  assert.equal(fingerprintFromEdid({ manufacturer: '', productCode: null }), null);
  assert.equal(fingerprintFromEdid(null), null);
});

test('matchDisplaysToIdentities matches by primary flag then resolution', () => {
  const displays = [
    { SessionID: '1', Primary: true, Width: 1920, Height: 1080, ScaleFactor: 1 },
    { SessionID: '2', Primary: false, Width: 2560, Height: 1440, ScaleFactor: 1 },
  ];
  const identities = [
    { Fingerprint: 'edid:B', Width: 2560, Height: 1440 },
    { Fingerprint: 'edid:A', Primary: true },
  ];
  const matches = matchDisplaysToIdentities(displays, identities);
  assert.equal(matches.get('1').Fingerprint, 'edid:A');
  assert.equal(matches.get('2').Fingerprint, 'edid:B');
});

test('matchDisplaysToIdentities honors HiDPI scale factor when matching resolution', () => {
  const displays = [
    // Logical 1920x1080 @2x == physical 3840x2160.
    { SessionID: '10', Primary: false, Width: 1920, Height: 1080, ScaleFactor: 2 },
  ];
  const identities = [{ Fingerprint: 'edid:4K', Width: 3840, Height: 2160 }];
  const matches = matchDisplaysToIdentities(displays, identities);
  assert.equal(matches.get('10').Fingerprint, 'edid:4K');
});

test('matchDisplaysToIdentities falls back to order and tolerates extra/missing', () => {
  const displays = [
    { SessionID: 'a', Primary: false, Width: 1000, Height: 1000, ScaleFactor: 1 },
    { SessionID: 'b', Primary: false, Width: 1000, Height: 1000, ScaleFactor: 1 },
  ];
  // Same resolution -> not unique -> resolved by order.
  const identities = [{ Fingerprint: 'edid:first' }, { Fingerprint: 'edid:second' }];
  const matches = matchDisplaysToIdentities(displays, identities);
  assert.equal(matches.get('a').Fingerprint, 'edid:first');
  assert.equal(matches.get('b').Fingerprint, 'edid:second');

  // No identities -> empty map (caller keeps session fallback).
  assert.equal(matchDisplaysToIdentities(displays, []).size, 0);
});

test('ApplyStableIdentities assigns durable ids across all tiers', () => {
  const displays = [
    // Primary, no EDID serial available -> matched to EDID fingerprint identity.
    {
      SessionID: '1',
      Internal: true,
      Primary: true,
      Width: 1920,
      Height: 1080,
      ScaleFactor: 2,
      RefreshRate: 60,
      Label: null,
    },
    // External, matched by resolution to a port-only identity (no fingerprint).
    {
      SessionID: '2',
      Internal: false,
      Primary: false,
      Width: 2560,
      Height: 1440,
      ScaleFactor: 1,
      RefreshRate: 144,
      Label: null,
    },
    // Unmatched -> composite from resolution + refresh (external panel).
    {
      SessionID: '3',
      Internal: false,
      Primary: false,
      Width: 1280,
      Height: 720,
      ScaleFactor: 1,
      RefreshRate: 60,
      Label: null,
    },
  ];
  const identities = [
    { Fingerprint: 'edid:LGD:100:S1', Primary: true, Name: 'Laptop Panel' },
    { Fingerprint: null, ConnectorKey: 'linux:DP-1', Width: 2560, Height: 1440 },
  ];

  DisplayMonitorInternal.ApplyStableIdentities(displays, identities);

  // Tier 1: EDID fingerprint.
  assert.equal(displays[0].DisplayID, 'edid:LGD:100:S1');
  assert.equal(displays[0].IdentitySource, 'edid');
  assert.equal(displays[0].IsStableIdentity, true);
  assert.equal(displays[0].Label, 'Laptop Panel');

  // Tier 2: physical port/connector.
  assert.equal(displays[1].DisplayID, 'port:linux:DP-1');
  assert.equal(displays[1].IdentitySource, 'port');
  assert.equal(displays[1].IsStableIdentity, true);

  // Tier 3: composite from resolution + refresh (still reboot-stable).
  assert.equal(displays[2].DisplayID, 'attr:::1280x720@60:e');
  assert.equal(displays[2].IdentitySource, 'attributes');
  assert.equal(displays[2].IsStableIdentity, true);
});
