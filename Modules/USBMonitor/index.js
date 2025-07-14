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
        vendorId: Device.vendorId,
        productId: Device.productId,
        manufacturer: Device.manufacturerName,
        product: Device.productName,
        serialNumber: Device.serialNumber,
    };
}

Manager.GetUSBDevices = async () => {
    try {
        const Devices = await WebUSBInstance.getDevices();
        Logger.log(Devices);
        Logger.log(Devices.map(Internal.FormatDevice))
        return [null, Devices]
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