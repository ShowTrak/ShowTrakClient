// Linux temperatures, from sysfs.
//
//   /sys/class/hwmon/hwmonN/name           the driver ("coretemp", "amdgpu", "nvme")
//   /sys/class/hwmon/hwmonN/tempM_input    millidegrees Celsius
//   /sys/class/hwmon/hwmonN/tempM_label    optional ("Package id 0", "Composite")
//   /sys/class/thermal/thermal_zoneN/type  the zone ("x86_pkg_temp", "acpitz")
//   /sys/class/thermal/thermal_zoneN/temp  millidegrees Celsius
//
// Both are world-readable, so no tool or privilege is needed. Most thermal zones
// are also published through hwmon under the same name (acpitz is the usual
// one), so a zone whose type an hwmon driver already reported is skipped rather
// than listed twice.

import path from 'node:path';

import type { TemperatureSensor } from '@showtrak/protocol';
import { NodeSysfsReader, type SysfsReader } from '../PowerMonitor/samplers';
import { KindFromDriver } from './sensors';

function ReadTrimmed(Reader: SysfsReader, File: string): string | null {
  const Value = Reader.ReadFile(File);
  if (Value === null) return null;
  const Trimmed = Value.trim();
  return Trimmed || null;
}

function Millidegrees(Value: string | null): number | null {
  if (Value === null) return null;
  const Number_ = Number(Value);
  return Number.isFinite(Number_) ? Number_ / 1000 : null;
}

function ListDir(Reader: SysfsReader, Directory: string): string[] {
  try {
    return Reader.ReadDir(Directory);
  } catch (_error) {
    // A missing class directory is a machine without that kind of sensor.
    return [];
  }
}

/** Natural order, so hwmon10 follows hwmon9 and temp10 follows temp9. */
function ByNumber(Left: string, Right: string): number {
  return Left.localeCompare(Right, undefined, { numeric: true });
}

export interface LinuxTemperatures {
  Sensors: TemperatureSensor[];
  /** Which of the two classes contributed anything: "hwmon", "thermal". */
  Backends: string[];
}

export function ReadLinuxTemperatures(
  Reader: SysfsReader = NodeSysfsReader,
  HwmonRoot = '/sys/class/hwmon',
  ThermalRoot = '/sys/class/thermal'
): LinuxTemperatures {
  const Sensors: TemperatureSensor[] = [];
  const Backends: string[] = [];
  const Drivers = new Set<string>();

  for (const Entry of ListDir(Reader, HwmonRoot).sort(ByNumber)) {
    const Directory = path.posix.join(HwmonRoot, Entry);
    const Driver = ReadTrimmed(Reader, path.posix.join(Directory, 'name')) || Entry;
    const Inputs = ListDir(Reader, Directory)
      .filter((File) => /^temp\d+_input$/.test(File))
      .sort(ByNumber);
    let Found = false;
    for (const Input of Inputs) {
      const Celsius = Millidegrees(ReadTrimmed(Reader, path.posix.join(Directory, Input)));
      if (Celsius === null) continue;
      const Channel = Input.replace(/_input$/, '');
      const Label = ReadTrimmed(Reader, path.posix.join(Directory, `${Channel}_label`));
      Sensors.push({
        Name: `${Driver} ${Label || Channel}`,
        Kind: KindFromDriver(Driver),
        Celsius,
      });
      Found = true;
    }
    if (Found) Drivers.add(Driver.toLowerCase());
  }
  if (Sensors.length) Backends.push('hwmon');

  const Before = Sensors.length;
  for (const Entry of ListDir(Reader, ThermalRoot)
    .filter((Name) => /^thermal_zone\d+$/.test(Name))
    .sort(ByNumber)) {
    const Directory = path.posix.join(ThermalRoot, Entry);
    const Type = ReadTrimmed(Reader, path.posix.join(Directory, 'type')) || Entry;
    if (Drivers.has(Type.toLowerCase())) continue;
    const Celsius = Millidegrees(ReadTrimmed(Reader, path.posix.join(Directory, 'temp')));
    if (Celsius === null) continue;
    Sensors.push({ Name: Type, Kind: KindFromDriver(Type), Celsius });
  }
  if (Sensors.length > Before) Backends.push('thermal');

  return { Sensors, Backends };
}
