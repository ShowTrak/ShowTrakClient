import type { TemperatureSensor, TemperatureSensorKind } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { RunCommand } from '../AudioMonitor/shared';
import { FindOnPath } from '../Utils';

/** What one successful read of the platform produced, before sanitising. */
export interface TemperatureReading {
  /** The facility (or facilities, joined with "+") that answered. Null when none did. */
  Backend: string | null;
  Sensors: TemperatureSensor[];
}

// Readings outside this range are a sensor reporting garbage (an unconnected
// motherboard header reads -128 or 255; a disabled ACPI zone reads 0 K), not
// a machine at that temperature, and would trip any threshold alarm.
const MIN_PLAUSIBLE_CELSIUS = -20;
const MAX_PLAUSIBLE_CELSIUS = 150;
// A server-class board exposes a hundred-odd sensors through LibreHardwareMonitor;
// the operator needs the hottest few, not a wall of them on every report.
export const MAX_REPORTED_SENSORS = 32;

/**
 * Drop implausible readings, round to a tenth of a degree, give every sensor a
 * unique name and cap the list. Names are made unique by suffixing " #2", " #3"
 * in reading order, so a machine's sensor names stay stable between reports.
 */
export function SanitizeSensors(Sensors: readonly TemperatureSensor[]): TemperatureSensor[] {
  const Out: TemperatureSensor[] = [];
  const Seen = new Map<string, number>();
  for (const Sensor of Sensors) {
    if (Out.length >= MAX_REPORTED_SENSORS) break;
    if (!Sensor) continue;
    const Celsius = Number(Sensor.Celsius);
    if (!Number.isFinite(Celsius)) continue;
    if (Celsius < MIN_PLAUSIBLE_CELSIUS || Celsius > MAX_PLAUSIBLE_CELSIUS) continue;
    const Base = String(Sensor.Name ?? '').trim() || 'Sensor';
    const Key = Base.toLowerCase();
    const Count = (Seen.get(Key) || 0) + 1;
    Seen.set(Key, Count);
    Out.push({
      Name: Count === 1 ? Base : `${Base} #${Count}`,
      Kind: Sensor.Kind,
      Celsius: Math.round(Celsius * 10) / 10,
    });
  }
  return Out;
}

/** Tenths of a kelvin (how ACPI and the thermal-zone counters report) to °C. */
export function DeciKelvinToCelsius(Value: unknown): number | null {
  const Number_ = typeof Value === 'number' ? Value : Number(Value);
  if (!Number.isFinite(Number_) || Number_ <= 0) return null;
  return Number_ / 10 - 273.15;
}

/**
 * Kind from a Linux driver or thermal-zone type: the name the kernel gives the
 * thing doing the measuring.
 */
export function KindFromDriver(Driver: unknown): TemperatureSensorKind {
  const Name = String(Driver ?? '')
    .trim()
    .toLowerCase();
  if (!Name) return 'other';
  if (/^(coretemp|k10temp|k8temp|zenpower|cpu[_-]thermal|x86_pkg_temp|soc[_-]thermal)/.test(Name)) {
    return 'cpu';
  }
  if (/^(amdgpu|nouveau|radeon|i915|xe|gpu[_-]thermal)/.test(Name)) return 'gpu';
  if (/^(nvme|drivetemp)/.test(Name)) return 'storage';
  // The ACPI thermal zone and the chipset (PCH) both speak for the board.
  if (/^(acpitz|pch_)/.test(Name)) return 'system';
  if (/^bat/.test(Name)) return 'battery';
  return 'other';
}

/**
 * Kind from a LibreHardwareMonitor / OpenHardwareMonitor identifier, which names
 * the hardware first: "/intelcpu/0/temperature/0", "/gpu-nvidia/0/…" (OHM:
 * "/nvidiagpu/0/…"), "/nvme/0/…", "/hdd/0/…", "/lpc/nct6798d/…" (motherboard).
 */
export function KindFromIdentifier(Identifier: unknown): TemperatureSensorKind {
  const Id = String(Identifier ?? '').toLowerCase();
  const Hardware = Id.split('/').filter(Boolean)[0] || '';
  if (Hardware.includes('gpu')) return 'gpu';
  if (Hardware.includes('cpu')) return 'cpu';
  if (/^(hdd|nvme|ssd|storage)/.test(Hardware)) return 'storage';
  if (Hardware.includes('battery')) return 'battery';
  return 'other';
}

// ---------------------------------------------------------------------------
// nvidia-smi (Windows and Linux)
// ---------------------------------------------------------------------------

/**
 * `nvidia-smi --query-gpu=index,name,temperature.gpu --format=csv,noheader,nounits`:
 *
 *   0, NVIDIA GeForce RTX 3080, 54
 *
 * A GPU that cannot report prints "[N/A]" or "[Not Supported]" there, which is
 * skipped. The name can itself contain commas, so the temperature is the LAST
 * field and the index the first.
 */
export function ParseNvidiaSmi(Output: string): TemperatureSensor[] {
  const Sensors: TemperatureSensor[] = [];
  for (const Line of String(Output || '').split(/\r?\n/)) {
    const Fields = Line.split(',').map((Field) => Field.trim());
    if (Fields.length < 3) continue;
    const Index = Fields[0] || '';
    const Celsius = Number(Fields[Fields.length - 1]);
    const Name = Fields.slice(1, -1).join(', ');
    if (!/^\d+$/.test(Index) || !Number.isFinite(Celsius)) continue;
    Sensors.push({ Name: `GPU ${Index}${Name ? ` (${Name})` : ''}`, Kind: 'gpu', Celsius });
  }
  return Sensors;
}

/** nvidia-smi's location, looked up once per process (null: not installed). */
let NvidiaSmiPath: string | null | undefined;

/**
 * GPU temperatures from nvidia-smi, when it is installed. An empty list (not an
 * error) when it is not, so the caller can always just append the result.
 */
export async function ReadNvidiaTemperatures(
  Platform: string = process.platform
): Promise<Result<TemperatureSensor[]>> {
  if (NvidiaSmiPath === undefined) {
    NvidiaSmiPath = FindOnPath('nvidia-smi', process.env, Platform);
  }
  if (!NvidiaSmiPath) return [null, []];
  const [Error_, Output] = await RunCommand(NvidiaSmiPath, [
    '--query-gpu=index,name,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  return [null, ParseNvidiaSmi(Output)];
}

export const _internal = {
  MIN_PLAUSIBLE_CELSIUS,
  MAX_PLAUSIBLE_CELSIUS,
  /** Test seam: forget the cached nvidia-smi lookup. */
  ResetNvidiaSmi(Path?: string | null): void {
    NvidiaSmiPath = Path;
  },
};
