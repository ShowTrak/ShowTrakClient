const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger } = require('../test-helpers');

// The client's shared PowerShell module (src/Modules/PowerShell) for tests of
// the Windows samplers built on it.
//
// Its fallback POLICY is the real one — the module is loaded from dist — but the
// two pieces that would start powershell.exe are scripted: the persistent hosts
// (`host`) and the one-shot fallback spawn (`oneShot`). Pass the returned
// `PowerShell` as the '../PowerShell' mock of the module under test.
//
//   host(script, { name, options })  -> string (the output) | Error (the host's
//       error, e.g. tagged ETIMEDOUT/ESCRIPT) | [error, output] | null (host
//       unavailable, which is what falls back to the one-shot)
//   oneShot(script, args)            -> string | Error | [error, output] | null
//       (null: powershell.exe missing)

const PS_DIR = path.join(__dirname, '..', '..', 'dist', 'Modules', 'PowerShell');
const loggerStub = { CreateLogger: () => createSilentLogger() };

/** The real host module's exports (error codes, IsScriptFailure…). */
function loadRealHost(mocks = {}) {
  return loadWithMocks(path.join(PS_DIR, 'host.js'), {
    '../Logger': loggerStub,
    '../Utils/process-priority': { LowerChildPriority() {} },
    ...mocks,
  });
}

/** Tag an error the way the real host does. */
function tagged(message, code) {
  return Object.assign(new Error(message), { code });
}

function createFakePowerShell({ host = null, oneShot = null } = {}) {
  const hostRuns = [];
  const oneShots = [];
  const realHost = loadRealHost();

  const fakeHost = (Name) => ({
    Name,
    Run: async (Script, Options) => {
      const options = typeof Options === 'number' ? { TimeoutMs: Options } : Options;
      hostRuns.push({ host: Name, script: Script, options });
      const answer = host ? host(Script, { name: Name, options }) : null;
      if (Array.isArray(answer)) return answer;
      if (answer instanceof Error) return [answer, null];
      if (answer === null || answer === undefined) {
        return [new Error('PowerShell host unavailable'), null];
      }
      return [null, answer];
    },
    Dispose() {},
    IsRunning: () => false,
    _reset() {},
  });

  const PowerShell = loadWithMocks(path.join(PS_DIR, 'index.js'), {
    './host': { ...realHost, CreatePowerShellHost: fakeHost },
    '../Utils/process-priority': { LowerChildPriority() {} },
    child_process: {
      execFile: (cmd, args, options, callback) => {
        const script = args[args.length - 1];
        oneShots.push({ cmd, args, options, script });
        let answer;
        try {
          answer = oneShot ? oneShot(script, args) : null;
        } catch (error) {
          answer = error;
        }
        setImmediate(() => {
          if (Array.isArray(answer)) return callback(answer[0], answer[1] ?? '');
          if (answer instanceof Error) return callback(answer, '');
          if (answer === null || answer === undefined) {
            return callback(
              Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }),
              ''
            );
          }
          return callback(null, answer);
        });
        return {};
      },
    },
  });
  return { PowerShell, hostRuns, oneShots, realHost };
}

/** A stand-in for a spawned powershell.exe that a test drives by hand. */
function createFakeChild() {
  const child = new EventEmitter();
  child.writes = [];
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.stdin = {
    write: (chunk) => {
      child.writes.push(String(chunk));
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
  };
  // Reply to the most recent script the way a real host would: the payload
  // wrapped in whatever sentinels the module wrote around it.
  child.respond = (payload) => {
    const last = child.writes[child.writes.length - 1] || '';
    const tokens = [...last.matchAll(/Write-Output '([^']+)'/g)].map((m) => m[1]);
    const begin = tokens[0];
    const end = tokens[tokens.length - 1];
    child.stdout.emit('data', `${begin}${payload}${end}\n`);
  };
  return child;
}

module.exports = { createFakePowerShell, createFakeChild, loadRealHost, tagged, PS_DIR };
