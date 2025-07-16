// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('OS');

// Get the hostname of the PC
const os = require('os');
const osu = require('node-os-utils')
const cpu = osu.cpu
const macaddress = require('macaddress');

const Manager = {};

Manager.Hostname = os.hostname();

let CPUUsage = 0.0;
Manager.GetCPUUsage = async () => {
    cpu.usage().then(info => {
        CPUUsage = info;
    })
}
setInterval(Manager.GetCPUUsage, 1000)

Manager.GetMacAddresses = async () => {
    return new Promise((resolve, reject) => {
        macaddress.all().then((macs) => {
            return resolve([null, macs]);
        }).catch((err) => {
            return resolve([err, null]);
        });
    });
}

Manager.GetVitals = async () => {
    const TotalMemory = os.totalmem();
    const FreeMemory = os.freemem();
    const Uptime = os.uptime();

    return {
        CPU: {
            UsagePercentage: CPUUsage,
        },
        Ram: {
            Total: TotalMemory,
            Used: TotalMemory - FreeMemory,
            UsagePercentage: ((TotalMemory - FreeMemory) / TotalMemory * 100).toFixed(2),
        },
        Uptime: {
            Formatted: new Date(Uptime * 1000).toISOString().substr(11, 8) // HH:mm:ss
        },
    };
}

module.exports = {
    Manager,
};