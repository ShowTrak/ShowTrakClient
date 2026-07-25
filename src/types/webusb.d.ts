// The `usb` package's WebUSB typings reference the DOM lib's WebUSB globals
// (`USBDevice`, `USBConnectionEvent`). The main process compiles without the
// DOM lib — pulling it in would put every browser global in scope for Node-side
// code — so declare the minimal surface the client actually touches.
//
// Only the descriptor fields USBMonitor formats are listed; `usb`'s concrete
// WebUSBDevice class implements a much wider interface we never use.
declare global {
  interface USBDevice {
    readonly vendorId: number;
    readonly productId: number;
    readonly manufacturerName?: string;
    readonly productName?: string;
    readonly serialNumber?: string;
  }

  interface USBConnectionEvent {
    readonly device: USBDevice;
  }
}

export {};
