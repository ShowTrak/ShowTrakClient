// Windows Plug and Play state for USB devices — Device Manager's yellow bang.
//
// libusb (and so WebUSB) only lists devices it can open, and a device whose
// driver failed is exactly one it cannot: on its own the USB monitor would see a
// failed device simply vanish. Windows still enumerates it, with a problem code,
// so this reads every present USB device from Win32_PnPEntity and
//   - attaches its state to the matching WebUSB device, and
//   - lists a device in a problem state that WebUSB could not see at all, so the
//     server can say "it is plugged in, and broken" rather than "it is gone".
//
// Everything here is best effort: if the query fails, every device's state is
// null (unknown), which the server never treats as a fault.
//
// NOT VERIFIED ON REAL WINDOWS: the WQL filter, the JSON shape and the
// instance-ID parsing are written from the documented formats and covered by
// fixture tests only.
import type { USBDevice, USBDeviceState } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreatePowerShellHost } from '../ProcessMonitor/powershell-host';
import { RunCommand } from '../AudioMonitor/shared';

/** One USB device as Windows enumerates it. */
export interface PnPUSBEntry {
  VendorID: number;
  ProductID: number;
  /** The serial number when Windows used it as the instance ID; null for a generated one. */
  SerialNumber: string | null;
  Name: string | null;
  ErrorCode: number;
}

// Configuration Manager problem codes an operator is likely to meet, in the
// words Device Manager uses. Anything else reads by its number alone.
const PROBLEM_MESSAGES: Record<number, string> = {
  1: 'This device is not configured correctly',
  3: 'The driver for this device might be corrupted',
  10: 'This device cannot start',
  12: 'This device cannot find enough free resources',
  14: 'This device cannot work properly until you restart your computer',
  18: 'Reinstall the drivers for this device',
  19: 'Windows cannot start this device because its configuration is incomplete or damaged',
  21: 'Windows is removing this device',
  22: 'This device is disabled',
  24: 'This device is not present, is not working properly, or does not have all its drivers installed',
  28: 'The drivers for this device are not installed',
  29: 'This device is disabled because the firmware did not give it the required resources',
  31: 'This device is not working properly because Windows cannot load the drivers required',
  32: 'A driver for this device has been disabled',
  37: 'Windows cannot initialize the device driver for this hardware',
  38: 'Windows cannot load the device driver because a previous instance is still loaded',
  39: 'Windows cannot load the device driver for this hardware',
  41: 'Windows loaded the device driver but cannot find the hardware device',
  43: 'Windows has stopped this device because it has reported problems',
  48: 'The software for this device has been blocked from starting',
  52: 'Windows cannot verify the digital signature for the drivers required for this device',
};

// Code 45: the device is not connected (Windows remembers it). Never a fault here:
// a missing device is the presence condition's business.
const NOT_CONNECTED_CODE = 45;

export function DescribeProblem(Code: number): USBDeviceState {
  return { ErrorCode: Code, Message: Code === 0 ? null : (PROBLEM_MESSAGES[Code] ?? null) };
}

/**
 * Read a PnP device ID: "USB\VID_046D&PID_C52B\5&2A0B&0&2". Null for anything
 * that is not a whole USB device — an interface of a composite device
 * ("…&MI_00") is a child of one, not a device of its own.
 */
export function ParsePnPDeviceID(
  ID: unknown
): { VendorID: number; ProductID: number; SerialNumber: string | null } | null {
  if (typeof ID !== 'string') return null;
  const Match = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\(.+)$/i.exec(ID.trim());
  if (!Match) return null;
  const Instance = Match[3]!;
  // A generated instance ID ("5&2A0B&0&2") carries ampersands; a serial does not.
  const SerialNumber = Instance.includes('&') ? null : Instance;
  return {
    VendorID: parseInt(Match[1]!, 16),
    ProductID: parseInt(Match[2]!, 16),
    SerialNumber,
  };
}

/** Parse the query's JSON: one object, or an array of them, or nothing. */
export function ParsePnPEntries(Output: string): PnPUSBEntry[] {
  const Text = Output.trim();
  if (!Text) return [];
  const Parsed: unknown = JSON.parse(Text);
  const Rows = Array.isArray(Parsed) ? Parsed : [Parsed];
  const Entries: PnPUSBEntry[] = [];
  for (const Row of Rows as Array<Record<string, unknown> | null>) {
    if (!Row || Row.Present === false) continue;
    const ID = ParsePnPDeviceID(Row.Id);
    if (!ID) continue;
    const Code = Number(Row.Code);
    Entries.push({
      ...ID,
      Name: typeof Row.Name === 'string' && Row.Name.trim() ? Row.Name.trim() : null,
      ErrorCode: Number.isInteger(Code) && Code >= 0 ? Code : 0,
    });
  }
  return Entries;
}

function Upper(Value: unknown): string {
  return typeof Value === 'string' ? Value.trim().toUpperCase() : '';
}

/**
 * Attach each device's state, and list the failed devices WebUSB could not see.
 *
 * A device is matched by vendor, product and serial; one without a serial only
 * when it is the sole device of its vendor and product on both sides, since two
 * identical serial-less devices cannot be told apart. `Entries` is null when the
 * query failed: every device then carries a null (unknown) state.
 *
 * Every returned device carries the `DeviceState` key, which is how the server
 * learns this client reports it.
 */
export function ApplyWindowsStates(
  Devices: USBDevice[],
  Entries: PnPUSBEntry[] | null
): USBDevice[] {
  if (!Entries) return Devices.map((Device) => ({ ...Device, DeviceState: null }));
  const Unused = new Set(Entries);
  const SameModel = (Entry: PnPUSBEntry, Device: USBDevice) =>
    Entry.VendorID === Device.VendorID && Entry.ProductID === Device.ProductID;

  const Out = Devices.map((Device) => {
    const Serial = Upper(Device.SerialNumber);
    let Match: PnPUSBEntry | null = null;
    if (Serial) {
      Match =
        Entries.find(
          (Entry) =>
            Unused.has(Entry) && SameModel(Entry, Device) && Upper(Entry.SerialNumber) === Serial
        ) ?? null;
    } else {
      const Candidates = Entries.filter((Entry) => Unused.has(Entry) && SameModel(Entry, Device));
      const Twins = Devices.filter(
        (Other) =>
          !Upper(Other.SerialNumber) &&
          Other.VendorID === Device.VendorID &&
          Other.ProductID === Device.ProductID
      );
      if (Candidates.length === 1 && Twins.length === 1) Match = Candidates[0]!;
    }
    if (!Match) return { ...Device, DeviceState: null };
    Unused.delete(Match);
    return { ...Device, DeviceState: DescribeProblem(Match.ErrorCode) };
  });

  for (const Entry of Unused) {
    if (Entry.ErrorCode === 0 || Entry.ErrorCode === NOT_CONNECTED_CODE) continue;
    Out.push({
      VendorID: Entry.VendorID,
      ProductID: Entry.ProductID,
      // Windows' own name for it: the device's own strings need a driver to read.
      ManufacturerName: null,
      ProductName: Entry.Name,
      SerialNumber: Entry.SerialNumber,
      Location: null,
      FirmwareVersion: null,
      DeviceState: DescribeProblem(Entry.ErrorCode),
    });
  }
  return Out;
}

// Present USB devices (not their interfaces' children, filtered in parsing).
// In WQL "_" is a wildcard and "\" an escape, hence "[_]" and "\\".
export const WINDOWS_PNP_SCRIPT = [
  '$rows = Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPDeviceID LIKE \'USB\\\\VID[_]%\'";',
  '$out = foreach ($r in $rows) {',
  '  [pscustomobject]@{ Id = $r.PNPDeviceID; Name = $r.Name; Code = [int]$r.ConfigManagerErrorCode; Present = $r.Present }',
  '};',
  'ConvertTo-Json -Compress -InputObject @($out)',
].join(' ');

const HOST_TIMEOUT_MS = 15000;
const Host = CreatePowerShellHost('USBPowerShellHost');

/** Run in the persistent host, falling back to a one-shot powershell.exe. */
async function RunPowerShell(Script: string): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, HOST_TIMEOUT_MS);
  if (!HostError && Output !== null) return [null, Output];
  return RunCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${Script}`,
  ]);
}

/** Every present USB device's PnP state; an error when it could not be read. */
export async function QueryWindowsUSBStates(): Promise<Result<PnPUSBEntry[]>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_PNP_SCRIPT);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [null, ParsePnPEntries(Output)];
  } catch (error) {
    return [error, null];
  }
}

export function DisposeWindowsUSB(): void {
  Host.Dispose();
}

export const _internal = { Host, HOST_TIMEOUT_MS };
