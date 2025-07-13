const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('USBMonitor');

var USBDetection = require('usb-detection');

USBDetection.startMonitoring();

// Detect add/insert
USBDetection.on('add', function (device) { 
    Logger.log('add', device); 
});
USBDetection.on('remove', function (device) { 
    Logger.log('remove', device); 
});

const Manager = {};

Manager.OnUSBConnect = (callback) => {
    USBDetection.on('add', function (device) { 
        callback(device);
    });
}

Manager.OnUSBDisconnect = (callback) => {
    USBDetection.on('remove', function (device) { 
        callback(device);
    });
}

module.exports = {
    Manager,
}