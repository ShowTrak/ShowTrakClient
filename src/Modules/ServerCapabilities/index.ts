import type { ShowTrakSocket } from '../../types/socket';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('ServerCapabilities');

/**
 * What the currently connected server has told us it understands.
 *
 * The client and the server are versioned and updated independently — there is
 * no minimum-version gate on either side — so a new client routinely talks to an
 * older server. Incremental telemetry (the `*Delta` events) only exists on newer
 * servers, and an older one silently drops unknown events, which would turn a
 * change that used to be reported in seconds into one reported at the next
 * resync.
 *
 * So deltas are opt-in per connection: the client asks, and only uses them if
 * the server answers. Because an older server has no handler for the probe, its
 * acknowledgement is never invoked at all — the absence of a reply IS the
 * answer, which is why this defaults to false and is never given a timeout-based
 * default of true.
 */
let supportsDeltas = false;

export const Manager = {
  /**
   * Ask the connected server what it supports.
   *
   * Resolves as soon as the probe has been sent, not when it is answered: the
   * reply may never come, and nothing should wait on it. Callers carry on with
   * full-list reporting and pick up deltas from whenever the answer lands.
   */
  Probe(Socket: ShowTrakSocket): void {
    supportsDeltas = false;
    try {
      Socket.emit('GetServerCapabilities', (Capabilities) => {
        supportsDeltas = !!(Capabilities && Capabilities.Deltas);
        Logger.log(
          supportsDeltas
            ? 'Server supports incremental telemetry; enabling deltas'
            : 'Server reported no delta support; staying on full lists'
        );
      });
    } catch (error) {
      Logger.warn('Failed to probe server capabilities; staying on full lists', error);
    }
  },

  /** Reset to the safe default. Called whenever the connection drops. */
  Reset(): void {
    supportsDeltas = false;
  },

  SupportsDeltas(): boolean {
    return supportsDeltas;
  },
};
