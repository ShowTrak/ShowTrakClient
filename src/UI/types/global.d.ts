// Globals available to the renderer windows.
//
// Each preload exposes exactly one bridge object, and the interfaces come from
// @showtrak/protocol/client — the same contract the preloads implement — so a
// channel added on one side and not the other fails to compile.

import type {
  ClientPreloadAPI,
  IdentifyPreloadAPI,
  LaunchCountdownPreloadAPI,
} from '@showtrak/protocol/client';

declare global {
  interface Window {
    /** Config window bridge (src/preload.ts). */
    API: ClientPreloadAPI;
    /** Identify overlay bridge (src/identify-preload.ts); absent elsewhere. */
    IdentifyAPI?: IdentifyPreloadAPI;
    /** Launch countdown bridge (src/launch-countdown-preload.ts); absent elsewhere. */
    LaunchCountdownAPI?: LaunchCountdownPreloadAPI;
  }
}

export {};
