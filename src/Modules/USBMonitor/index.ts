import { WebUSB } from 'usb';

import type { USBDevice as USBDevicePayload } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('USBMonitor');

const WebUSBInstance = new WebUSB({
  allowAllDevices: true,
});

/** A device as handed to us by the `usb` package's WebUSB implementation. */
type WebUSBDevice = Awaited<ReturnType<typeof WebUSBInstance.getDevices>>[number];

type USBDeviceListener = (device: USBDevicePayload) => void;

const Internal = {
  FormatDevice(Device: WebUSBDevice): USBDevicePayload {
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
