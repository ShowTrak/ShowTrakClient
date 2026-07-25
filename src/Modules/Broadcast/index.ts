// In-process event bus shared by the main-process modules.
//
// Backed by a plain Node EventEmitter, but exposed through TypedBroadcastEmitter
// so every channel name and payload is checked against ClientBroadcastEvents
// (src/types/broadcast.d.ts). A mistyped channel used to fail silently — a
// listener that never fires — which is why this is typed rather than left bare.
import { EventEmitter } from 'events';

import type { TypedBroadcastEmitter } from '../../types/broadcast';

export const Manager: TypedBroadcastEmitter = new EventEmitter() as TypedBroadcastEmitter;
