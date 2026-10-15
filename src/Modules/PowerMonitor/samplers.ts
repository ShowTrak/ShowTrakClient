import fs from 'node:fs';
import path from 'node:path';

import type { BatteryStatus } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreatePowerShellHost } from '../ProcessMonitor/powershell-host';
import { RunCommand } from '../AudioMonitor/shared';

// Battery and mains, per platform. Each reader answers the same three questions
// — is there a battery, how full is it, is it charging — plus "are we on
// battery", which Electron's powerMonitor normally answers for every platform
// and these readings only back up.
//
// A desktop with no battery is a perfectly good answer (Battery null), not a
// failure: the server shows "no battery", never a fault.

/** What one successful read of the platform produced. */
export interface PowerReading {
  /** The facility that answered: "wmi", "pmset" or "sysfs". */
  Backend: string;
  Battery: BatteryStatus | null;
  /** Running from battery, as the platform reading itself says. Null when it does not. */
  OnBattery: boolean | null;
}

/** A reading, or why there is none. `Unsupported` means no reader exists here at all. */
export type PowerCollection =
  { Ok: true; Reading: PowerReading } | { Ok: false; Unsupported: boolean; Error: unknown };

/** A whole percentage in 0-100, or null. */
function Percent(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Number_ = typeof Value === 'number' ? Value : Number(String(Value).trim());
  if (!Number.isFinite(Number_)) return null;
  return Math.max(0, Math.min(100, Math.round(Number_)));
}

/** Whole minutes, or null for anything that is not a plausible estimate. */
function Minutes(Value: unknown): number | null {
  if (Value === null || Value === undefined) return null;
  const Number_ = typeof Value === 'number' ? Value : Number(Value);
  // Anything over a week is a sentinel or a nonsense division, not an estimate.
  if (!Number.isFinite(Number_) || Number_ <= 0 || Number_ > 7 * 24 * 60) return null;
  return Math.round(Number_);
}

// ---------------------------------------------------------------------------
// Windows: Win32_Battery
// ---------------------------------------------------------------------------

/**
 * Win32_Battery.EstimatedRunTime's "unknown" value: Windows reports it while on
 * AC power, and before it has enough discharge history to estimate.
 */
const WIN32_RUNTIME_UNKNOWN = 71582788;

/**
 * Every battery the machine has (laptops with a second battery list two). The
 * query is wrapped so a WMI failure surfaces as an error, and the result is
 * forced into an array so one battery is not serialised as a bare object.
 */
export const WINDOWS_BATTERY_SCRIPT = [
  '& {',
  '  $rows = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop | ForEach-Object {',
  '    [pscustomobject]@{ Percent = $_.EstimatedChargeRemaining; Status = $_.BatteryStatus; RunTime = $_.EstimatedRunTime }',
  '  });',
  '  ConvertTo-Json -Compress -InputObject @($rows)',
  '}',
].join(' ');

export interface Win32BatteryRow {
  Percent: number | null;
  Status: number | null;
  RunTime: number | null;
}

/** Parse the query's JSON: an array, one bare object, or nothing at all. */
export function ParseWin32Battery(Output: string): Win32BatteryRow[] {
  const Text = String(Output || '').trim();
  if (!Text) return [];
  const Line = Text.split(/\r?\n/)
    .map((Entry) => Entry.trim())
    .reverse()
    .find((Entry) => Entry.startsWith('[') || Entry.startsWith('{'));
  if (!Line) throw new Error('Battery query returned no battery list');
  const Parsed: unknown = JSON.parse(Line);
  const Rows = Array.isArray(Parsed) ? Parsed : [Parsed];
  const Out: Win32BatteryRow[] = [];
  for (const Raw of Rows as unknown[]) {
    if (!Raw || typeof Raw !== 'object') continue;
    const Row = Raw as Record<string, unknown>;
    const Num = (Value: unknown) =>
      Value === null || Value === undefined || !Number.isFinite(Number(Value))
        ? null
        : Number(Value);
    Out.push({ Percent: Num(Row.Percent), Status: Num(Row.Status), RunTime: Num(Row.RunTime) });
  }
  return Out;
}

/**
 * Win32_Battery.BatteryStatus -> charging. 6-9 are the "Charging…" states. 1
 * ("Other") is what Windows actually reports while discharging, and 3-5 (fully
 * charged, low, critical) are not charging. 2 ("Unknown") is what it reports on
 * AC power whether or not the battery is taking charge, so it is left unknown
 * rather than guessed; 10 and 11 are undefined/partially charged, likewise.
 */
function Win32Charging(Status: number | null): boolean | null {
  if (Status === null) return null;
  if (Status >= 6 && Status <= 9) return true;
  if (Status === 1 || (Status >= 3 && Status <= 5)) return false;
  return null;
}

/** BatteryStatus -> on battery, where it says: 1 discharging; 2, 3, 6-9, 11 on AC. */
function Win32OnBattery(Status: number | null): boolean | null {
  if (Status === null) return null;
  if (Status === 1) return true;
  if (Status === 2 || Status === 3 || (Status >= 6 && Status <= 9) || Status === 11) return false;
  return null;
}

/**
 * Win32_Battery rows -> a reading. No rows means no battery. With two batteries
 * the charge is their mean and either one charging counts; Windows' own runtime
 * estimate already covers the pair, so the first one given is used.
 */
export function MapWin32Battery(Rows: Win32BatteryRow[]): Omit<PowerReading, 'Backend'> {
  if (!Rows.length) return { Battery: null, OnBattery: null };
  const Percents = Rows.map((Row) => Percent(Row.Percent)).filter(
    (Value): Value is number => Value !== null
  );
  const Charging = Rows.map((Row) => Win32Charging(Row.Status));
  const OnBattery = Rows.map((Row) => Win32OnBattery(Row.Status));
  const AnyCharging = Charging.includes(true) ? true : Charging.includes(false) ? false : null;
  const OnBatteryAny = OnBattery.includes(false) ? false : OnBattery.includes(true) ? true : null;
  const RunTime = Rows.map((Row) => Row.RunTime).find(
    (Value) => Value !== null && Value !== WIN32_RUNTIME_UNKNOWN
  );
  return {
    Battery: {
      Percent: Percents.length
        ? Math.round(Percents.reduce((Sum, Value) => Sum + Value, 0) / Percents.length)
        : null,
      Charging: AnyCharging,
      TimeRemainingMinutes: OnBatteryAny === false || AnyCharging ? null : Minutes(RunTime),
    },
    OnBattery: OnBatteryAny,
  };
}

const HOST_TIMEOUT_MS = 15000;
const Host = CreatePowerShellHost('PowerPowerShellHost');

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
    `$ErrorActionPreference = 'Stop'; ${Script}`,
  ]);
}

export async function CollectWindowsPower(): Promise<Result<PowerReading>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_BATTERY_SCRIPT);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [null, { Backend: 'wmi', ...MapWin32Battery(ParseWin32Battery(Output)) }];
  } catch (error) {
    return [error, null];
  }
}

// ---------------------------------------------------------------------------
// macOS: pmset -g batt
// ---------------------------------------------------------------------------

/**
 * `pmset -g batt`:
 *
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=22216803)	78%; discharging; 3:03 remaining present: true
 *
 * The state is one of charging, discharging, charged, "finishing charge" or
 * "AC attached; not charging"; the estimate is "H:MM remaining" or "(no
 * estimate)". A Mac with no battery prints only the first line. A UPS on USB
 * appears as its own line and is not the machine's battery, so only
 * InternalBattery lines count.
 */
export function ParsePmsetBatt(Output: string): Omit<PowerReading, 'Backend'> {
  const Text = String(Output || '');
  const Source = /Now drawing from '([^']+)'/i.exec(Text);
  let OnBattery: boolean | null = null;
  if (Source && Source[1]) {
    const Name = Source[1].toLowerCase();
    if (Name.startsWith('ac')) OnBattery = false;
    // A UPS on battery is still "not on mains", which is what the field asks.
    else if (Name.includes('battery') || Name.includes('ups')) OnBattery = true;
  }

  const Line = Text.split(/\r?\n/).find((Entry) => /-InternalBattery-\d+/i.test(Entry));
  if (!Line) return { Battery: null, OnBattery };

  const Detail = /(\d+)%\s*;\s*([^;]*?)\s*(?:;\s*(.*))?$/.exec(Line);
  const State = Detail && Detail[2] ? Detail[2].trim().toLowerCase() : '';
  const Rest = Detail && Detail[3] ? Detail[3].toLowerCase() : '';
  let Charging: boolean | null = null;
  if (State === 'charging' || State === 'finishing charge') Charging = true;
  else if (State === 'discharging' || State === 'charged') Charging = false;
  else if (State.startsWith('ac attached')) Charging = /not charging/.test(Rest) ? false : null;

  // "H:MM remaining" is time to EMPTY only while discharging; while charging the
  // same text is time to full, which is not what the field reports.
  let TimeRemainingMinutes: number | null = null;
  const Remaining = /(\d+):(\d{2})\s+remaining/i.exec(Rest);
  if (State === 'discharging' && Remaining) {
    TimeRemainingMinutes = Minutes(Number(Remaining[1]) * 60 + Number(Remaining[2]));
  }
  if (State === 'discharging' && OnBattery === null) OnBattery = true;

  return {
    Battery: {
      Percent: Detail ? Percent(Detail[1]) : null,
      Charging,
      TimeRemainingMinutes,
    },
    OnBattery,
  };
}

export async function CollectMacPower(): Promise<Result<PowerReading>> {
  const [Error_, Output] = await RunCommand('pmset', ['-g', 'batt']);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  return [null, { Backend: 'pmset', ...ParsePmsetBatt(Output) }];
}

// ---------------------------------------------------------------------------
// Linux: /sys/class/power_supply
// ---------------------------------------------------------------------------

/** Filesystem access for the sysfs readers, injectable so tests need no /sys. */
export interface SysfsReader {
  ReadDir(Directory: string): string[];
  /** The file's text, or null when it does not exist or cannot be read. */
  ReadFile(File: string): string | null;
}

export const NodeSysfsReader: SysfsReader = {
  ReadDir: (Directory) => fs.readdirSync(Directory),
  ReadFile: (File) => {
    try {
      return fs.readFileSync(File, 'utf8');
    } catch (_error) {
      return null;
    }
  },
};

function Attribute(Reader: SysfsReader, Directory: string, Name: string): string | null {
  const Value = Reader.ReadFile(path.posix.join(Directory, Name));
  return Value === null ? null : Value.trim();
}

function NumberAttribute(Reader: SysfsReader, Directory: string, Name: string): number | null {
  const Value = Attribute(Reader, Directory, Name);
  if (Value === null || Value === '') return null;
  const Parsed = Number(Value);
  return Number.isFinite(Parsed) ? Parsed : null;
}

/**
 * Read every power supply. Batteries are type "Battery" with scope other than
 * "Device" (a wireless mouse's battery is scope Device, and is not the
 * machine's); mains is any "Mains" supply, plus "USB" ones, since a USB-C
 * charger is how most current laptops take power.
 *
 * A missing power_supply class — containers, minimal kernels — reads as "no
 * supplies", the same as a desktop with no battery.
 */
export function ReadLinuxPowerSupply(
  Root = '/sys/class/power_supply',
  Reader: SysfsReader = NodeSysfsReader
): Omit<PowerReading, 'Backend'> {
  let Entries: string[];
  try {
    Entries = Reader.ReadDir(Root);
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return { Battery: null, OnBattery: null };
    throw error;
  }

  const Percents: number[] = [];
  const Statuses: string[] = [];
  let EnergyNow = 0;
  let PowerNow = 0;
  let HaveRate = false;
  let BatteryCount = 0;
  let MainsCount = 0;
  let MainsOnline = false;

  for (const Entry of [...Entries].sort()) {
    const Directory = path.posix.join(Root, Entry);
    const Type = (Attribute(Reader, Directory, 'type') || '').toLowerCase();
    if (Type === 'battery') {
      if ((Attribute(Reader, Directory, 'scope') || '').toLowerCase() === 'device') continue;
      if (Attribute(Reader, Directory, 'present') === '0') continue;
      BatteryCount += 1;
      const Capacity = Percent(Attribute(Reader, Directory, 'capacity'));
      if (Capacity !== null) Percents.push(Capacity);
      Statuses.push((Attribute(Reader, Directory, 'status') || '').toLowerCase());
      // Energy (µWh over µW) or charge (µAh over µA): either ratio is hours left.
      const Energy =
        NumberAttribute(Reader, Directory, 'energy_now') ??
        NumberAttribute(Reader, Directory, 'charge_now');
      const Rate =
        NumberAttribute(Reader, Directory, 'power_now') ??
        NumberAttribute(Reader, Directory, 'current_now');
      if (Energy !== null && Rate !== null && Rate !== 0) {
        EnergyNow += Energy;
        PowerNow += Math.abs(Rate);
        HaveRate = true;
      }
    } else if (Type === 'mains' || Type === 'usb') {
      const Online = Attribute(Reader, Directory, 'online');
      if (Online === null) continue;
      MainsCount += 1;
      if (Online === '1') MainsOnline = true;
    }
  }

  const Charging = Statuses.includes('charging')
    ? true
    : Statuses.some((Status) => ['discharging', 'full', 'not charging'].includes(Status))
      ? false
      : null;
  const Discharging = Statuses.includes('discharging');
  // A charger that says it is online is the strongest evidence; every charger
  // offline on a machine with a battery is the next; the battery's own status
  // covers machines whose charger is not exposed at all.
  let OnBattery: boolean | null = null;
  if (MainsOnline) OnBattery = false;
  else if (MainsCount > 0 && BatteryCount > 0) OnBattery = true;
  else if (Discharging) OnBattery = true;
  else if (Charging === true) OnBattery = false;

  if (BatteryCount === 0) return { Battery: null, OnBattery };
  return {
    Battery: {
      Percent: Percents.length
        ? Math.round(Percents.reduce((Sum, Value) => Sum + Value, 0) / Percents.length)
        : null,
      Charging,
      TimeRemainingMinutes:
        Discharging && HaveRate && PowerNow > 0 ? Minutes((EnergyNow / PowerNow) * 60) : null,
    },
    OnBattery,
  };
}

export async function CollectLinuxPower(): Promise<Result<PowerReading>> {
  try {
    return [null, { Backend: 'sysfs', ...ReadLinuxPowerSupply() }];
  } catch (error) {
    return [error, null];
  }
}

// ---------------------------------------------------------------------------

export async function CollectPower(Platform: string = process.platform): Promise<PowerCollection> {
  let Outcome: Result<PowerReading>;
  if (Platform === 'win32') Outcome = await CollectWindowsPower();
  else if (Platform === 'darwin') Outcome = await CollectMacPower();
  else if (Platform === 'linux') Outcome = await CollectLinuxPower();
  else {
    return {
      Ok: false,
      Unsupported: true,
      Error: new Error(`Battery monitoring is not available on ${Platform}`),
    };
  }
  const [Error_, Reading] = Outcome;
  if (!Error_ && Reading) return { Ok: true, Reading };
  return { Ok: false, Unsupported: false, Error: Error_ || new Error('Power sample failed') };
}

/** Release resident sampler state (the Windows PowerShell host). */
export function DisposePowerSamplers(): void {
  Host.Dispose();
}

export const _internal = { Host, HOST_TIMEOUT_MS, WIN32_RUNTIME_UNKNOWN };
