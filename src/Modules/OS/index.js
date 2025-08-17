// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('OS');

// Get the hostname of the PC
const os = require('os');
const macaddress = require('macaddress');

const Manager = {};

Manager.Hostname = os.hostname();

let CPUUsage = 0.0;
let __prevCpuTimes = null;
let __cpuWindow = [];
const __CPU_WINDOW_SIZE = 3; // 2–3s smoothing

function snapshotCpuTimes() {
  const list = os.cpus();
  // Summarize times across all logical CPUs
  let idle = 0, total = 0;
  for (const c of list) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sampleCPU() {
  try {
    const curr = snapshotCpuTimes();
    if (__prevCpuTimes) {
      const idleDelta = curr.idle - __prevCpuTimes.idle;
      const totalDelta = curr.total - __prevCpuTimes.total;
      if (totalDelta > 0) {
        const usage = (1 - idleDelta / totalDelta) * 100;
        const clamped = Math.max(0, Math.min(100, usage));
        // Rolling average smoothing across last N samples
        __cpuWindow.push(clamped);
        if (__cpuWindow.length > __CPU_WINDOW_SIZE) __cpuWindow.shift();
        const avg = __cpuWindow.reduce((a, b) => a + b, 0) / __cpuWindow.length;
        CPUUsage = Number(avg.toFixed(2));
      }
    }
    __prevCpuTimes = curr;
  } catch (_) {}
}

// Initialize snapshot and start a 1s sampler; this aligns with Task Manager more closely on Windows
__prevCpuTimes = snapshotCpuTimes();
setInterval(sampleCPU, 1000);

Manager.GetMacAddresses = async () => {
  return new Promise((resolve, _reject) => {
    macaddress
      .all()
      .then((macs) => {
        return resolve([null, macs]);
      })
      .catch((err) => {
        return resolve([err, null]);
      });
  });
};

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
      UsagePercentage: (((TotalMemory - FreeMemory) / TotalMemory) * 100).toFixed(2),
    },
    Uptime: {
      Formatted: new Date(Uptime * 1000).toISOString().substr(11, 8), // HH:mm:ss
    },
  };
};

module.exports = {
  Manager,
};

// Network interfaces reporter
// Returns an array of interfaces with their addresses (IPv4/IPv6)
// [{ name, addresses: [{ family, address, netmask, cidr, mac, internal, scopeid }] }]
Manager.GetNetworkInterfaces = async () => {
  try {
    const nics = os.networkInterfaces();
    const results = [];
    for (const [name, addrs] of Object.entries(nics)) {
      if (!Array.isArray(addrs)) continue;
      results.push({
        name,
        addresses: addrs.map((a) => ({
          family: a.family,
          address: a.address,
          netmask: a.netmask,
          cidr: a.cidr || null,
          mac: a.mac,
          internal: !!a.internal,
          scopeid: typeof a.scopeid !== 'undefined' ? a.scopeid : null,
        })),
      });
    }
    return [null, results];
  } catch (err) {
    return [err, []];
  }
};
