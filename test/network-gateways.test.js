const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// Default gateways (routers) per interface — src/Modules/NetworkMonitor/gateways.ts
// — and how NetworkMonitor merges them into its reports.
//
// The parsers are fed real-shaped routing-table output for each platform. The
// one rule that matters most: a routing table that could not be read must leave
// `gateway` ABSENT, because the server reads absent as "unknown" and null as
// "this interface has no router" — and only the second can raise a fault.

const Gateways = require('../dist/Modules/NetworkMonitor/gateways.js');

const LINUX_ROUTE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  'wlan0\t00000000\tFE00000A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'wlan0\t00000000\t0100000A\t0003\t0\t0\t50\t00000000\t0\t0\t0',
  'dummy0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0',
].join('\n');

const MAC_NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.1.1        UGScg                 en0
default            10.0.0.1           UGScIg                en7
default            link#21            UCSIg            bridge100      !
127                127.0.0.1          UCS                   lo0
192.168.1          link#6             UCS                   en0      !
`;

const MAC_NETSTAT_OLD = `Routing tables

Internet:
Destination        Gateway            Flags        Refs      Use   Netif Expire
default            192.168.1.1        UGSc           12        0     en0
`;

const WINDOWS_ROUTE = `===========================================================================
Interface List
 12...aa bb cc dd ee ff ......Intel(R) Ethernet Connection
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.50     25
          0.0.0.0          0.0.0.0         10.0.0.1       10.0.0.20     35
          0.0.0.0          0.0.0.0       10.0.0.254       10.0.0.20     10
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
      192.168.1.0    255.255.255.0         On-link      192.168.1.50    281
===========================================================================
Persistent Routes:
  Network Address          Netmask  Gateway Address  Metric
          0.0.0.0          0.0.0.0      172.16.0.1  Default
===========================================================================
`;

const WINDOWS_INTERFACES = [
  { name: 'Ethernet', addresses: [{ family: 'IPv4', address: '192.168.1.50' }] },
  { name: 'Show Network', addresses: [{ family: 'IPv4', address: '10.0.0.20' }] },
];

test('Linux: default routes from /proc/net/route, lowest metric per interface', () => {
  const map = Gateways.ParseLinuxRouteTable(LINUX_ROUTE);
  assert.deepEqual(Object.fromEntries(map), { eth0: '192.168.1.1', wlan0: '10.0.0.1' });
  assert.equal(Gateways.ParseLinuxRouteTable('garbage').size, 0);
});

test('macOS: the first default per interface, columns found from the header', () => {
  assert.deepEqual(Object.fromEntries(Gateways.ParseMacNetstat(MAC_NETSTAT)), {
    en0: '192.168.1.1',
    en7: '10.0.0.1',
  });
  assert.deepEqual(Object.fromEntries(Gateways.ParseMacNetstat(MAC_NETSTAT_OLD)), {
    en0: '192.168.1.1',
  });
});

test('Windows: interface addresses become names; on-link and persistent lines are skipped', () => {
  const map = Gateways.ParseWindowsRoutePrint(WINDOWS_ROUTE, WINDOWS_INTERFACES);
  assert.deepEqual(Object.fromEntries(map), {
    Ethernet: '192.168.1.1',
    'Show Network': '10.0.0.254',
  });
  assert.equal(Gateways.ParseWindowsRoutePrint(WINDOWS_ROUTE, []).size, 0);
});

test('ReadGateways picks the reader by platform and reports a failed read as an error', async () => {
  const calls = [];
  const readers = {
    RunCommand: async (command, args) => {
      calls.push([command, ...args]);
      return command === 'netstat' ? [null, MAC_NETSTAT] : [null, WINDOWS_ROUTE];
    },
    ReadFile: async (file) => {
      calls.push(['read', file]);
      return [null, LINUX_ROUTE];
    },
  };
  assert.equal((await Gateways.ReadGateways([], 'linux', readers))[1].get('eth0'), '192.168.1.1');
  assert.equal((await Gateways.ReadGateways([], 'darwin', readers))[1].get('en0'), '192.168.1.1');
  assert.equal(
    (await Gateways.ReadGateways(WINDOWS_INTERFACES, 'win32', readers))[1].get('Ethernet'),
    '192.168.1.1'
  );
  assert.deepEqual(calls, [
    ['read', '/proc/net/route'],
    ['netstat', '-rn', '-f', 'inet'],
    ['route', 'print', '-4'],
  ]);

  const failing = {
    RunCommand: async () => [new Error('ENOENT'), null],
    ReadFile: async () => [new Error('EACCES'), null],
  };
  for (const platform of ['linux', 'darwin', 'win32', 'aix']) {
    const [err, map] = await Gateways.ReadGateways([], platform, failing);
    assert.ok(err, platform);
    assert.equal(map, null, platform);
  }
});

// --- NetworkMonitor merge ------------------------------------------------------

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'NetworkMonitor', 'index.js');

function load(readGateways) {
  const emissions = [];
  const socket = { connected: true, emit: (event, payload) => emissions.push([event, payload]) };
  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../ServerCapabilities': { Manager: { SupportsDeltas: () => false } },
    '../OS': {
      Manager: {
        GetNetworkInterfaces: async () => [
          null,
          [{ name: 'en0', addresses: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] }],
        ],
      },
    },
    './gateways': { ReadGateways: readGateways },
  });
  return { Manager, socket, emissions };
}

test('reports carry each interface router once the table has been read', async () => {
  const { Manager, socket, emissions } = load(async () => [null, new Map([['en0', '10.0.0.1']])]);
  await Manager.Start(socket);
  await Manager.Stop();
  const [event, list] = emissions[0];
  assert.equal(event, 'NetworkInterfaces');
  assert.equal(list[0].gateway, '10.0.0.1');
});

test('an interface without a default route reports null', async () => {
  const { Manager, socket, emissions } = load(async () => [null, new Map()]);
  await Manager.Start(socket);
  await Manager.Stop();
  assert.equal(emissions[0][1][0].gateway, null);
});

test('an unreadable routing table leaves gateway absent, never null', async () => {
  const { Manager, socket, emissions } = load(async () => [new Error('no netstat'), null]);
  await Manager.Start(socket);
  await Manager.Stop();
  assert.equal('gateway' in emissions[0][1][0], false);
});
