// Windows temperatures.
//
// Windows has no general temperature API. What can be read, best first:
//
//   1. LibreHardwareMonitor, when it is running: it publishes every sensor it
//      knows (CPU package and cores, GPU, drives, motherboard) to WMI under
//      root/LibreHardwareMonitor. This is the only source that reliably sees the
//      CPU and GPU, which is why the "unsupported" message recommends it.
//   2. OpenHardwareMonitor, its predecessor, which publishes the same shape
//      under root/OpenHardwareMonitor.
//   3. The "Thermal Zone Information" performance counters: ACPI thermal zones,
//      readable without administrator rights on most machines. Often a single
//      board sensor, sometimes a CPU zone.
//   4. MSAcpi_ThermalZoneTemperature in root/wmi: the same zones by another
//      road, which usually needs administrator rights (access denied is simply
//      skipped).
//
// The first source that yields any sensor wins; mixing them would list the same
// physical sensor twice under different names. Each query is wrapped on its own
// so a missing namespace or a refused class only moves on to the next.
//
// NOT VERIFIED ON REAL WINDOWS at the time of writing: the WMI classes and JSON
// shapes are written from their documentation and covered by fixture tests only.

import type { TemperatureSensor } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreatePowerShellHost } from '../ProcessMonitor/powershell-host';
import { RunCommand } from '../AudioMonitor/shared';
import { DeciKelvinToCelsius, KindFromIdentifier, type TemperatureReading } from './sensors';

export type WindowsTemperatureSource =
  'librehardwaremonitor' | 'openhardwaremonitor' | 'thermalzone-perf' | 'acpi';

const SOURCES: ReadonlySet<string> = new Set<WindowsTemperatureSource>([
  'librehardwaremonitor',
  'openhardwaremonitor',
  'thermalzone-perf',
  'acpi',
]);

/**
 * The query. One JSON object: which source answered (null for none) and its raw
 * rows, so the unit conversion and naming live in TypeScript where they are
 * tested. Everything runs inside `& { }` so nothing it defines outlives the call
 * in the persistent host's session.
 */
export const WINDOWS_TEMPERATURE_SCRIPT = [
  '& {',
  '  function Read-HardwareMonitor($Namespace) {',
  '    try {',
  '      $sensors = @(Get-CimInstance -Namespace $Namespace -ClassName Sensor -Filter "SensorType=\'Temperature\'" -ErrorAction Stop);',
  '      if ($sensors.Count -eq 0) { return };',
  '      $hardware = @{};',
  '      try { foreach ($h in @(Get-CimInstance -Namespace $Namespace -ClassName Hardware -ErrorAction Stop)) { $hardware[[string]$h.Identifier] = [string]$h.Name } } catch { };',
  '      foreach ($s in $sensors) {',
  '        [pscustomobject]@{ Name = [string]$s.Name; Value = $s.Value; Identifier = [string]$s.Identifier; Hardware = $hardware[[string]$s.Parent] }',
  '      }',
  '    } catch { }',
  '  };',
  '  $source = $null; $rows = @();',
  "  $rows = @(Read-HardwareMonitor 'root/LibreHardwareMonitor'); if ($rows.Count -gt 0) { $source = 'librehardwaremonitor' };",
  "  if ($null -eq $source) { $rows = @(Read-HardwareMonitor 'root/OpenHardwareMonitor'); if ($rows.Count -gt 0) { $source = 'openhardwaremonitor' } };",
  '  if ($null -eq $source) {',
  '    try {',
  '      $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop);',
  '      $rows = @($zones | ForEach-Object {',
  '        $tenths = $_.HighPrecisionTemperature; if (-not $tenths) { $tenths = $_.Temperature * 10 };',
  '        [pscustomobject]@{ Name = [string]$_.Name; Value = $tenths }',
  '      });',
  "      if ($rows.Count -gt 0) { $source = 'thermalzone-perf' }",
  '    } catch { $rows = @() }',
  '  };',
  '  if ($null -eq $source) {',
  '    try {',
  '      $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop);',
  '      $rows = @($zones | ForEach-Object { [pscustomobject]@{ Name = [string]$_.InstanceName; Value = $_.CurrentTemperature } });',
  "      if ($rows.Count -gt 0) { $source = 'acpi' }",
  '    } catch { $rows = @() }',
  '  };',
  '  ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ Source = $source; Rows = @($rows) })',
  '}',
].join(' ');

interface WindowsRow {
  Name: string;
  Value: unknown;
  Identifier: string;
  Hardware: string;
}

/**
 * The rows of a list-valued property in PowerShell's JSON. Three shapes reach us:
 * an array; one bare object, where a single-element list was unrolled; and, from
 * Windows PowerShell 5.1, `{"value":[...],"Count":n}` when the array was wrapped
 * in a PSObject on its way into the property — a long-standing ConvertTo-Json
 * quirk that would otherwise read as one malformed row.
 */
function JsonRows(Value: unknown): unknown[] {
  if (Array.isArray(Value)) return Value;
  if (!Value || typeof Value !== 'object') return [];
  const Wrapped = (Value as { value?: unknown }).value;
  return Array.isArray(Wrapped) ? Wrapped : [Value];
}

/** Parse the query's JSON into its source and rows. Throws on anything else. */
export function ParseWindowsTemperatures(Output: string): {
  Source: WindowsTemperatureSource | null;
  Rows: WindowsRow[];
} {
  const Line = String(Output || '')
    .split(/\r?\n/)
    .map((Entry) => Entry.trim())
    .reverse()
    .find((Entry) => Entry.startsWith('{') && Entry.endsWith('}'));
  if (!Line) throw new Error('Temperature query returned no result');
  const Parsed: unknown = JSON.parse(Line);
  if (!Parsed || typeof Parsed !== 'object' || Array.isArray(Parsed)) {
    throw new Error('Temperature query returned no result');
  }
  const Root = Parsed as Record<string, unknown>;
  const Source =
    typeof Root.Source === 'string' && SOURCES.has(Root.Source)
      ? (Root.Source as WindowsTemperatureSource)
      : null;
  const RawRows = JsonRows(Root.Rows);
  const Text = (Value: unknown) => (typeof Value === 'string' ? Value.trim() : '');
  const Rows: WindowsRow[] = [];
  for (const Raw of RawRows as unknown[]) {
    if (!Raw || typeof Raw !== 'object') continue;
    const Row = Raw as Record<string, unknown>;
    Rows.push({
      Name: Text(Row.Name),
      Value: Row.Value,
      Identifier: Text(Row.Identifier),
      Hardware: Text(Row.Hardware),
    });
  }
  return { Source, Rows };
}

/** "\_TZ.CPUZ" (perf counter) or "ACPI\ThermalZone\TZ00_0" (root/wmi) -> "CPUZ" / "TZ00_0". */
function ZoneName(Raw: string): string {
  const Segments = Raw.split(/[\\.]/).filter(Boolean);
  const Last = Segments[Segments.length - 1] || Raw;
  return Last.replace(/^_+/, '') || Raw;
}

/** Sensor names that LibreHardwareMonitor files as temperatures but are not. */
const NOT_A_TEMPERATURE = /distance to tj ?max/i;

/**
 * Rows -> sensors. Hardware-monitor sensor names are often generic ("Temperature"
 * on every drive, "GPU Core" on each of two cards); such a name is qualified
 * with its hardware's name so the operator can tell them apart.
 */
export function MapWindowsTemperatures(
  Source: WindowsTemperatureSource | null,
  Rows: WindowsRow[]
): TemperatureSensor[] {
  if (!Source) return [];
  if (Source === 'librehardwaremonitor' || Source === 'openhardwaremonitor') {
    const Usable = Rows.filter((Row) => Row.Name && !NOT_A_TEMPERATURE.test(Row.Name));
    const Uses = new Map<string, number>();
    for (const Row of Usable) {
      const Key = Row.Name.toLowerCase();
      Uses.set(Key, (Uses.get(Key) || 0) + 1);
    }
    return Usable.map((Row) => {
      const Ambiguous =
        (Uses.get(Row.Name.toLowerCase()) || 0) > 1 || /^temperature$/i.test(Row.Name);
      return {
        Name: Ambiguous && Row.Hardware ? `${Row.Hardware} ${Row.Name}` : Row.Name,
        Kind: KindFromIdentifier(Row.Identifier),
        Celsius: Number(Row.Value),
      };
    });
  }
  // Thermal zones: values in tenths of a kelvin. A zone is the board's unless
  // its name says it is the processor's.
  const Sensors: TemperatureSensor[] = [];
  for (const Row of Rows) {
    const Celsius = DeciKelvinToCelsius(Row.Value);
    if (Celsius === null) continue;
    const Name = ZoneName(Row.Name || 'Thermal zone');
    Sensors.push({ Name, Kind: /cpu/i.test(Row.Name) ? 'cpu' : 'system', Celsius });
  }
  return Sensors;
}

// The query touches up to four WMI providers on a miss; give a cold host room.
const HOST_TIMEOUT_MS = 20000;
const Host = CreatePowerShellHost('TemperaturePowerShellHost');

/** Run in the persistent host, falling back to a one-shot powershell.exe. */
async function RunPowerShell(Script: string): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, HOST_TIMEOUT_MS);
  if (!HostError && Output !== null) return [null, Output];
  return RunCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    Script,
  ]);
}

export async function CollectWindowsTemperatures(): Promise<Result<TemperatureReading>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_TEMPERATURE_SCRIPT);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    const { Source, Rows } = ParseWindowsTemperatures(Output);
    return [null, { Backend: Source, Sensors: MapWindowsTemperatures(Source, Rows) }];
  } catch (error) {
    return [error, null];
  }
}

export function DisposeWindowsTemperatures(): void {
  Host.Dispose();
}

export const _internal = { Host, HOST_TIMEOUT_MS };
