// Minimal EDID (Extended Display Identification Data) parser.
//
// EDID is a 128-byte (base block) structure burned into every monitor. The
// fields we care about for a *reboot-stable* identity live in the base block:
//   - bytes 8-9   : manufacturer PnP ID (3 compressed ASCII letters)
//   - bytes 10-11 : product code (little-endian uint16)
//   - bytes 12-15 : serial number (uint32)
//   - descriptors : may contain a monitor NAME (0xFC) and/or a serial STRING
//                   (0xFF), which is preferred over the numeric serial.
//
// This identity does not change across reboots, driver updates, or OS upgrades
// because it is a property of the physical panel, not the running system.

const EDID_HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (Array.isArray(input)) return Buffer.from(input);
  if (typeof input === 'string') {
    const hex = input.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 2) return null;
    return Buffer.from(hex, 'hex');
  }
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

function decodeManufacturer(byte0, byte1) {
  const value = ((byte0 & 0xff) << 8) | (byte1 & 0xff);
  const c1 = (value >> 10) & 0x1f;
  const c2 = (value >> 5) & 0x1f;
  const c3 = value & 0x1f;
  // 1 => 'A'. Any zero/out-of-range letter makes the ID invalid.
  if (c1 < 1 || c2 < 1 || c3 < 1) return null;
  return String.fromCharCode(64 + c1, 64 + c2, 64 + c3);
}

function cleanDescriptorText(buffer, offset) {
  // 13 bytes of ASCII, terminated by 0x0A and padded with 0x20.
  const raw = buffer.slice(offset + 5, offset + 18).toString('latin1');
  const terminated = raw.split('\n')[0];
  // Strip non-printable characters and trailing padding.
  return terminated.replace(/[^\x20-\x7e]/g, '').trim() || null;
}

// Parse a single 128-byte EDID base block. Returns null when the data is not a
// valid EDID (bad header). Extra blocks (extensions) are ignored.
function parseEdid(input) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 128) return null;

  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== EDID_HEADER[i]) return null;
  }

  const manufacturer = decodeManufacturer(buffer[8], buffer[9]);
  const productCode = buffer[10] | (buffer[11] << 8);
  const serial = (buffer[12] | (buffer[13] << 8) | (buffer[14] << 16) | (buffer[15] << 24)) >>> 0;
  const weekOfManufacture = buffer[16];
  const yearOfManufacture = 1990 + buffer[17];

  let name = null;
  let serialString = null;
  for (const offset of [54, 72, 90, 108]) {
    // Detailed timing descriptors have a non-zero pixel clock in bytes 0-1;
    // monitor descriptors start with 00 00 00 <type>.
    if (buffer[offset] === 0 && buffer[offset + 1] === 0 && buffer[offset + 2] === 0) {
      const type = buffer[offset + 3];
      if (type === 0xfc) name = cleanDescriptorText(buffer, offset) || name;
      else if (type === 0xff) serialString = cleanDescriptorText(buffer, offset) || serialString;
    }
  }

  return {
    manufacturer,
    productCode,
    serial: serial || null,
    serialString,
    name,
    weekOfManufacture,
    yearOfManufacture,
  };
}

// Build a stable fingerprint string from parsed EDID identity fields. Returns
// null when there is not enough information to be meaningful (no manufacturer
// and no product code). Prefers the descriptor serial STRING over the numeric
// serial when present.
function fingerprintFromEdid(identity) {
  if (!identity) return null;
  const manufacturer = identity.manufacturer || '';
  const productCode = identity.productCode != null ? String(identity.productCode) : '';
  if (!manufacturer && !productCode) return null;
  const serial =
    identity.serialString && identity.serialString.length > 0
      ? identity.serialString
      : identity.serial
        ? String(identity.serial)
        : '';
  return `edid:${manufacturer}:${productCode}:${serial}`;
}

module.exports = {
  parseEdid,
  fingerprintFromEdid,
  decodeManufacturer,
  toBuffer,
};
