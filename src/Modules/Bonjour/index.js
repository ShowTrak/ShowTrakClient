const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('Bonjour');

const bonjour = require('bonjour');
const os = require('os');

let instance = null;
let browser = null;
let __updateTimer = null;
let __timeoutTimer = null;
let __fallbackLaunched = false;
let __found = false;
// Fallback per-interface discovery state
let __fallbackInstances = [];
let __fallbackBrowsers = [];
let __fallbackTimeoutTimer = null;

async function diagnoseServiceTypes() {
  // Helper: briefly browse for advertised service types to aid debugging
  try {
    Logger.log('Bonjour diagnostics: scanning _services._dns-sd._udp for available types');
    const diag = instance.find({ type: '_services._dns-sd._udp', protocol: 'udp' });
    diag.on('up', (svc) => {
      try { Logger.log('Bonjour diagnostics up:', svc && svc.name ? svc.name : svc); } catch {}
    });
    diag.on('error', (e) => Logger.error('Bonjour diagnostics error:', e));
    try { diag.start(); } catch {}
    setTimeout(() => { try { diag.stop(); } catch {} }, 3000);
  } catch (e) {
    Logger.error('Bonjour diagnostics exception:', e);
  }
}

const Manager = {
  OnFind: (callback) => {
    Logger.log('Bonjour.OnFind invoked');
    // Create instance; classic bonjour opts
    if (!instance) {
      try {
        instance = bonjour({ reuseAddr: true, loopback: true });
        Logger.log('Bonjour instance created');
      } catch (e) {
        Logger.error('Failed to create Bonjour instance:', e);
        return;
      }
    } else {
      Logger.log('Bonjour instance already exists');
    }

    // Stop any previous browser
    try {
      if (browser) {
        browser.stop();
        browser.removeAllListeners();
      }
    } catch {}

  // Primary: lowercase service type (matches server)
    try {
      browser = instance.findOne({ type: 'showtrak' }, (svc) => {
        try {
          const meta = {
            name: svc.name,
            fqdn: svc.fqdn,
            host: svc.host,
            port: svc.port,
            type: svc.type,
            txt: svc.txt,
            addresses: svc.addresses,
          };
          Logger.log(`Bonjour findOne matched: ${JSON.stringify(meta)}`);
        } catch {}
    finalizeFound(callback, svc);
      });
    } catch (e) {
      Logger.error('Failed to start Bonjour browser:', e);
      return;
    }

    browser.on('down', (svc) => { try { Logger.log(`Bonjour down: ${svc?.fqdn || svc?.host || 'unknown'}`); } catch {} });

    // Start and force an initial update when ready
    try {
      browser.start();
      Logger.log('Bonjour browser started');
      setTimeout(() => {
        try { Logger.log('Bonjour initial update'); browser.update(); } catch {}
      }, 100);
    } catch {}

    // Periodically refresh to catch late announcements
    try {
      if (__updateTimer) clearInterval(__updateTimer);
      __updateTimer = setInterval(() => {
        Logger.log('Bonjour update tick');
        try { if (browser) browser.update(); } catch {}
      }, 5000);
    } catch {}

  // If nothing found within 10s, dump diagnostics and list any known services, then launch per-interface fallback
    try {
      if (__timeoutTimer) clearTimeout(__timeoutTimer);
      __timeoutTimer = setTimeout(async () => {
        try {
          let servicesCount = 0;
          try { servicesCount = (browser && Array.isArray(browser.services)) ? browser.services.length : 0; } catch {}
          Logger.warn(`Bonjour timeout: no showtrak service discovered after 10s. Known services: ${servicesCount}`);
        } catch {}
        await diagnoseServiceTypes();
        try { if (browser) browser.update(); } catch {}
        try { if (!__fallbackLaunched) { launchPerInterfaceFallback(callback); } } catch {}
      }, 10000);
    } catch {}
  },
  Stop: async () => {
    try { if (__updateTimer) { clearInterval(__updateTimer); __updateTimer = null; } } catch {}
    try { if (__timeoutTimer) { clearTimeout(__timeoutTimer); __timeoutTimer = null; } } catch {}
    try { if (__fallbackTimeoutTimer) { clearTimeout(__fallbackTimeoutTimer); __fallbackTimeoutTimer = null; } } catch {}
    Logger.log('Bonjour.Stop called');
    try { if (browser) { browser.stop(); browser.removeAllListeners(); browser = null; Logger.log('Bonjour browser stopped'); } } catch {}
    // Stop fallback resources
    try {
      for (const b of __fallbackBrowsers) { try { b.stop(); b.removeAllListeners(); } catch {} }
      for (const inst of __fallbackInstances) { try { inst.destroy(); } catch {} }
    } catch {}
    __fallbackBrowsers = [];
    __fallbackInstances = [];
    __fallbackLaunched = false;
    __found = false;
  },
  Terminate: async () => {
    try { if (__updateTimer) { clearInterval(__updateTimer); __updateTimer = null; } } catch {}
    try { if (__timeoutTimer) { clearTimeout(__timeoutTimer); __timeoutTimer = null; } } catch {}
    try { if (__fallbackTimeoutTimer) { clearTimeout(__fallbackTimeoutTimer); __fallbackTimeoutTimer = null; } } catch {}
    Logger.log('Bonjour.Terminate called');
    try { if (browser) { browser.stop(); browser.removeAllListeners(); browser = null; Logger.log('Bonjour browser stopped'); } } catch {}
    try {
      for (const b of __fallbackBrowsers) { try { b.stop(); b.removeAllListeners(); } catch {} }
      for (const inst of __fallbackInstances) { try { inst.destroy(); } catch {} }
    } catch {}
    __fallbackBrowsers = [];
    __fallbackInstances = [];
    __fallbackLaunched = false;
    __found = false;
    if (!instance) return;
    try { instance.destroy(); } catch {}
    instance = null;
    console.log('Bonjour service shut down.');
  },
};

function finalizeFound(callback, svc) {
  if (__found) return;
  __found = true;
  try { if (__timeoutTimer) { clearTimeout(__timeoutTimer); __timeoutTimer = null; } } catch {}
  try { if (__updateTimer) { clearInterval(__updateTimer); __updateTimer = null; } } catch {}
  try { if (__fallbackTimeoutTimer) { clearTimeout(__fallbackTimeoutTimer); __fallbackTimeoutTimer = null; } } catch {}
  // Stop all browsers and destroy fallback instances
  try { if (browser) { browser.stop(); browser.removeAllListeners(); browser = null; } } catch {}
  try { for (const b of __fallbackBrowsers) { try { b.stop(); b.removeAllListeners(); } catch {} } } catch {}
  try { for (const inst of __fallbackInstances) { try { inst.destroy(); } catch {} } } catch {}
  __fallbackBrowsers = [];
  __fallbackInstances = [];
  __fallbackLaunched = false;
  try { callback(svc); } catch (e) { Logger.error('Bonjour final callback error:', e); }
}

function launchPerInterfaceFallback(callback) {
  __fallbackLaunched = true;
  try {
    const ifaces = os.networkInterfaces();
    const ipv4s = [];
    for (const name of Object.keys(ifaces)) {
      for (const addr of (ifaces[name] || [])) {
        if (addr && addr.family === 'IPv4' && !addr.internal) ipv4s.push(addr.address);
      }
    }
    Logger.warn(`Bonjour per-interface fallback starting on ${ipv4s.length} IPv4 interfaces`);
    const typesToTry = ['showtrak', 'ShowTrak']; // try legacy case too just in case
    for (const ip of ipv4s) {
      for (const t of typesToTry) {
        try {
          // Use the classic bonjour() factory; bind per-interface with loopback for local testing
          const inst = bonjour({ interface: ip, reuseAddr: true, loopback: true });
          const b = inst.findOne({ type: t, protocol: 'tcp' }, (svc) => {
            try {
              Logger.log(`Bonjour fallback matched on ${ip} for type ${t}: ${svc && svc.host}:${svc && svc.port}`);
            } catch {}
            finalizeFound(callback, svc);
          });
          b.on('error', (e) => Logger.error('Bonjour fallback browser error:', e));
          try { b.start(); setTimeout(() => { try { b.update(); } catch {} }, 100); } catch {}
          __fallbackInstances.push(inst);
          __fallbackBrowsers.push(b);
        } catch (e) {
          Logger.error('Bonjour fallback create error for interface', ip, e);
        }
      }
    }
    // End fallback after 10s if nothing found
    try {
      if (__fallbackTimeoutTimer) clearTimeout(__fallbackTimeoutTimer);
      __fallbackTimeoutTimer = setTimeout(() => {
        if (!__found) Logger.warn('Bonjour per-interface fallback timed out without discovery');
      }, 10000);
    } catch {}
  } catch (e) {
    Logger.error('Bonjour per-interface fallback exception:', e);
  }
}

module.exports = {
  Manager,
};
