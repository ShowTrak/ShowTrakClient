import { WebUSB } from 'usb';

import type { USBDevice as USBDevicePayload } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('USBMonitor');

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

type USBDeviceListener = (device: USBDevicePayload) => void;

const Internal = {
  FormatDevice(Device: ReadableUSBDevice): USBDevicePayload {
    return {
      VendorID: Device.vendorId,
      ProductID: Device.productId,
      ManufacturerName: Device.manufacturerName,
      ProductName: Device.productName,
      SerialNumber: Device.serialNumber,
    };
  },
};

export const Manager = {
  async GetUSBDevices(): Promise<Result<USBDevicePayload[]>> {
    try {
      const Devices = await WebUSBInstance.getDevices();
      const FormattedDevices = Devices.map(Internal.FormatDevice);
      Logger.log(`Found ${FormattedDevices.length} USB devices`);
      return [null, FormattedDevices];
    } catch (error) {
      Logger.error('Error getting USB devices:', error);
      return [error, null];
    }
  },

  OnUSBConnect(callback: USBDeviceListener): void {
    WebUSBInstance.addEventListener('connect', function (Event) {
      callback(Internal.FormatDevice((Event as USBConnectionEvent).device));
    });
  },

  OnUSBDisconnect(callback: USBDeviceListener): void {
    WebUSBInstance.addEventListener('disconnect', function (Event) {
      callback(Internal.FormatDevice((Event as USBConnectionEvent).device));
    });
  },
};

Manager.OnUSBConnect(() => {
  Logger.log('USB device connected');
});

Manager.OnUSBDisconnect(() => {
  Logger.log('USB device disconnected');
});

void Manager.GetUSBDevices();
