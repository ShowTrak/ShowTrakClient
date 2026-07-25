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

/** Identity fields decoded from an EDID base block. */
export interface EdidIdentity {
  manufacturer: string | null;
  productCode: number;
  serial: number | null;
  serialString: string | null;
  name: string | null;
  weekOfManufacture: number;
  yearOfManufacture: number;
}

const EDID_HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

export function toBuffer(input: unknown): Buffer | null {
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

export function decodeManufacturer(byte0: number, byte1: number): string | null {
  const value = ((byte0 & 0xff) << 8) | (byte1 & 0xff);
  const c1 = (value >> 10) & 0x1f;
  const c2 = (value >> 5) & 0x1f;
  const c3 = value & 0x1f;
  // 1 => 'A'. Any zero/out-of-range letter makes the ID invalid.
  if (c1 < 1 || c2 < 1 || c3 < 1) return null;
  return String.fromCharCode(64 + c1, 64 + c2, 64 + c3);
}

function cleanDescriptorText(buffer: Buffer, offset: number): string | null {
  // 13 bytes of ASCII, terminated by 0x0A and padded with 0x20.
  const raw = buffer.subarray(offset + 5, offset + 18).toString('latin1');
  const terminated = raw.split('\n')[0] ?? '';
  // Strip non-printable characters and trailing padding.
  return terminated.replace(/[^\x20-\x7e]/g, '').trim() || null;
}

// Parse a single 128-byte EDID base block. Returns null when the data is not a
// valid EDID (bad header). Extra blocks (extensions) are ignored.
export function parseEdid(input: unknown): EdidIdentity | null {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 128) return null;

  // Every read below is inside the verified 128-byte base block, so the
  // index can never be out of range; `at` satisfies noUncheckedIndexedAccess
  // without scattering non-null assertions through the parser.
  const at = (index: number): number => buffer[index] ?? 0;

  for (let i = 0; i < 8; i += 1) {
    if (at(i) !== EDID_HEADER[i]) return null;
  }

  const manufacturer = decodeManufacturer(at(8), at(9));
  const productCode = at(10) | (at(11) << 8);
  const serial = (at(12) | (at(13) << 8) | (at(14) << 16) | (at(15) << 24)) >>> 0;
  const weekOfManufacture = at(16);
  const yearOfManufacture = 1990 + at(17);

  let name: string | null = null;
  let serialString: string | null = null;
  for (const offset of [54, 72, 90, 108]) {
    // Detailed timing descriptors have a non-zero pixel clock in bytes 0-1;
    // monitor descriptors start with 00 00 00 <type>.
    if (at(offset) === 0 && at(offset + 1) === 0 && at(offset + 2) === 0) {
      const type = at(offset + 3);
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
export function fingerprintFromEdid(identity: EdidIdentity | null | undefined): string | null {
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
