import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@showtrak/protocol';

/**
 * The client's Socket.IO connection to a ShowTrak server.
 *
 * NOTE the generic order: socket.io-client takes <ListenEvents, EmitEvents>, so
 * the server's outbound map comes FIRST here — the reverse of how the server
 * parameterises its own `Server`/`Socket`.
 */
export type ShowTrakSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
