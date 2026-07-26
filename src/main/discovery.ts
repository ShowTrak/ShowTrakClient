// mDNS/Bonjour discovery of a ShowTrak server.
//
// Extracted from main.ts unchanged. Self-contained: it owns no long-lived state,
// so unlike most of what came out of main.ts it needs no accessor plumbing —
// each call sets up a browser, resolves the first usable record, and tears down.

import { promises as dns } from 'node:dns';

import { CreateLogger } from '../Modules/Logger';
import { Manager as BonjourManager } from '../Modules/Bonjour';
import { ReadIdentityToken } from '../Modules/Utils';
import type { DiscoveredService } from '../Modules/Bonjour';

const Logger = CreateLogger('Discovery');

/** A ShowTrak server discovered over Bonjour (or configured manually). */
interface ServerCandidate {
  IP: string;
  Port: number;
  ServerIdentity: string | null;
}

function extractServerIdentityToken(Service: DiscoveredService | null | undefined): string {
  return ReadIdentityToken(Service && Service.txt ? Service.txt : null);
}

// Resolve the first Bonjour record that looks like a usable ShowTrak server.
//
// When ExpectedServerIdentity is set, records advertising a different identity
// are skipped rather than accepted — that is what stops a recovering client
// re-homing itself onto somebody else's server on a shared network.
async function discoverSingleServer(
  timeoutMs = 12000,
  Options: { ExpectedServerIdentity?: string } = {}
): Promise<ServerCandidate | null> {
  return new Promise((resolve) => {
    let settled = false;
    const ExpectedServerIdentity = ReadIdentityToken(Options, 'ExpectedServerIdentity');

    const finish = async (Result: ServerCandidate | null) => {
      if (settled) return;
      settled = true;
      try {
        await BonjourManager.Stop();
      } catch (Err) {
        Logger.debug('Bonjour stop failed while finishing discovery', String(Err));
      }
      resolve(Result || null);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    BonjourManager.OnFind(async (Server) => {
      Logger.log('Bonjour service found:', Server);
      try {
        const ServerIdentity = extractServerIdentityToken(Server);
        if (ExpectedServerIdentity && ServerIdentity !== ExpectedServerIdentity) {
          Logger.warn(
            `Skipping discovered server due to identity mismatch (${ServerIdentity || 'missing'} != ${ExpectedServerIdentity})`
          );
          return;
        }

        const addrs = Array.isArray(Server.addresses) ? Server.addresses : [];
        let targetIP = addrs.find((a) => typeof a === 'string' && a.includes('.')) || null;
        if (
          !targetIP &&
          Server.referer &&
          typeof Server.referer.address === 'string' &&
          Server.referer.address.includes('.')
        ) {
          targetIP = Server.referer.address;
        }
        if (!targetIP && typeof Server.host === 'string' && Server.host.length) {
          try {
            const looked = await dns.lookup(Server.host, { family: 4 });
            if (looked && looked.address) targetIP = looked.address;
          } catch (Err) {
            Logger.debug(`DNS lookup failed for ${Server.host}`, String(Err));
          }
        }
        if (!targetIP) {
          Logger.warn(
            'Bonjour service discovered but no IPv4 address resolved; skipping this record.'
          );
          return;
        }

        clearTimeout(timer);
        Logger.log(`Discovered ShowTrak Server at ${targetIP}:${Server.port}`);
        await finish({
          IP: targetIP,
          Port: Server.port,
          ServerIdentity: ServerIdentity || null,
        });
      } catch (Err) {
        clearTimeout(timer);
        Logger.error('Failed to process Bonjour discovery record', Err);
        await finish(null);
      }
    });
  });
}

export { discoverSingleServer, extractServerIdentityToken };
export type { ServerCandidate };
