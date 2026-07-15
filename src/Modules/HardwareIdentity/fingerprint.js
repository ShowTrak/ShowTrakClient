// Pure derivation logic for the client's hardware-bound identity.
//
// Machines are deployed by disk imaging (Clonezilla). Anything stored on disk
// is therefore cloned along with the image, which is why the identity CANNOT
// come from Profile.json, /etc/machine-id or the Windows registry MachineGuid
// (all of which node-machine-id reads). Only firmware (SMBIOS/DMI) and the
// NIC survive imaging while still differing between two physical machines.
//
// Everything in this file is pure: no I/O, no platform access. The probes live
// in ./probes.js so this logic stays directly unit-testable.

const os = require('node:os');
const { v5: uuidv5 } = require('uuid');

// Changing either of these re-derives a different UUID for EVERY client in
// EVERY fleet, silently unadopting all of them. They are effectively permanent.
// Rev VERSION only as a deliberate, announced migration.
const SHOWTRAK_IDENTITY_NAMESPACE_DO_NOT_CHANGE = '11c3a620-69eb-412a-a88d-8150fe4cc4f3';
const VERSION = 'v1';

// SMBIOS UUIDs that are real-looking but shipped identically across entire
// production batches, so they identify a model rather than a machine. Treating
// one as an identity would recreate the duplicate-ID bug on every unit.
const BOGUS_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  // AMI / EDK II reference defaults.
  '03000200-0400-0500-0006-000700080009',
  '03020100-0504-0706-0809-0a0b0c0d0e0f',
  '00020003-0004-0005-0006-000700080009',
  '12345678-1234-5678-1234-567812345678',
]);

// Vendors write these into the UUID field when the value was never programmed.
const BOGUS_STRINGS = new Set([
  'not settable',
  'not present',
  'not specified',
  'not applicable',
  'default string',
  'to be filled by o.e.m.',
  'to be filled by oem',
  'system serial number',
  'filled by oem',
  'oem',
  'unknown',
  'none',
  'n/a',
  'invalid',
  '0',
]);

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Virtual adapter OUIs. Bare-metal only deployment, so these are always noise.
const VIRTUAL_OUIS = [
  '000569', '000c29', '001c14', '005056', // VMware
  '080027', '0a0027', // VirtualBox
  '00155d', // Hyper-V
  '00163e', // Xen
  '001c42', // Parallels
  '020000', // QEMU/misc
];

const VIRTUAL_NAME_PATTERN =
  /^(lo|lo\d|docker|veth|br-|virbr|tun|tap|vmnet|vboxnet|utun|awdl|llw|bridge|zt|wg|ppp|vEthernet|VMware|VirtualBox|Bluetooth|TAP-|Npcap|Loopback|WAN Miniport|Teredo|isatap|Microsoft Wi-Fi Direct)/i;

// Reject a firmware id we cannot trust to be unique to this machine.
// Anything rejected here falls through to the MAC-derived identity.
function IsTrustworthyFirmwareId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (BOGUS_STRINGS.has(trimmed.toLowerCase())) return false;

  const normalized = trimmed.toLowerCase();
  if (!UUID_SHAPE.test(normalized)) return false;
  if (BOGUS_UUIDS.has(normalized)) return false;

  // A near-constant UUID (e.g. all 1s, or 0s with a stray digit) is a firmware
  // placeholder rather than a real identifier. Note this deliberately does NOT
  // reject by vendor prefix: Dell's 4C4C4544-* is a legitimate service-tag
  // encoding with plenty of entropy in the remaining nibbles.
  const nibbles = new Set(normalized.replace(/-/g, ''));
  if (nibbles.size <= 2) return false;

  return true;
}

// 'aa:bb:cc:dd:ee:ff' -> 'aabbccddeeff'. Returns null when unusable.
function NormalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const hex = mac.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  if (/^0+$/.test(hex)) return null;
  return hex;
}

function IsVirtualMac(hex) {
  const firstOctet = parseInt(hex.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return true;
  // Locally-administered bit: covers Docker 02:42:*, QEMU 52:54:00 and
  // Windows randomized Wi-Fi hardware addresses in a single check.
  if (firstOctet & 0x02) return true;
  // Multicast bit: never a real interface address.
  if (firstOctet & 0x01) return true;
  return VIRTUAL_OUIS.includes(hex.slice(0, 6));
}

// Pick the MACs that plausibly belong to soldered/physical NICs, sorted so the
// result is stable regardless of enumeration order.
// Accepts the shape of os.networkInterfaces().
function SelectPhysicalMacs(interfaces) {
  if (!interfaces || typeof interfaces !== 'object') return [];
  const found = new Set();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!Array.isArray(addresses)) continue;
    if (VIRTUAL_NAME_PATTERN.test(name)) continue;

    for (const address of addresses) {
      if (!address || address.internal) continue;
      const hex = NormalizeMac(address.mac);
      if (!hex) continue;
      if (IsVirtualMac(hex)) continue;
      found.add(hex);
    }
  }

  return Array.from(found).sort();
}

function GetPhysicalMacs() {
  try {
    return SelectPhysicalMacs(os.networkInterfaces());
  } catch (_error) {
    return [];
  }
}

// Derive the stable UUID. `source` is tagged into the name so that a firmware
// id and a MAC set that happen to share a string can never collide, and so a
// machine that gains firmware access later re-derives deliberately.
function DeriveUUID(source, evidence) {
  const name = `showtrak:${VERSION}:${source}:${evidence}`;
  return uuidv5(name, SHOWTRAK_IDENTITY_NAMESPACE_DO_NOT_CHANGE);
}

// The witness is the evidence we re-check on every boot to detect a clone.
function MacWitness(macs) {
  return macs.join('|');
}

function ParseMacWitness(witness) {
  if (typeof witness !== 'string' || !witness) return [];
  return witness.split('|').filter(Boolean);
}

module.exports = {
  IsTrustworthyFirmwareId,
  NormalizeMac,
  SelectPhysicalMacs,
  GetPhysicalMacs,
  DeriveUUID,
  MacWitness,
  ParseMacWitness,
  VERSION,
  _internal: {
    IsVirtualMac,
    BOGUS_UUIDS,
    BOGUS_STRINGS,
    SHOWTRAK_IDENTITY_NAMESPACE_DO_NOT_CHANGE,
  },
};
