const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('USBMonitor');

const { WebUSB } = require('usb');

const Manager = {};

const WebUSBInstance = new WebUSB({
    allowAllDevices: true
});

const Internal = {};

Internal.FormatDevice = (Device) => {
    return {
        VendorID: Device.vendorId,
        ProductID: Device.productId,
        ManufacturerName: Device.manufacturerName,
        ProductName: Device.productName,
        SerialNumber: Device.serialNumber,
    };
}

Manager.GetUSBDevices = async () => {
    try {
        const Devices = await WebUSBInstance.getDevices();
        const FormattedDevices = Devices.map(Internal.FormatDevice);
        Logger.log(`Found ${FormattedDevices.length} USB devices`);
        return [null, FormattedDevices];
    } catch (error) {
        Logger.error('Error getting USB devices:', error);
        return [error, null];
    }
}

Manager.OnUSBConnect = (callback) => {
    WebUSBInstance.addEventListener('connect', function (Event) { 
        callback(Internal.FormatDevice(Event.device));
    });
}

Manager.OnUSBConnect(async (Device) => {
    Logger.log('USB device connected');
})

Manager.OnUSBDisconnect = (callback) => {
    WebUSBInstance.addEventListener('disconnect', function (Event) { 
        callback(Internal.FormatDevice(Event.device));
    });
}

Manager.OnUSBDisconnect(async (Device) => {
    Logger.log('USB device disconnected');
})

Manager.GetUSBDevices();

module.exports = {
    Manager,
}