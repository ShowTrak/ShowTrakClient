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

// Windows Plug and Play state is a WMI query, so it is not re-read on every
// device-list send (the list is resent every minute as a reconciliation channel).
// It is read when anything was plugged or unplugged since the last read, and at
// least this often otherwise — which is how a driver that fails without a plug
// event (code 43 after a crash) still reaches the server.
const PNP_REFRESH_MS = 5 * 60 * 1000;

// Created on Start(), not at import. Constructing WebUSB is cheap, but listening
// to it starts usb's native hotplug watcher, and the module used to do both — and
// run the Windows PnP query — the moment anything imported it, on a client that
// was not even adopted yet.
let WebUSBInstance: WebUSB | null = null;

function Instance(): WebUSB {
  if (!WebUSBInstance) WebUSBInstance = new WebUSB({ allowAllDevices: true });
  return WebUSBInstance;
}

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
  // When the PnP snapshot was taken, and whether anything was plugged or
  // unplugged since.
  WindowsStatesAt: -Infinity,
  WindowsStatesStale: true,
  Now: (): number => Date.now(),

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

type Listener = (device: USBDevicePayload) => void;

const Subscribers = {
  Connect: [] as Listener[],
  Disconnect: [] as Listener[],
  Topology: [] as Array<() => void>,
};

function Dispatch<T extends unknown[]>(Handlers: Array<(...Args: T) => void>, ...Args: T): void {
  for (const Handler of Handlers) {
    try {
      Handler(...Args);
    } catch (error) {
      Logger.error('USB listener failed:', error);
    }
  }
}

function HandleConnect(Event: USBConnectionEvent): void {
  Internal.WindowsStatesStale = true;
  Logger.log('USB device connected');
  const Device = Internal.FormatEventDevice(Event.device);
  Dispatch(Subscribers.Connect, Device);
  Dispatch(Subscribers.Topology);
}

function HandleDisconnect(Event: USBConnectionEvent): void {
  Internal.WindowsStatesStale = true;
  Logger.log('USB device disconnected');
  const Device = Internal.FormatEventDevice(Event.device);
  Dispatch(Subscribers.Disconnect, Device);
  Dispatch(Subscribers.Topology);
}

let Watching = false;

/** The Windows PnP states to report with this list: cached unless due. */
async function WindowsStates(): Promise<PnPUSBEntry[] | null> {
  const Due =
    Internal.WindowsStatesStale ||
    Internal.LastWindowsStates === null ||
    Internal.Now() - Internal.WindowsStatesAt >= PNP_REFRESH_MS;
  if (!Due) return Internal.LastWindowsStates;
  // Cleared before the query: an event during it marks the result stale again.
  Internal.WindowsStatesStale = false;
  const [StateError, States] = await Internal.QueryWindowsUSBStates();
  if (StateError) Logger.warn('Could not read USB device states:', StateError);
  Internal.LastWindowsStates = StateError ? null : States;
  Internal.WindowsStatesAt = Internal.Now();
  // A failed read is retried at the next send rather than after the full interval.
  if (StateError) Internal.WindowsStatesStale = true;
  return Internal.LastWindowsStates;
}

export const Manager = {
  /**
   * Start watching for hotplugs. Idempotent. Called when the client starts its
   * server connection; an unadopted client never watches.
   */
  Start(): void {
    if (Watching) return;
    Watching = true;
    Internal.WindowsStatesStale = true;
    const Usb = Instance();
    Usb.addEventListener('connect', HandleConnect);
    Usb.addEventListener('disconnect', HandleDisconnect);
  },

  /** Stop watching. Removing the last listener stops usb's native hotplug watcher. */
  Stop(): void {
    if (!Watching) return;
    Watching = false;
    const Usb = WebUSBInstance;
    if (!Usb) return;
    try {
      Usb.removeEventListener('connect', HandleConnect);
      Usb.removeEventListener('disconnect', HandleDisconnect);
    } catch (error) {
      Logger.debug('Stopping the USB hotplug watcher failed', error);
    }
  },

  async GetUSBDevices(): Promise<Result<USBDevicePayload[]>> {
    try {
      const Devices = await Instance().getDevices();
      let FormattedDevices = Devices.filter((Device) => !IsRootHub(Device)).map(
        Internal.FormatDevice
      );
      if (Internal.Platform() === 'win32') {
        FormattedDevices = ApplyWindowsStates(FormattedDevices, await WindowsStates());
      }
      Logger.debug(`Found ${FormattedDevices.length} USB devices`);
      return [null, FormattedDevices];
    } catch (error) {
      Logger.error('Error getting USB devices:', error);
      return [error, null];
    }
  },

  OnUSBConnect(callback: USBDeviceListener): void {
    Subscribers.Connect.push(callback);
  },

  OnUSBDisconnect(callback: USBDeviceListener): void {
    Subscribers.Disconnect.push(callback);
  },

  /**
   * Any change in what is plugged in: a device moved to another port, a driver
   * that fails on plug-in. The caller re-sends the full list, which is how a
   * port change and a Windows device state reach the server. usb 3.x announces
   * every device without opening it, so its own connect/disconnect cover all of
   * these (2.x needed libusb's attach/detach for devices it could not open).
   */
  OnUSBTopologyChange(callback: () => void): void {
    Subscribers.Topology.push(callback);
  },
};

export const _internal = Internal;
export const _constants = { PNP_REFRESH_MS };
