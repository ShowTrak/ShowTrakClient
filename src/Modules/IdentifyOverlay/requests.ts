// The server's Identify and StopIdentify, answered the same way on both of the
// client's connections: the adopted one (MainClient) and a pending one
// (AdoptionClient), so an operator can locate a freshly discovered machine from
// the DISCOVER lane too. The overlay itself belongs to the main process
// (./index.ts), reached over the broadcast bus; this file stays free of Electron.
import type { ShowTrakSocket } from '../../types/socket';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as OS } from '../OS';

/** Show and hide the identify overlay when the server on `Socket` asks. */
export function HandleIdentifyRequests(Socket: ShowTrakSocket): void {
  // The details shown are this machine's own; only the nickname comes from the
  // server, which is the one place it is known.
  Socket.on('Identify', async (Payload = {}) => {
    const Nickname =
      Payload && typeof Payload.Nickname === 'string' && Payload.Nickname.trim()
        ? Payload.Nickname.trim()
        : null;
    BroadcastManager.emit('ShowIdentifyOverlay', {
      Hostname: OS.Hostname,
      Nickname,
      IPs: OS.GetLocalIPv4Addresses(),
    });
  });

  Socket.on('StopIdentify', async () => {
    BroadcastManager.emit('HideIdentifyOverlay');
  });
}
