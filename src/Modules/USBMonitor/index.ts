import os from 'node:os';
import * as USBPackage from 'usb';

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

const { WebUSB } = USBPackage;

const WebUSBInstance = new WebUSB({
  allowAllDevices: true,
});

/**
 * The subset of a USB device this module reads.
 *
 * Structural rather than derived from the `usb` package's own types, because the
 * package hands us TWO different device shapes: `getDevices()` returns its own
 * device class, while the connect/disconnect events carry a WebUSB `USBDevice`.
 * Which is which changed between usb 2.x and 3.x — 2.x returns WebUSB devices from
 * both, 3.x returns its native `UsbDevice` from getDevices() — and typing against
 * either concrete class breaks on the other.
 *
 * All five fields exist on both, so reading them structurally is stable across that
 * churn and states exactly what this module depends on.
 *
 * ---
 * DO NOT upgrade to usb 3.x without re-testing hotplug. 3.0.1 emits the 'connect'
 * event TWICE for a single physical plug-in (measured: both versions watching the
 * same replug of a Brother PT-P950NW, v2.18.0 gave 1 connect / 1 disconnect, v3.0.1
 * gave 2 connects / 1 disconnect, both duplicates in the same tick). MainClient
 * forwards every connect to the server as 'USBDeviceConnected', which reaches
 * AlertsManager.HandleUSBDeviceConnected — and there is no idempotency key, cooldown
 * or throttle anywhere in that path, so one plug-in raises two alerts and fires the
 * rule's actions twice.
 *
 * usb 3.x is otherwise attractive: it drops libusb for nusb (IOKit on macOS,
 * cfgmgr32 on Windows) and reads manufacturer/product/serial WITHOUT opening the
 * device, which should surface Windows class-driver devices that libusb cannot name
 * today. The five-field payload is byte-identical on macOS. Retry when the duplicate
 * is fixed upstream, or with a dedupe here — and verify on a real replug, because
 * `node --test` cannot see this.
 */
interface ReadableUSBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName?: string | null;
  readonly productName?: string | null;
  readonly serialNumber?: string | null;
}

/**
 * The libusb device a WebUSB device wraps, as far as this module reads it: where
 * it is plugged in and its descriptor, all readable without opening it. usb
 * 2.x keeps it on the WebUSB device as `device` (TypeScript-private, so read
 * structurally); when it is not there, the port and firmware read as unknown.
 */
interface NativeUSBDevice {
  readonly busNumber?: number;
  readonly portNumbers?: number[];
  readonly deviceDescriptor?: { readonly bcdDevice?: number };
}

type USBDeviceListener = (device: USBDevicePayload) => void;

function NativeOf(Device: unknown): NativeUSBDevice | null {
  const Native = (Device as { device?: unknown } | null)?.device;
  return Native && typeof Native === 'object' ? (Native as NativeUSBDevice) : null;
}

/** "1-2.4": the bus, then the port path through any hubs. Null when unknown. */
export function FormatLocation(Bus: unknown, Ports: unknown): string | null {
  if (!Number.isInteger(Bus) || !Array.isArray(Ports) || !Ports.length) return null;
  if (!Ports.every((Port) => Number.isInteger(Port) && Port >= 0)) return null;
  return `${Bus as number}-${Ports.join('.')}`;
}

/** bcdDevice the way lsusb prints it: 0x0123 → "1.23". Null when unknown. */
export function FormatFirmware(BCD: unknown): string | null {
  if (!Number.isInteger(BCD) || (BCD as number) < 0 || (BCD as number) > 0xffff) return null;
  const Value = BCD as number;
  return `${(Value >> 8).toString(16)}.${(Value & 0xff).toString(16).padStart(2, '0')}`;
}

const Internal = {
  // Windows only: the last PnP snapshot, so a hotplug event (which cannot wait
  // for a PowerShell query) still says what is known. Null until the first one.
  LastWindowsStates: null as PnPUSBEntry[] | null,

  Platform: (): NodeJS.Platform => os.platform(),
  QueryWindowsUSBStates,

  FormatDevice(Device: ReadableUSBDevice): USBDevicePayload {
    const Native = NativeOf(Device);
    return {
      VendorID: Device.vendorId,
      ProductID: Device.productId,
      ManufacturerName: Device.manufacturerName,
      ProductName: Device.productName,
      SerialNumber: Device.serialNumber,
      // Always present from this version on (null when unknown), which is how
      // the server tells this client from one that cannot report them.
      Location: FormatLocation(Native?.busNumber, Native?.portNumbers),
      FirmwareVersion: FormatFirmware(Native?.deviceDescriptor?.bcdDevice),
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
      let FormattedDevices = Devices.map(Internal.FormatDevice);
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
   * Any change in what is plugged in, including a device WebUSB cannot open
   * (and so never announces): a driver that fails on plug-in, a device moved to
   * another port. The caller re-sends the full list, which is how those reach
   * the server. libusb's own attach/detach; a no-op where it is not available.
   */
  OnUSBTopologyChange(callback: () => void): void {
    const Native = (USBPackage as { usb?: { on?: (event: string, fn: () => void) => void } }).usb;
    if (!Native || typeof Native.on !== 'function') return;
    Native.on('attach', () => callback());
    Native.on('detach', () => callback());
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
