// NVIDIA GPU temperatures from nvidia-smi (Windows and Linux).
//
// nvidia-smi used to be spawned once per temperature sample — every 30 seconds
// on every machine with an NVIDIA card and no LibreHardwareMonitor, which on a
// show machine is most of them. Each run pays a process start plus NVML's own
// initialisation, which is the expensive part (a few hundred milliseconds of
// CPU on some drivers).
//
// Instead one nvidia-smi is left running in its loop mode (`-l`), printing a
// CSV row per GPU every LOOP_SECONDS, and a sample reads the latest rows. If the
// loop cannot be kept running, the reader drops back to the old one-shot query;
// if that fails too, it stops asking for RETRY_AFTER_FAILURE_MS rather than
// spawning a failing nvidia-smi every 30 seconds.
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';

import type { TemperatureSensor } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { RunCommand } from '../AudioMonitor/shared';
import { FindOnPath } from '../Utils';
import { LowerChildPriority } from '../Utils/process-priority';
import { ParseNvidiaSmi } from './sensors';

const QUERY_ARGS = ['--query-gpu=index,name,temperature.gpu', '--format=csv,noheader,nounits'];
/** nvidia-smi's own loop interval; matches the temperature monitor's poll. */
const LOOP_SECONDS = 30;
/** How long a first read waits for the loop's first rows (printed immediately). */
const FIRST_ROWS_WAIT_MS = 5000;
/** A GPU row older than this is stale: the loop stopped printing it. */
const STALE_MS = (LOOP_SECONDS * 2 + 15) * 1000;
/** After the loop and the one-shot both failed, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

type Mode = 'loop' | 'oneshot';

export interface NvidiaReaderDeps {
  Spawn?: typeof nodeSpawn;
  Find?: (Command: string) => string | null;
  RunOnce?: (Command: string, Args: string[]) => Promise<Result<string>>;
  Now?: () => number;
}

export interface NvidiaReader {
  /** The latest GPU temperatures: an empty list (not an error) without nvidia-smi. */
  Read(): Promise<Result<TemperatureSensor[]>>;
  /** Stop the resident loop. The next Read() starts it again. */
  Stop(): void;
  /** Whether the resident loop is running. */
  IsRunning(): boolean;
}

export function CreateNvidiaReader(Deps: NvidiaReaderDeps = {}): NvidiaReader {
  const Spawn = Deps.Spawn ?? nodeSpawn;
  const Find =
    Deps.Find ?? ((Command: string) => FindOnPath(Command, process.env, process.platform));
  const RunOnce = Deps.RunOnce ?? RunCommand;
  const Now = Deps.Now ?? Date.now;

  /** nvidia-smi's location, looked up once (null: not installed). */
  let ExecutablePath: string | null | undefined;
  let Mode_: Mode = 'loop';
  let Child: ChildProcess | null = null;
  let Buffer_ = '';
  /** Whether the running loop has printed any complete line at all. */
  let SawOutput = false;
  let RetryAt = 0;
  const Latest = new Map<string, { Sensor: TemperatureSensor; At: number }>();
  let Waiters: Array<() => void> = [];

  function WakeWaiters(): void {
    const Pending = Waiters;
    Waiters = [];
    for (const Wake of Pending) Wake();
  }

  function Consume(): void {
    const Lines = Buffer_.split(/\r?\n/);
    Buffer_ = Lines.pop() ?? '';
    const At = Now();
    let Any = false;
    for (const Line of Lines) {
      if (!Line.trim()) continue;
      Any = true;
      // A GPU that cannot report its temperature prints "[N/A]" and parses to
      // nothing: the loop is healthy, there is just nothing to report for it.
      for (const Sensor of ParseNvidiaSmi(Line)) {
        const Index = /^GPU (\d+)/.exec(Sensor.Name)?.[1] ?? Sensor.Name;
        Latest.set(Index, { Sensor, At });
      }
    }
    if (Any) {
      SawOutput = true;
      WakeWaiters();
    }
    // A line that never ends is not CSV; do not let it grow without bound.
    if (Buffer_.length > 64 * 1024) Buffer_ = '';
  }

  function Detach(Dying: ChildProcess): void {
    Dying.removeAllListeners();
    Dying.stdout?.removeAllListeners();
    Dying.stderr?.removeAllListeners();
  }

  function StartLoop(Path: string): void {
    let Spawned: ChildProcess;
    try {
      Spawned = Spawn(Path, [...QUERY_ARGS, '-l', String(LOOP_SECONDS)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_error) {
      Mode_ = 'oneshot';
      return;
    }
    Child = Spawned;
    Buffer_ = '';
    SawOutput = false;
    LowerChildPriority(Spawned);
    Spawned.stdout?.setEncoding('utf8');
    Spawned.stdout?.on('data', (Chunk: string) => {
      Buffer_ += Chunk;
      Consume();
    });
    Spawned.stderr?.resume();
    const Ended = () => {
      if (Child !== Spawned) return;
      Detach(Spawned);
      Child = null;
      Latest.clear();
      // A loop that never printed a line cannot be relied on; one that ran and
      // then died (a driver reset) is simply restarted by the next Read().
      if (!SawOutput) Mode_ = 'oneshot';
      WakeWaiters();
    };
    Spawned.on('error', Ended);
    Spawned.on('exit', Ended);
  }

  function WaitForRows(): Promise<void> {
    return new Promise((resolve) => {
      const Timer = setTimeout(() => {
        Waiters = Waiters.filter((Wake) => Wake !== Done);
        resolve();
      }, FIRST_ROWS_WAIT_MS);
      if (typeof Timer.unref === 'function') Timer.unref();
      const Done = () => {
        clearTimeout(Timer);
        resolve();
      };
      Waiters.push(Done);
    });
  }

  function Fresh(): TemperatureSensor[] {
    const Cutoff = Now() - STALE_MS;
    return Array.from(Latest.entries())
      .filter(([, Entry]) => Entry.At >= Cutoff)
      .sort(([Left], [Right]) => Number(Left) - Number(Right) || Left.localeCompare(Right))
      .map(([, Entry]) => Entry.Sensor);
  }

  async function ReadOnce(Path: string): Promise<Result<TemperatureSensor[]>> {
    const [Error_, Output] = await RunOnce(Path, QUERY_ARGS);
    if (Error_ || Output === null) {
      RetryAt = Now() + RETRY_AFTER_FAILURE_MS;
      return [Error_ || new Error('No output'), null];
    }
    const Sensors = ParseNvidiaSmi(Output);
    // Installed, but no GPU reports a temperature: ask again later, not every sample.
    if (!Sensors.length) RetryAt = Now() + RETRY_AFTER_FAILURE_MS;
    return [null, Sensors];
  }

  const Reader: NvidiaReader = {
    async Read(): Promise<Result<TemperatureSensor[]>> {
      if (ExecutablePath === undefined) ExecutablePath = Find('nvidia-smi');
      const Path = ExecutablePath;
      if (!Path) return [null, []];
      if (Now() < RetryAt) return [null, []];

      if (Mode_ === 'loop') {
        // Rows gone stale while the loop still runs: it is wedged, or a GPU
        // vanished. Start it over rather than reporting nothing indefinitely.
        if (Child && SawOutput && !Fresh().length) Reader.Stop();
        if (!Child) StartLoop(Path);
        if (Child && !SawOutput) await WaitForRows();
        if (Child && !SawOutput) {
          // Running but silent: its output is not reaching us (or -l is not
          // supported here). The one-shot query is the known-good path.
          Reader.Stop();
          Mode_ = 'oneshot';
        }
        if (Mode_ === 'loop') return [null, Fresh()];
      }
      return ReadOnce(Path);
    },

    Stop(): void {
      const Dying = Child;
      Child = null;
      Latest.clear();
      WakeWaiters();
      if (!Dying) return;
      Detach(Dying);
      try {
        Dying.kill();
      } catch (_error) {
        // Already gone.
      }
    },

    IsRunning(): boolean {
      return !!Child;
    },
  };
  return Reader;
}

/** The process's reader. */
export const Nvidia = CreateNvidiaReader();

export const _constants = { LOOP_SECONDS, STALE_MS, RETRY_AFTER_FAILURE_MS, FIRST_ROWS_WAIT_MS };
