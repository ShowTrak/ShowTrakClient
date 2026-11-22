// Process-wide last line of defence.
//
// The agent runs unattended on machines nobody is watching, often for weeks. Its
// riskiest faults originate several layers deep in third-party or native code
// and surface as an uncaught exception before any of our try/catch or per-socket
// handlers can see them:
//
//   - the mDNS browser throwing `send EADDRNOTAVAIL 224.0.0.251:5353` the
//     instant Ethernet is unplugged or Wi-Fi is switched off,
//   - `write EPIPE` from a console write when the process was launched with a
//     pipe that has since closed,
//   - socket teardown races during a server disconnect.
//
// The guards themselves are shared with ShowTrak Server and Timers
// (@showtrak/protocol/runtime InstallProcessGuards): transient network errors
// are swallowed with a warning, anything else is logged loudly as a
// fatal-but-survived error, and the process deliberately does NOT exit. An agent
// that stays up and degraded can still be reached, wake-on-LAN'd and re-adopted,
// whereas a dead one needs a physical visit. This module is the Client's wiring:
// they log as ProcessGuard.
import { CreateLogger } from '../Logger';
import { InstallProcessGuards } from '@showtrak/protocol/runtime';

const Logger = CreateLogger('ProcessGuard');

/** Install the process guards. Once per process: later calls do nothing. */
export function installProcessGuards(): void {
  InstallProcessGuards(Logger);
}
