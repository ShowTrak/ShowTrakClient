// Every helper process the client spawns runs below normal priority.
//
// The samplers (ps, lsappinfo, osascript, df, vm_stat, system_profiler, the
// PowerShell hosts…) are background work on a machine whose real job is the
// show. Only show SCRIPTS keep normal priority, because the show itself is
// often one of them, and whatever they launch inherits what they run at.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', 'Modules');

/** Modules allowed to spawn without lowering: the show's own scripts. */
const NORMAL_PRIORITY = new Set([path.join('Modules', 'ScriptManager', 'index.ts')]);

function SourceFiles(Dir) {
  return fs.readdirSync(Dir, { withFileTypes: true }).flatMap((Entry) => {
    const Full = path.join(Dir, Entry.name);
    if (Entry.isDirectory()) return SourceFiles(Full);
    return Entry.name.endsWith('.ts') && !Entry.name.endsWith('.d.ts') ? [Full] : [];
  });
}

test('every module that starts a helper process lowers its priority', () => {
  const Missing = [];
  for (const File of SourceFiles(SRC)) {
    const Relative = path.relative(SRC, File);
    if (NORMAL_PRIORITY.has(Relative)) continue;
    const Code = fs.readFileSync(File, 'utf8');
    // A call, not a mention in a comment or a type import.
    const Spawns = /^(?!\s*(?:\/\/|\*)).*\b(?:execFile|spawn|exec|fork)\s*\(/m.test(Code);
    if (!/from '(?:node:)?child_process'/.test(Code)) continue;
    if (Spawns && !Code.includes('LowerChildPriority(')) Missing.push(Relative);
  }
  assert.deepEqual(Missing, [], 'these modules spawn helpers at normal priority');
});

/** A fake child_process whose execFile hands back a child with a pid. */
function FakeChildProcess(Pid) {
  return {
    execFile: (_Command, _Args, _Options, Callback) => {
      setImmediate(() => Callback(null, ''));
      return { pid: Pid };
    },
  };
}

function PriorityRecorder() {
  const Lowered = [];
  return {
    Lowered,
    Mock: { LowerChildPriority: (Child) => Lowered.push(Child && Child.pid) },
  };
}

test('ps, lsappinfo and osascript samples run below normal priority', async () => {
  const { Lowered, Mock } = PriorityRecorder();
  const { execFileAsync } = loadWithMocks(path.join(DIST, 'ProcessMonitor', 'samplers.js'), {
    child_process: FakeChildProcess(4101),
    '../Utils/process-priority': Mock,
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  await execFileAsync('ps', ['-axo', 'pid,comm']);
  assert.deepEqual(Lowered, [4101]);
});

test('df runs below normal priority', async () => {
  const { Lowered, Mock } = PriorityRecorder();
  const { RunDf } = loadWithMocks(path.join(DIST, 'StorageMonitor', 'df.js'), {
    'node:child_process': FakeChildProcess(4102),
    '../Utils/process-priority': Mock,
  });
  await RunDf(['-kP']);
  assert.deepEqual(Lowered, [4102]);
});
