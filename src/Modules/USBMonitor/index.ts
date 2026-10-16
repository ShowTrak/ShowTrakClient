import os from 'node:os';
import { WebUSB } from 'usb';

import type { USBDevice as USBDevicePayload } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';
import {
  ApplyWindowsStates,
  DescribeProblem,
  QueryWindowsUSBStates,
  type PnPUSBEntry,
} from './windows';

const Logger = CreateLogger('USBMonitor');

const WebUSBInstance = new WebUSB({
  allowAllDevices: true,
});

/**
 * The subset of a usb 3.x `UsbDevice` this module reads — from `getDevices()` and
 * the connect/disconnect events alike. Structural, so the tests can hand in plain
 * objects and so it states exactly what this module depends on.
 *
 * usb 3.x reads all of this from the OS (IOKit, sysfs, cfgmgr32) WITHOUT opening
 * the device, so devices libusb could not open — Windows class-driver devices, ones
 * without udev permissions — are now listed and named.
 *
 * ---
 * usb 3.x must be 3.1.0 or later. 3.0.1 emitted 'connect' TWICE for one physical
 * plug-in (two hotplug watchers raced into existence; node-usb/node-usb-rs#36), and
 * MainClient forwards every connect to the server as 'USBDeviceConnected', which
 * reaches AlertsManager.HandleUSBDeviceConnected with no idempotency key, cooldown
 * or throttle — so one plug-in raised two alerts. `node --test` cannot plug in a
 * device, so a regression there would only show on a real replug.
 */
interface ReadableUSBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName?: string | null;
  readonly productName?: string | null;
  readonly serialNumber?: string | null;
  /** nusb's bus id; its format is per platform, see FormatBus. */
  readonly bus?: string;
  /** The port path from the root hub, through any hubs. */
  readonly ports?: number[];
  /** bcdDevice, split WebUSB-style into its three BCD nibble groups. */
  readonly deviceVersionMajor?: number;
  readonly deviceVersionMinor?: number;
  readonly deviceVersionSubminor?: number;
  readonly deviceClass?: number;
}

type USBDeviceListener = (device: USBDevicePayload) => void;

/**
 * A Windows bus id (the device's location path up to its root hub) as a short,
 * readable token: "PCIROOT(0)#PCI(1400)#USBROOT(0)" → "PCI0:14.0", the controller's
 * PCI device.function, one hop per bridge ("PCI0:02.1/00.0"). It comes from where
 * the controller physically sits, so it survives reboots, driver reinstalls and
 * plug-in order. A path of any other shape is kept as it is. Null when unusable.
 */
export function FormatWindowsBus(Path: string): string | null {
  const PCI =
    /^PCIROOT\(([0-9A-F]{1,4})\)((?:#PCI\([0-9A-F]{4}\))+)#USBROOT\(([0-9]{1,3})\)$/i.exec(Path);
  if (PCI) {
    const [, Root, Hops, RootHub] = PCI as unknown as [string, string, string, string];
    const Devices = [...Hops.matchAll(/PCI\(([0-9A-F]{2})([0-9A-F]{2})\)/gi)].map(
      ([, Device, Function]) => `${Device!.toLowerCase()}.${parseInt(Function!, 16).toString(16)}`
    );
    const Hub = Number(RootHub) === 0 ? '' : `/r${Number(RootHub)}`;
    return `PCI${parseInt(Root, 16).toString(16)}:${Devices.join('/')}${Hub}`;
  }
  return /^[A-Za-z0-9_:.()#/]{1,64}$/.test(Path) ? Path : null;
}

/**
 * The bus part of a Location. On macOS and Linux this is the number libusb (usb
 * 2.x) reported — macOS bus = locationID >> 24, which nusb prints as two hex
 * digits; Linux bus = sysfs busnum, which nusb zero-pads to three — so a port
 * guarded before the switch to 3.x still matches. On Windows libusb's number was
 * only the order it found the controllers in and cannot be recovered; see
 * FormatWindowsBus. Null when unknown.
 */
export function FormatBus(Bus: unknown, Platform: NodeJS.Platform): string | null {
  if (typeof Bus !== 'string' || !Bus) return null;
  if (Platform === 'darwin') return /^[0-9a-f]{1,2}$/i.test(Bus) ? String(parseInt(Bus, 16)) : null;
  if (Platform === 'win32') return FormatWindowsBus(Bus);
  return /^[0-9]{1,3}$/.test(Bus) ? String(parseInt(Bus, 10)) : null;
}

/** "1-2.4": the bus, then the port path through any hubs. Null when unknown. */
export function FormatLocation(Bus: string | null, Ports: unknown): string | null {
  if (!Bus || !Array.isArray(Ports) || !Ports.length) return null;
  if (!Ports.every((Port) => Number.isInteger(Port) && Port >= 0)) return null;
  return `${Bus}-${Ports.join('.')}`;
}

/** bcdDevice the way lsusb prints it: 0x0123 → "1.23". Null when unknown. */
export function FormatFirmware(BCD: unknown): string | null {
  if (!Number.isInteger(BCD) || (BCD as number) < 0 || (BCD as number) > 0xffff) return null;
  const Value = BCD as number;
  return `${(Value >> 8).toString(16)}.${(Value & 0xff).toString(16).padStart(2, '0')}`;
}

/** bcdDevice back from its WebUSB split (0x0123 = 1, 2, 3). Null when unknown. */
export function DeviceBCD(Device: ReadableUSBDevice): number | null {
  const {
    deviceVersionMajor: Major,
    deviceVersionMinor: Minor,
    deviceVersionSubminor: Sub,
  } = Device;
  if (!Number.isInteger(Major) || !Number.isInteger(Minor) || !Number.isInteger(Sub)) return null;
  if (Major! > 0xff || Minor! > 0xf || Sub! > 0xf || Major! < 0 || Minor! < 0 || Sub! < 0) {
    return null;
  }
  return (Major! << 8) | (Minor! << 4) | Sub!;
}

/** A root hub: no port path above it, and a hub. Not a device anyone plugged in. */
function IsRootHub(Device: ReadableUSBDevice): boolean {
  return Device.deviceClass === 9 && Array.isArray(Device.ports) && Device.ports.length === 0;
}

const Internal = {
  // Windows only: the last PnP snapshot, so a hotplug event (which cannot wait
  // for a PowerShell query) still says what is known. Null until the first one.
  LastWindowsStates: null as PnPUSBEntry[] | null,

  Platform: (): NodeJS.Platform => os.platform(),
  QueryWindowsUSBStates,

  FormatDevice(Device: ReadableUSBDevice): USBDevicePayload {
    return {
      VendorID: Device.vendorId,
      ProductID: Device.productId,
      ManufacturerName: Device.manufacturerName,
      ProductName: Device.productName,
      SerialNumber: Device.serialNumber,
      // Always present from this version on (null when unknown), which is how
      // the server tells this client from one that cannot report them.
      Location: FormatLocation(FormatBus(Device.bus, Internal.Platform()), Device.ports),
      FirmwareVersion: FormatFirmware(DeviceBCD(Device)),
    };
  },

  /** A hotplugged device, with its last-known Windows state where there is one. */
  FormatEventDevice(Device: ReadableUSBDevice): USBDevicePayload {
    const Formatted = Internal.FormatDevice(Device);
    if (Internal.Platform() !== 'win32') return Formatted;
    const [WithState] = ApplyWindowsStates([Formatted], Internal.LastWindowsStates);
    return WithState ?? { ...Formatted, DeviceState: null };
  },
};

export { DescribeProblem };

export const Manager = {
  async GetUSBDevices(): Promise<Result<USBDevicePayload[]>> {
    try {
      const Devices = await WebUSBInstance.getDevices();
      let FormattedDevices = Devices.filter((Device) => !IsRootHub(Device)).map(
        Internal.FormatDevice
      );
      if (Internal.Platform() === 'win32') {
        const [StateError, States] = await Internal.QueryWindowsUSBStates();
        if (StateError) Logger.warn('Could not read USB device states:', StateError);
        Internal.LastWindowsStates = StateError ? null : States;
        FormattedDevices = ApplyWindowsStates(FormattedDevices, Internal.LastWindowsStates);
      }
      Logger.log(`Found ${FormattedDevices.length} USB devices`);
      return [null, FormattedDevices];
    } catch (error) {
      Logger.error('Error getting USB devices:', error);
      return [error, null];
    }
  },

  OnUSBConnect(callback: USBDeviceListener): void {
    WebUSBInstance.addEventListener('connect', function (Event) {
      callback(Internal.FormatEventDevice((Event as USBConnectionEvent).device));
    });
  },

  OnUSBDisconnect(callback: USBDeviceListener): void {
    WebUSBInstance.addEventListener('disconnect', function (Event) {
      callback(Internal.FormatEventDevice((Event as USBConnectionEvent).device));
    });
  },

  /**
   * Any change in what is plugged in: a device moved to another port, a driver
   * that fails on plug-in. The caller re-sends the full list, which is how a
   * port change and a Windows device state reach the server. usb 3.x announces
   * every device without opening it, so its own connect/disconnect cover all of
   * these (2.x needed libusb's attach/detach for devices it could not open).
   */
  OnUSBTopologyChange(callback: () => void): void {
    WebUSBInstance.addEventListener('connect', () => callback());
    WebUSBInstance.addEventListener('disconnect', () => callback());
  },
};

export const _internal = Internal;

Manager.OnUSBConnect(() => {
  Logger.log('USB device connected');
});

Manager.OnUSBDisconnect(() => {
  Logger.log('USB device disconnected');
});

void Manager.GetUSBDevices();
