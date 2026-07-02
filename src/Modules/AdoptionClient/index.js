const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('AdopptionClient');

const { io } = require('socket.io-client');
var Socket = null;
const { Config } = require('../Config');
const { Manager: OSManager } = require('../OS');
const { Manager: BroadcastManager } = require('../Broadcast');

const { Manager: ProfileManager } = require('../ProfileManager');

let adoptionHeartbeatInterval = null;

// When the identify overlay is dismissed locally (esc/click) while this client
// is still pending adoption, notify the server so it clears identify state.
// Guarded for unit tests that provide a partial BroadcastManager mock.
if (BroadcastManager && typeof BroadcastManager.on === 'function') {
  BroadcastManager.on('IdentifyStoppedByUser', () => {
    if (Socket && Socket.connected) Socket.emit('IdentifyStopped');
  });
}

function clearHeartbeatInterval() {
  if (adoptionHeartbeatInterval) {
    clearInterval(adoptionHeartbeatInterval);
    adoptionHeartbeatInterval = null;
  }
}

const Manager = {
  Terminate: async () => {
    clearHeartbeatInterval();
    if (Socket) {
      Socket.disconnect();
      Socket = null;
      Logger.log('AdoptionClientManager terminated.');
    } else {
      Logger.log('No active socket to terminate.');
    }
  },
  Init: async (UUID, IP, Port, Options = {}) => {
    const BootTime = Date.now();
    const ServerIdentity =
      Options && typeof Options.ServerIdentity === 'string' && Options.ServerIdentity.trim()
        ? Options.ServerIdentity.trim()
        : null;
    clearHeartbeatInterval();

    if (Socket) Socket.disconnect();

    Socket = io(`http://${IP}:${Port}`, {
      autoConnect: true,
      transports: ['websocket'],
      query: {
        UUID: UUID,
        Adopted: false,
      },
    });

    // Example: Listen for connection
    Socket.on('connect', async () => {
      Logger.log('Connected to host and advertised for adoption. UUID:', UUID);
      await SendAdoptionHeartbeat();
    });

    async function SendAdoptionHeartbeat() {
      if (!Socket || !Socket.connected) return;
      Socket.emit('AdoptionHeartbeat', {
        BootTime: BootTime,
        Hostname: OSManager.Hostname,
        OperatingSystem: OSManager.OperatingSystem,
        Version: Config.Application.Version,
        ...(ServerIdentity ? { ServerIdentity } : {}),
      });
      return;
    }

    adoptionHeartbeatInterval = setInterval(SendAdoptionHeartbeat, 10000);

    Socket.on('disconnect', () => {
      Logger.log('Disconnected from server');
      BroadcastManager.emit('HideIdentifyOverlay');
    });

    Socket.on('connect_error', () => {
      // Ensure identify overlay is never left open during transient failures.
      BroadcastManager.emit('HideIdentifyOverlay');
    });

    Socket.on('Adopt', async () => {
      Logger.log('Adopt command received');
      await ProfileManager.Adopt(IP, Port, { ServerIdentity });
      BroadcastManager.emit('ReinitializeService');
    });

    // Identify mode also works before adoption so an operator can locate a
    // freshly-discovered machine from the DISCOVER lane.
    Socket.on('Identify', async (Payload = {}) => {
      const Nickname =
        Payload && typeof Payload.Nickname === 'string' && Payload.Nickname.trim()
          ? Payload.Nickname.trim()
          : null;
      BroadcastManager.emit('ShowIdentifyOverlay', {
        Hostname: OSManager.Hostname,
        Nickname,
        IPs: OSManager.GetLocalIPv4Addresses(),
      });
    });

    Socket.on('StopIdentify', async () => {
      BroadcastManager.emit('HideIdentifyOverlay');
    });
  },
};

module.exports = {
  Manager,
};
