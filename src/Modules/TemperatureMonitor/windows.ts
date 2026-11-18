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
// The winner is REMEMBERED. Every sample used to walk the whole ladder — two
// missing namespaces, the thermal-zone performance class and the ACPI class on a
// machine with none of them — every 30 seconds. Now a sample asks only the source
// that answered last time; the full ladder runs when that source stops answering,
// and every REPROBE_MS when the source is not already the best one (so starting
// LibreHardwareMonitor is noticed) or when nothing answered at all.
//
// NOT VERIFIED ON REAL WINDOWS at the time of writing: the WMI classes and JSON
// shapes are written from their documentation and covered by fixture tests only.

import type { TemperatureSensor } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { Hosts, JsonRows, LastJsonLine, RunPowerShell } from '../PowerShell';
import { DeciKelvinToCelsius, KindFromIdentifier, type TemperatureReading } from './sensors';

export type WindowsTemperatureSource =
  'librehardwaremonitor' | 'openhardwaremonitor' | 'thermalzone-perf' | 'acpi';

const SOURCES: ReadonlySet<string> = new Set<WindowsTemperatureSource>([
  'librehardwaremonitor',
  'openhardwaremonitor',
  'thermalzone-perf',
  'acpi',
]);

const READ_HARDWARE_MONITOR = [
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
];

/** Each source's read, setting $rows and, when it yielded any, $source. */
const SOURCE_READS: Record<WindowsTemperatureSource, string[]> = {
  librehardwaremonitor: [
    "  $rows = @(Read-HardwareMonitor 'root/LibreHardwareMonitor'); if ($rows.Count -gt 0) { $source = 'librehardwaremonitor' };",
  ],
  openhardwaremonitor: [
    "  $rows = @(Read-HardwareMonitor 'root/OpenHardwareMonitor'); if ($rows.Count -gt 0) { $source = 'openhardwaremonitor' };",
  ],
  'thermalzone-perf': [
    '    try {',
    '      $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop);',
    '      $rows = @($zones | ForEach-Object {',
    '        $tenths = $_.HighPrecisionTemperature; if (-not $tenths) { $tenths = $_.Temperature * 10 };',
    '        [pscustomobject]@{ Name = [string]$_.Name; Value = $tenths }',
    '      });',
    "      if ($rows.Count -gt 0) { $source = 'thermalzone-perf' }",
    '    } catch { $rows = @() }',
  ],
  acpi: [
    '    try {',
    '      $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop);',
    '      $rows = @($zones | ForEach-Object { [pscustomobject]@{ Name = [string]$_.InstanceName; Value = $_.CurrentTemperature } });',
    "      if ($rows.Count -gt 0) { $source = 'acpi' }",
    '    } catch { $rows = @() }',
  ],
};

/** Best first. */
const SOURCE_ORDER: WindowsTemperatureSource[] = [
  'librehardwaremonitor',
  'openhardwaremonitor',
  'thermalzone-perf',
  'acpi',
];

/**
 * The query over `Sources`, tried in order until one yields a sensor. One JSON
 * object: which source answered (null for none) and its raw rows, so the unit
 * conversion and naming live in TypeScript where they are tested. Everything
 * runs inside `& { }` so nothing it defines outlives the call in the persistent
 * host's session.
 */
export function BuildTemperatureScript(Sources: readonly WindowsTemperatureSource[]): string {
  const Lines = ['& {'];
  if (Sources.some((Source) => Source.endsWith('hardwaremonitor'))) {
    Lines.push(...READ_HARDWARE_MONITOR);
  }
  Lines.push('  $source = $null; $rows = @();');
  Sources.forEach((Source, Index) => {
    const Read = SOURCE_READS[Source];
    if (Index === 0 && Source.endsWith('hardwaremonitor')) {
      Lines.push(...Read);
    } else if (Source.endsWith('hardwaremonitor')) {
      const Body = Read.map((Line) => Line.trim())
        .join(' ')
        .replace(/;$/, '');
      Lines.push(`  if ($null -eq $source) { ${Body} };`);
    } else {
      Lines.push('  if ($null -eq $source) {', ...Read, '  };');
    }
  });
  Lines.push(
    '  ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ Source = $source; Rows = @($rows) })',
    '}'
  );
  return Lines.join(' ');
}

/** The whole ladder, best source first. */
export const WINDOWS_TEMPERATURE_SCRIPT = BuildTemperatureScript(SOURCE_ORDER);

interface WindowsRow {
  Name: string;
  Value: unknown;
  Identifier: string;
  Hardware: string;
}

/** Parse the query's JSON into its source and rows. Throws on anything else. */
export function ParseWindowsTemperatures(Output: string): {
  Source: WindowsTemperatureSource | null;
  Rows: WindowsRow[];
} {
  const Line = LastJsonLine(Output, ['{']);
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

// The ladder touches up to four WMI providers on a miss.
const HOST_TIMEOUT_MS = 20000;
/** How often a machine not already on the best source looks for a better one. */
const REPROBE_MS = 10 * 60 * 1000;

const SourceMemory = {
  /** The source that answered last; null when none did (or before the first probe). */
  Source: null as WindowsTemperatureSource | null,
  ProbedAt: -Infinity,
};

async function RunTemperatureScript(
  Script: string
): Promise<Result<ReturnType<typeof ParseWindowsTemperatures>>> {
  const [Error_, Output] = await RunPowerShell(Hosts.Wmi, Script, { TimeoutMs: HOST_TIMEOUT_MS });
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [null, ParseWindowsTemperatures(Output)];
  } catch (error) {
    return [error, null];
  }
}

async function Probe(Now: number): Promise<Result<ReturnType<typeof ParseWindowsTemperatures>>> {
  const Outcome = await RunTemperatureScript(WINDOWS_TEMPERATURE_SCRIPT);
  const [Error_, Parsed] = Outcome;
  // A failed run says nothing about which sources exist: keep what was known.
  if (!Error_ && Parsed) {
    SourceMemory.Source = Parsed.Source;
    SourceMemory.ProbedAt = Now;
  }
  return Outcome;
}

export async function CollectWindowsTemperatures(
  Now: number = Date.now()
): Promise<Result<TemperatureReading>> {
  const Known = SourceMemory.Source;
  const ProbeDue = Now - SourceMemory.ProbedAt >= REPROBE_MS;
  let Outcome: Result<ReturnType<typeof ParseWindowsTemperatures>>;
  if (Known && (Known === SOURCE_ORDER[0] || !ProbeDue)) {
    Outcome = await RunTemperatureScript(BuildTemperatureScript([Known]));
    const [Error_, Parsed] = Outcome;
    // The remembered source stopped answering (LibreHardwareMonitor was closed):
    // walk the ladder now rather than reporting nothing until the next probe.
    if (!Error_ && Parsed && !Parsed.Source) Outcome = await Probe(Now);
  } else if (!Known && !ProbeDue) {
    // Nothing answered at the last probe, and it is not time to look again.
    return [null, { Backend: null, Sensors: [] }];
  } else {
    Outcome = await Probe(Now);
  }
  const [Error_, Parsed] = Outcome;
  if (Error_ || !Parsed) return [Error_ || new Error('No output'), null];
  return [
    null,
    { Backend: Parsed.Source, Sensors: MapWindowsTemperatures(Parsed.Source, Parsed.Rows) },
  ];
}

/**
 * Nothing resident to release: the WMI PowerShell host is shared, and left to
 * its idle shutdown. The remembered source survives a disconnect on purpose.
 */
export function DisposeWindowsTemperatures(): void {}

export const _internal = {
  HOST_TIMEOUT_MS,
  REPROBE_MS,
  SOURCE_ORDER,
  SourceMemory,
  /** Test seam: forget the remembered source. */
  ResetSourceMemory(): void {
    SourceMemory.Source = null;
    SourceMemory.ProbedAt = -Infinity;
  },
};
