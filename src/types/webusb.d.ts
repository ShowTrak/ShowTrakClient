// The `usb` package's WebUSB typings reference the DOM lib's WebUSB globals
// (`USBDevice`, `USBConnectionEvent`). The main process compiles without the
// DOM lib — pulling it in would put every browser global in scope for Node-side
// code — so declare the minimal surface the client actually touches.
//
// Only the fields USBMonitor formats are listed; `usb`'s concrete UsbDevice
// class implements a much wider interface we never use. `bus` and `ports` are
// usb 3.x's own (non-WebUSB) additions.
declare global {
  interface USBDevice {
    readonly vendorId: number;
    readonly productId: number;
    readonly manufacturerName?: string;
    readonly productName?: string;
    readonly serialNumber?: string;
    readonly deviceVersionMajor?: number;
    readonly deviceVersionMinor?: number;
    readonly deviceVersionSubminor?: number;
    readonly deviceClass?: number;
    readonly bus?: string;
    readonly ports?: number[];
  }

  interface USBConnectionEvent {
    readonly device: USBDevice;
  }
}

export {};
