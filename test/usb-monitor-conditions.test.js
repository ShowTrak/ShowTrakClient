const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// What the USB monitor reports beyond a device's names and serial: the port it
// is plugged into and its firmware (read off each usb 3.x UsbDevice), and on
// Windows its Plug and Play problem state. The Windows query cannot run on the
// CI runners, so its parsing and matching are pinned here against fixtures and
// the query itself is replaced.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'USBMonitor');
const Windows = require(path.join(DIST, 'windows.js'));

class FakeWebUSB {
  constructor() {
    this.listeners = new Map();
    FakeWebUSB.devices = FakeWebUSB.devices || [];
    FakeWebUSB.instance = this;
  }
  async getDevices() {
    return FakeWebUSB.devices;
  }
  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }
  emit(event, device) {
    for (const handler of this.listeners.get(event) || []) handler({ device });
  }
}

// A usb 3.x UsbDevice as the macOS backend reports it: bus 0x14, port 2 then 4.
function webDevice(overrides = {}) {
  return {
    vendorId: 0x0fd9,
    productId: 0x0080,
    manufacturerName: 'Elgato',
    productName: 'Stream Deck',
    serialNumber: 'CL12345',
    deviceClass: 0,
    deviceVersionMajor: 1,
    deviceVersionMinor: 2,
    deviceVersionSubminor: 3,
    bus: '14',
    ports: [2, 4],
    ...overrides,
  };
}

function loadMonitor(platform = 'darwin') {
  const { Manager, _internal } = loadWithMocks(path.join(DIST, 'index.js'), {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    usb: { WebUSB: FakeWebUSB },
  });
  _internal.Platform = () => platform;
  return { Manager, Internal: _internal };
}

// --- Port and firmware ------------------------------------------------------------

test('the port path and firmware are read off the device', async () => {
  const { Manager } = loadMonitor();
  FakeWebUSB.devices = [webDevice()];
  const [err, [device]] = await Manager.GetUSBDevices();
  assert.equal(err, null);
  // nusb's macOS bus "14" is hex; libusb (usb 2.x) said 20, and so do we.
  assert.equal(device.Location, '20-2.4');
  assert.equal(device.FirmwareVersion, '1.23');
  // Off Windows there is no device state, and so no key for it.
  assert.equal('DeviceState' in device, false);
});

test('an unreadable port or firmware is null, never absent', async () => {
  const { Manager } = loadMonitor();
  FakeWebUSB.devices = [
    webDevice({ bus: undefined, ports: undefined, deviceVersionMajor: undefined }),
  ];
  const [, [device]] = await Manager.GetUSBDevices();
  assert.equal(device.Location, null);
  assert.equal(device.FirmwareVersion, null);
  assert.equal('Location' in device, true);
});

test('root hubs are not listed, but every device below them is', async () => {
  const { Manager } = loadMonitor('linux');
  FakeWebUSB.devices = [
    webDevice({ vendorId: 0x1d6b, deviceClass: 9, bus: '001', ports: [] }),
    webDevice({ deviceClass: 9, bus: '001', ports: [1] }),
    webDevice({ bus: '001', ports: [1, 3] }),
  ];
  const [, devices] = await Manager.GetUSBDevices();
  assert.deepEqual(
    devices.map((d) => d.Location),
    ['1-1', '1-1.3']
  );
});

test('formats bcdDevice and port paths the way lsusb does', () => {
  const { FormatFirmware, FormatLocation, DeviceBCD } = require(path.join(DIST, 'index.js'));
  assert.equal(FormatFirmware(0x0100), '1.00');
  assert.equal(FormatFirmware(0x1a2b), '1a.2b');
  assert.equal(FormatFirmware(-1), null);
  assert.equal(FormatLocation('3', [1]), '3-1');
  assert.equal(FormatLocation('3', []), null);
  assert.equal(FormatLocation(null, [1]), null);
  // The WebUSB split puts bcdDevice back together exactly.
  assert.equal(
    DeviceBCD({ deviceVersionMajor: 0x1a, deviceVersionMinor: 2, deviceVersionSubminor: 0xb }),
    0x1a2b
  );
  assert.equal(
    DeviceBCD({ deviceVersionMajor: 1, deviceVersionMinor: 16, deviceVersionSubminor: 0 }),
    null
  );
  assert.equal(DeviceBCD({}), null);
});

test('the bus reads as the number usb 2.x reported on macOS and Linux', () => {
  const { FormatBus } = require(path.join(DIST, 'index.js'));
  assert.equal(FormatBus('14', 'darwin'), '20');
  assert.equal(FormatBus('00', 'darwin'), '0');
  assert.equal(FormatBus('zz', 'darwin'), null);
  assert.equal(FormatBus('001', 'linux'), '1');
  assert.equal(FormatBus('012', 'linux'), '12');
  assert.equal(FormatBus('1a', 'linux'), null);
  assert.equal(FormatBus('', 'linux'), null);
  assert.equal(FormatBus(undefined, 'darwin'), null);
});

test('a Windows bus is the controller PCI address, read off its location path', () => {
  const { FormatBus, FormatWindowsBus } = require(path.join(DIST, 'index.js'));
  assert.equal(FormatBus('PCIROOT(0)#PCI(1400)#USBROOT(0)', 'win32'), 'PCI0:14.0');
  // Behind bridges, one hop each; a second root hub on the controller is named.
  assert.equal(FormatWindowsBus('PCIROOT(0)#PCI(0201)#PCI(0000)#USBROOT(0)'), 'PCI0:02.1/00.0');
  assert.equal(FormatWindowsBus('PCIROOT(0)#PCI(1400)#USBROOT(1)'), 'PCI0:14.0/r1');
  assert.equal(FormatWindowsBus('PCIROOT(A)#PCI(1D07)#USBROOT(0)'), 'PCIa:1d.7');
  // Any other shape is kept as it is, so it still tells controllers apart...
  assert.equal(
    FormatWindowsBus('ACPI(_SB_)#ACPI(URS0)#USBROOT(0)'),
    'ACPI(_SB_)#ACPI(URS0)#USBROOT(0)'
  );
  // ...unless it could not survive as one part of a Location.
  assert.equal(FormatWindowsBus('ACPI(A-B)#USBROOT(0)'), null);
  assert.equal(FormatWindowsBus('A,B'), null);
});

test('a Windows device reports its port under its controller address', async () => {
  const { Manager, Internal } = loadMonitor('win32');
  Internal.QueryWindowsUSBStates = async () => [null, []];
  FakeWebUSB.devices = [webDevice({ bus: 'PCIROOT(0)#PCI(1400)#USBROOT(0)', ports: [3, 1] })];
  const [, [device]] = await Manager.GetUSBDevices();
  assert.equal(device.Location, 'PCI0:14.0-3.1');
});

test('a plug-in or unplug of any device counts as a topology change', () => {
  const { Manager } = loadMonitor();
  let changes = 0;
  Manager.OnUSBTopologyChange(() => {
    changes += 1;
  });
  FakeWebUSB.instance.emit('connect', webDevice());
  FakeWebUSB.instance.emit('disconnect', webDevice());
  assert.equal(changes, 2);
});

// --- Windows: parsing ---------------------------------------------------------------

test('PnP device IDs: serials, generated instance IDs, and interfaces', () => {
  assert.deepEqual(Windows.ParsePnPDeviceID('USB\\VID_0FD9&PID_0080\\CL12345'), {
    VendorID: 0x0fd9,
    ProductID: 0x0080,
    SerialNumber: 'CL12345',
  });
  assert.equal(Windows.ParsePnPDeviceID('USB\\VID_046D&PID_C52B\\5&2A0B&0&2').SerialNumber, null);
  assert.equal(Windows.ParsePnPDeviceID('USB\\VID_046D&PID_C52B&MI_00\\6&1&0&0000'), null);
  assert.equal(Windows.ParsePnPDeviceID('HID\\VID_046D&PID_C52B\\x'), null);
});

test('the query output reads as one object or an array, skipping what is not a device', () => {
  const one = Windows.ParsePnPEntries(
    JSON.stringify({ Id: 'USB\\VID_0FD9&PID_0080\\CL12345', Name: 'Stream Deck', Code: 43 })
  );
  assert.deepEqual(one, [
    {
      VendorID: 0x0fd9,
      ProductID: 0x0080,
      SerialNumber: 'CL12345',
      Name: 'Stream Deck',
      ErrorCode: 43,
    },
  ]);
  const many = Windows.ParsePnPEntries(
    JSON.stringify([
      { Id: 'USB\\VID_0FD9&PID_0080\\CL12345', Name: 'A', Code: 0, Present: true },
      { Id: 'USB\\VID_0FD9&PID_0080\\GONE', Name: 'B', Code: 0, Present: false },
      { Id: 'USB\\VID_0FD9&PID_0080&MI_00\\7&1', Name: 'C', Code: 0 },
    ])
  );
  assert.equal(many.length, 1);
  assert.deepEqual(Windows.ParsePnPEntries(''), []);
  assert.deepEqual(Windows.ParsePnPEntries('[]'), []);
});

test('problem codes read the way Device Manager words them', () => {
  assert.deepEqual(Windows.DescribeProblem(0), { ErrorCode: 0, Message: null });
  assert.match(Windows.DescribeProblem(43).Message, /stopped this device/);
  assert.deepEqual(Windows.DescribeProblem(999), { ErrorCode: 999, Message: null });
});

// --- Windows: matching ----------------------------------------------------------------

const entry = (overrides = {}) => ({
  VendorID: 0x0fd9,
  ProductID: 0x0080,
  SerialNumber: 'CL12345',
  Name: 'Stream Deck',
  ErrorCode: 0,
  ...overrides,
});
const device = (overrides = {}) => ({
  VendorID: 0x0fd9,
  ProductID: 0x0080,
  ManufacturerName: 'Elgato',
  ProductName: 'Stream Deck',
  SerialNumber: 'CL12345',
  Location: '1-2',
  FirmwareVersion: '1.00',
  ...overrides,
});

test('a device takes the state of its own PnP entry, matched by serial', () => {
  const [out] = Windows.ApplyWindowsStates([device({ SerialNumber: 'cl12345' })], [entry()]);
  assert.deepEqual(out.DeviceState, { ErrorCode: 0, Message: null });
});

test('a serial-less device matches only when it is the one of its model on both sides', () => {
  const noSerial = device({ SerialNumber: null });
  const generated = entry({ SerialNumber: null });
  assert.equal(Windows.ApplyWindowsStates([noSerial], [generated])[0].DeviceState.ErrorCode, 0);
  // Two identical devices cannot be told apart: unknown, not a guess.
  const twins = Windows.ApplyWindowsStates(
    [noSerial, { ...noSerial }],
    [generated, { ...generated }]
  );
  assert.equal(twins[0].DeviceState, null);
  assert.equal(twins.length, 2);
});

test('a failed device WebUSB could not open is listed with its problem', () => {
  const out = Windows.ApplyWindowsStates(
    [device()],
    [entry(), entry({ SerialNumber: 'BROKEN1', Name: 'Capture Card', ErrorCode: 10 })]
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], {
    VendorID: 0x0fd9,
    ProductID: 0x0080,
    ManufacturerName: null,
    ProductName: 'Capture Card',
    SerialNumber: 'BROKEN1',
    Location: null,
    FirmwareVersion: null,
    DeviceState: { ErrorCode: 10, Message: 'This device cannot start' },
  });
  // A healthy device it could not open, or one Windows only remembers, is not listed.
  assert.equal(
    Windows.ApplyWindowsStates(
      [],
      [entry({ SerialNumber: 'X' }), entry({ SerialNumber: 'Y', ErrorCode: 45 })]
    ).length,
    0
  );
});

test('a failed query leaves every state unknown, and lists nothing extra', () => {
  const out = Windows.ApplyWindowsStates([device()], null);
  assert.deepEqual(out, [{ ...device(), DeviceState: null }]);
});

test('the WQL filter escapes its wildcard and backslash', () => {
  assert.match(Windows.WINDOWS_PNP_SCRIPT, /LIKE 'USB\\\\VID\[_\]%'/);
  assert.match(Windows.WINDOWS_PNP_SCRIPT, /ConfigManagerErrorCode/);
});

// --- Windows: the monitor ------------------------------------------------------------

test('on Windows the full list carries states, and a hotplug the last known one', async () => {
  const { Manager, Internal } = loadMonitor();
  Internal.Platform = () => 'win32';
  let queries = 0;
  Internal.QueryWindowsUSBStates = async () => {
    queries += 1;
    return [null, [entry({ ErrorCode: 43 })]];
  };
  FakeWebUSB.devices = [webDevice()];
  const [, devices] = await Manager.GetUSBDevices();
  // (The module also samples once as it loads, so this is not the only query.)
  assert.ok(queries >= 1);
  assert.equal(devices[0].DeviceState.ErrorCode, 43);

  // A hotplug cannot wait for PowerShell: it says what the last query said.
  assert.equal(Internal.FormatEventDevice(webDevice()).DeviceState.ErrorCode, 43);
  assert.equal(Internal.FormatEventDevice(webDevice({ serialNumber: 'NEW' })).DeviceState, null);
});

test('on Windows a failed query still reports the key, as unknown', async () => {
  const { Manager, Internal } = loadMonitor();
  Internal.Platform = () => 'win32';
  Internal.QueryWindowsUSBStates = async () => [new Error('no powershell'), null];
  FakeWebUSB.devices = [webDevice()];
  const [err, devices] = await Manager.GetUSBDevices();
  assert.equal(err, null);
  assert.equal(devices[0].DeviceState, null);
  assert.equal('DeviceState' in devices[0], true);
});
