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
// This installs one `uncaughtException` / `unhandledRejection` pair that:
//   - Swallows transient network errors (interface loss is expected and
//     self-heals) with a warning, so a NIC flap never kills the agent.
//   - Logs anything else loudly as a fatal-but-survived error. We deliberately do
//     NOT exit: an agent that stays up and degraded can still be reached, wake-on-
//     LAN'd and re-adopted, whereas a dead one needs a physical visit. Genuine
//     bugs remain visible in the logs at error level.
//
// Mirrors ShowTrakServer's src/main/process-guards.ts.
import { CreateLogger } from '../Logger';
import { IsTransientNetworkError, DescribeError } from '@showtrak/protocol/runtime';

const Logger = CreateLogger('ProcessGuard');

let Installed = false;

export function installProcessGuards(): void {
  if (Installed) return;
  Installed = true;

  process.on('uncaughtException', (Err: unknown) => {
    if (IsTransientNetworkError(Err)) {
      Logger.warn(`Ignored transient network error: ${DescribeError(Err)}`);
      return;
    }
    Logger.error('Uncaught exception (app kept alive):', Err);
  });

  process.on('unhandledRejection', (Reason: unknown) => {
    if (IsTransientNetworkError(Reason)) {
      Logger.warn(`Ignored transient network rejection: ${DescribeError(Reason)}`);
      return;
    }
    Logger.error('Unhandled promise rejection (app kept alive):', Reason);
  });

  Logger.log('Process-level fault guards installed');
}
