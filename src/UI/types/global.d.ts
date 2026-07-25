// Globals available to the renderer windows.
//
// Each preload exposes exactly one bridge object, and the interfaces come from
// src/types/preload.d.ts — the same file the preloads implement — so a channel
// added on one side and not the other fails to compile.
//
// jQuery and Bootstrap stay external <script> globals (loaded from
// src/UI/vendors) rather than bundled; `types: ["jquery"]` in
// tsconfig.renderer.json supplies the `$` declaration.

import type {
  ClientPreloadAPI,
  IdentifyPreloadAPI,
  LaunchCountdownPreloadAPI,
} from '../../types/preload';

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
