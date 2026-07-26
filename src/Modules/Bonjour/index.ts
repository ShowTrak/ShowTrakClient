// mDNS/Bonjour discovery of a ShowTrak server.
//
// Two strategies, in order:
//
//   1. A single default browse for the `showtrak` service type. This is what
//      works on a normal flat LAN.
//   2. If nothing is found within DISCOVERY_TIMEOUT_MS, a per-interface fallback
//      that binds a separate browser to every external IPv4 NIC. This exists
//      because real venue machines have several NICs (a show LAN, a house LAN, a
//      dock) and the default multicast bind does not reliably reach all of them.
//
// Whichever finds a server first wins; finalizeFound() then tears down everything
// the other strategy opened.
//
// This module used to contain 42 empty `catch {}` blocks behind a file-level
// `eslint-disable no-empty`, which made every discovery failure structurally
// unobservable — the exact failure operators report as "the client just never
// found the server". They all log now. They still do not rethrow: discovery must
// degrade to "found nothing" rather than take down an unattended agent, but it
// should say so in the log file the operator sends back.
//
// Teardown used to be written out three times (Stop, Terminate, finalizeFound) in
// near-identical ~45-line blocks, so a leaked timer or browser fixed in one path
// stayed leaked in the other two. There is now one Teardown().
import bonjour from 'bonjour';
import os from 'os';

import { CreateLogger } from '../Logger';

const Logger = CreateLogger('Bonjour');

type BonjourInstance = bonjour.Bonjour;
type BonjourBrowser = bonjour.Browser;
/** A discovered ShowTrak server advertisement. */
export type DiscoveredService = bonjour.RemoteService;

type FindCallback = (service: DiscoveredService) => void;

/** The service type the server advertises. */
const SERVICE_TYPE = 'showtrak';

/**
 * Service types the per-interface fallback tries.
 *
 * One entry, deliberately. The Server advertised `type: 'ShowTrak'` from v3.0.0
 * (2025-07-13) and switched to lowercase in v3.1.5 (2025-08-17), so the fallback
 * used to try both spellings — which doubled the Bonjour instances it opened, i.e.
 * `interfaces x 2` multicast sockets on a multi-NIC show machine. Support for
 * servers at or below 3.1.5 is dropped, so the capitalised spelling is gone.
 *
 * Kept as an array rather than collapsed into the loop: if a future rename needs a
 * transition window, this is the one place to widen.
 */
const FALLBACK_SERVICE_TYPES = [SERVICE_TYPE];

/** How long the default browse gets before the per-interface fallback starts. */
const DISCOVERY_TIMEOUT_MS = 10000;
/** How long the fallback runs before it gives up (on expiry it only logs). */
const FALLBACK_TIMEOUT_MS = 10000;
/** Periodic re-query, to catch a server that announced before we were listening. */
const BROWSER_REFRESH_INTERVAL_MS = 5000;
/** Delay before the first manual nudge, giving the socket time to bind. */
const INITIAL_UPDATE_DELAY_MS = 100;
/** How long the diagnostic service-type sweep is allowed to run. */
const DIAGNOSTIC_WINDOW_MS = 3000;

let instance: BonjourInstance | null = null;
let browser: BonjourBrowser | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let timeoutTimer: NodeJS.Timeout | null = null;
let fallbackTimeoutTimer: NodeJS.Timeout | null = null;
let fallbackLaunched = false;
let found = false;
// Per-interface fallback state.
let fallbackInstances: BonjourInstance[] = [];
let fallbackBrowsers: BonjourBrowser[] = [];

// Run a step that is expected to be able to fail (a socket already closed, a
// browser mid-stop). Logs instead of swallowing, and never rethrows — one failing
// step must not strand the rest of the cleanup.
function attempt(what: string, action: () => void): void {
  try {
    action();
  } catch (Err) {
    Logger.debug(`${what} failed`, String(Err));
  }
}

function clearTimers(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
  if (fallbackTimeoutTimer) {
    clearTimeout(fallbackTimeoutTimer);
    fallbackTimeoutTimer = null;
  }
}

interface TeardownOptions {
  /** Also destroy the shared instance (Terminate only; Stop keeps it for reuse). */
  destroyInstance?: boolean;
  /** Clear the found latch, so a later OnFind can match again. */
  resetFound?: boolean;
}

// Release everything discovery opened: timers, the default browser, and every
// per-interface fallback browser and instance.
//
// The single implementation behind Stop(), Terminate() and finalizeFound(). Each
// step is independently guarded, so a browser that refuses to stop cannot prevent
// the fallback instances being destroyed — that combination previously leaked a
// multicast socket per NIC on every failed discovery.
function Teardown({ destroyInstance = false, resetFound = false }: TeardownOptions = {}): void {
  clearTimers();

  if (browser) {
    const doomed = browser;
    browser = null;
    attempt('Stopping the default browser', () => {
      doomed.stop();
      doomed.removeAllListeners();
    });
    Logger.debug('Bonjour browser stopped');
  }

  for (const fallbackBrowser of fallbackBrowsers) {
    attempt('Stopping a fallback browser', () => {
      fallbackBrowser.stop();
      fallbackBrowser.removeAllListeners();
    });
  }
  for (const fallbackInstance of fallbackInstances) {
    attempt('Destroying a fallback instance', () => fallbackInstance.destroy());
  }
  fallbackBrowsers = [];
  fallbackInstances = [];
  fallbackLaunched = false;

  if (resetFound) found = false;

  if (destroyInstance && instance) {
    const doomed = instance;
    instance = null;
    attempt('Destroying the Bonjour instance', () => doomed.destroy());
  }
}

// Briefly browse for advertised service types, to answer "is anything announcing
// on this network at all?" when a ShowTrak server was expected and not found.
async function diagnoseServiceTypes(): Promise<void> {
  if (!instance) return;
  try {
    Logger.log('Bonjour diagnostics: scanning _services._dns-sd._udp for available types');
    const diag = instance.find({ type: '_services._dns-sd._udp', protocol: 'udp' });
    diag.on('up', (svc) => {
      Logger.log('Bonjour diagnostics up:', svc && svc.name ? svc.name : svc);
    });
    // @types/bonjour narrows Browser.on to 'up' | 'down', which hides the
    // inherited EventEmitter overload — but the library really does emit
    // 'error' (forwarded from the multicast-dns socket). Browser extends
    // EventEmitter, so widening to the base interface is sound.
    (diag as NodeJS.EventEmitter).on('error', (e: unknown) =>
      Logger.error('Bonjour diagnostics error:', e)
    );
    attempt('Starting the diagnostic browse', () => diag.start());
    setTimeout(() => {
      attempt('Stopping the diagnostic browse', () => diag.stop());
    }, DIAGNOSTIC_WINDOW_MS);
  } catch (Err) {
    Logger.error('Bonjour diagnostics exception:', Err);
  }
}

export const Manager = {
  OnFind: (callback: FindCallback): void => {
    Logger.log('Bonjour.OnFind invoked');
    if (!instance) {
      try {
        instance = bonjour({ reuseAddr: true, loopback: true });
        Logger.log('Bonjour instance created');
      } catch (Err) {
        Logger.error('Failed to create Bonjour instance:', Err);
        return;
      }
    } else {
      Logger.log('Bonjour instance already exists');
    }

    // Stop any previous browser before replacing it.
    if (browser) {
      const previous = browser;
      browser = null;
      attempt('Stopping the previous browser', () => {
        previous.stop();
        previous.removeAllListeners();
      });
    }

    try {
      browser = instance.findOne({ type: SERVICE_TYPE }, (svc) => {
        Logger.log(
          `Bonjour findOne matched: ${JSON.stringify({
            name: svc.name,
            fqdn: svc.fqdn,
            host: svc.host,
            port: svc.port,
            type: svc.type,
            txt: svc.txt,
            addresses: svc.addresses,
          })}`
        );
        finalizeFound(callback, svc);
      });
    } catch (Err) {
      Logger.error('Failed to start Bonjour browser:', Err);
      return;
    }

    browser.on('down', (svc) => {
      Logger.log(`Bonjour down: ${svc?.fqdn || svc?.host || 'unknown'}`);
    });

    // Start, then nudge once the socket has had a moment to bind. Both are
    // best-effort: the periodic refresh below is the real mechanism, and it is
    // installed regardless of whether start() worked.
    attempt('Starting the default browser', () => {
      browser?.start();
      Logger.log('Bonjour browser started');
    });
    setTimeout(() => {
      attempt('Initial browser update', () => {
        Logger.log('Bonjour initial update');
        browser?.update();
      });
    }, INITIAL_UPDATE_DELAY_MS);

    // Periodically refresh to catch late announcements.
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(() => {
      Logger.log('Bonjour update tick');
      attempt('Periodic browser update', () => browser?.update());
    }, BROWSER_REFRESH_INTERVAL_MS);

    // Nothing yet? Dump diagnostics, re-query, then start the per-interface
    // fallback.
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(async () => {
      let servicesCount = 0;
      try {
        servicesCount = browser && Array.isArray(browser.services) ? browser.services.length : 0;
      } catch (Err) {
        Logger.debug('Could not read the browser service list', String(Err));
      }
      Logger.warn(
        `Bonjour timeout: no ${SERVICE_TYPE} service discovered after ${DISCOVERY_TIMEOUT_MS / 1000}s. Known services: ${servicesCount}`
      );

      await diagnoseServiceTypes();
      attempt('Post-timeout browser update', () => browser?.update());
      if (!fallbackLaunched) {
        attempt('Launching the per-interface fallback', () => launchPerInterfaceFallback(callback));
      }
    }, DISCOVERY_TIMEOUT_MS);
  },

  // Release the browsers and timers but keep the shared instance, so a following
  // OnFind can reuse it.
  Stop: async (): Promise<void> => {
    Logger.log('Bonjour.Stop called');
    Teardown({ resetFound: true });
  },

  // Release everything, including the shared instance.
  Terminate: async (): Promise<void> => {
    Logger.log('Bonjour.Terminate called');
    const hadInstance = !!instance;
    Teardown({ destroyInstance: true, resetFound: true });
    if (hadInstance) Logger.log('Bonjour service shut down.');
  },
};

// Accept the first matching service and release everything else.
//
// Latched: several browsers race (the default one plus up to two per NIC), and the
// caller must be handed exactly one result.
function finalizeFound(callback: FindCallback, svc: DiscoveredService): void {
  if (found) return;
  found = true;

  // Teardown before the callback, so the callback runs with every socket already
  // released — it typically starts connecting to the server it was just handed.
  Teardown();

  try {
    callback(svc);
  } catch (Err) {
    Logger.error('Bonjour final callback error:', Err);
  }
}

// Bind a browser to every external IPv4 interface.
//
// The default multicast bind does not reliably reach all NICs on a multi-homed
// machine, which is common on show hardware. One instance per (interface, type)
// pair; all of them are torn down by the first match.
function launchPerInterfaceFallback(callback: FindCallback): void {
  fallbackLaunched = true;
  try {
    const ifaces = os.networkInterfaces();
    const ipv4s: string[] = [];
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr && addr.family === 'IPv4' && !addr.internal) ipv4s.push(addr.address);
      }
    }
    Logger.warn(`Bonjour per-interface fallback starting on ${ipv4s.length} IPv4 interfaces`);

    for (const ip of ipv4s) {
      for (const type of FALLBACK_SERVICE_TYPES) {
        try {
          const inst = bonjour({ interface: ip, reuseAddr: true, loopback: true });
          const fallbackBrowser = inst.findOne({ type, protocol: 'tcp' }, (svc) => {
            Logger.log(
              `Bonjour fallback matched on ${ip} for type ${type}: ${svc && svc.host}:${svc && svc.port}`
            );
            finalizeFound(callback, svc);
          });
          // See the note in diagnoseServiceTypes: 'error' is real but untyped.
          (fallbackBrowser as NodeJS.EventEmitter).on('error', (e: unknown) =>
            Logger.error('Bonjour fallback browser error:', e)
          );
          attempt(`Starting the fallback browser on ${ip}`, () => {
            fallbackBrowser.start();
            setTimeout(() => {
              attempt(`Updating the fallback browser on ${ip}`, () => fallbackBrowser.update());
            }, INITIAL_UPDATE_DELAY_MS);
          });
          fallbackInstances.push(inst);
          fallbackBrowsers.push(fallbackBrowser);
        } catch (Err) {
          Logger.error('Bonjour fallback create error for interface', ip, Err);
        }
      }
    }

    if (fallbackTimeoutTimer) clearTimeout(fallbackTimeoutTimer);
    fallbackTimeoutTimer = setTimeout(() => {
      if (!found) Logger.warn('Bonjour per-interface fallback timed out without discovery');
    }, FALLBACK_TIMEOUT_MS);
  } catch (Err) {
    Logger.error('Bonjour per-interface fallback exception:', Err);
  }
}
