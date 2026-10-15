import type { ThermalState } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { GetPowerMonitor } from '../PowerMonitor/electron-power';
import { ReadLinuxTemperatures } from './linux';
import { ReadNvidiaTemperatures, SanitizeSensors, type TemperatureReading } from './sensors';
import { CollectWindowsTemperatures, DisposeWindowsTemperatures } from './windows';

/** A reading, or why there is none. */
export type TemperatureCollection =
  | { Ok: true; Reading: TemperatureReading & { ThermalState: ThermalState | null } }
  | { Ok: false; Error: unknown };

const THERMAL_STATES: ReadonlySet<string> = new Set<ThermalState>([
  'nominal',
  'fair',
  'serious',
  'critical',
]);

/**
 * macOS's thermal pressure verdict, from Electron. "unknown" (and anything this
 * client does not recognise) is null; so is every other platform.
 */
export function ReadThermalState(Platform: string = process.platform): ThermalState | null {
  if (Platform !== 'darwin') return null;
  const Monitor = GetPowerMonitor();
  if (!Monitor || typeof Monitor.getCurrentThermalState !== 'function') return null;
  try {
    const State = String(Monitor.getCurrentThermalState() || '').toLowerCase();
    return THERMAL_STATES.has(State) ? (State as ThermalState) : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Append nvidia-smi's GPUs to a reading, unless the reading already has a GPU
 * (LibreHardwareMonitor reports the same card, and listing it twice under two
 * names would only confuse). A failing nvidia-smi costs the GPUs, not the reading.
 */
async function WithNvidia(
  Reading: TemperatureReading,
  Platform: string
): Promise<TemperatureReading> {
  if (Reading.Sensors.some((Sensor) => Sensor.Kind === 'gpu')) return Reading;
  const [Error_, Gpus] = await ReadNvidiaTemperatures(Platform);
  if (Error_ || !Gpus || !Gpus.length) return Reading;
  return {
    Backend: Reading.Backend ? `${Reading.Backend}+nvidia-smi` : 'nvidia-smi',
    Sensors: [...Reading.Sensors, ...Gpus],
  };
}

export async function CollectTemperatures(
  Platform: string = process.platform
): Promise<TemperatureCollection> {
  let Outcome: Result<TemperatureReading>;
  if (Platform === 'win32') {
    Outcome = await CollectWindowsTemperatures();
  } else if (Platform === 'linux') {
    try {
      const Linux = ReadLinuxTemperatures();
      Outcome = [
        null,
        {
          Backend: Linux.Backends.length ? Linux.Backends.join('+') : null,
          Sensors: Linux.Sensors,
        },
      ];
    } catch (error) {
      Outcome = [error, null];
    }
  } else {
    // macOS exposes no temperature to an unprivileged process (powermetrics and
    // the SMC both need root), and other platforms have no reader at all.
    Outcome = [null, { Backend: null, Sensors: [] }];
  }

  const [Error_, Raw] = Outcome;
  if (Error_ || !Raw) return { Ok: false, Error: Error_ || new Error('Temperature sample failed') };
  const Reading =
    Platform === 'win32' || Platform === 'linux' ? await WithNvidia(Raw, Platform) : Raw;
  return {
    Ok: true,
    Reading: {
      Backend: Reading.Backend,
      Sensors: SanitizeSensors(Reading.Sensors),
      ThermalState: ReadThermalState(Platform),
    },
  };
}

/** Release resident sampler state (the Windows PowerShell host). */
export function DisposeTemperatureSamplers(): void {
  DisposeWindowsTemperatures();
}
