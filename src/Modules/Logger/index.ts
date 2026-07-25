import colors from 'colors';
import fs from 'fs';
import path from 'path';

import IsInInstallation from 'electron-squirrel-startup';

import { Manager as AppDataManager } from '../AppData';

const LogDirectory = AppDataManager.GetLogsDirectory();
console.log(`Log Directory: ${LogDirectory}`);
const LogFileName = `ShowTrakClient-${GetDatestampLabel()}.log`;
if (!fs.existsSync(LogDirectory)) {
  fs.mkdirSync(LogDirectory, { recursive: true });
}
const LogFilePath = path.join(LogDirectory, LogFileName);
if (!fs.existsSync(LogFilePath)) {
  fs.writeFileSync(LogFilePath, '', 'utf8');
}

function Pad(Text: string, Length = 17): string {
  return Text.padEnd(Length, ' ').toUpperCase();
}

const Types = {
  Info: colors.cyan(Pad('INFO')),
  Warn: colors.magenta(Pad('WARN')),
  Gay: colors.rainbow(Pad('GAY')),
  Error: colors.red(Pad('ERROR')),
  Trace: colors.magenta(Pad('TRACE')),
  Debug: colors.grey(Pad('DEBUG')),
  Success: colors.green(Pad('SUCCESS')),
  Database: colors.grey(Pad('DATABASE')),
};

type LogType = keyof typeof Types;

function Tag(Text: string, Type: LogType): string {
  return `[${colors.cyan('ShowTrakServer')}] [${colors.cyan(Pad(Text))}] [${Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types['Info']}]`;
}

function GetDatestampLabel(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function GetDateTimeStamp(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

// Console and file writes are both fail-safe. A ShowTrak Client launched with a
// pipe that later closes (or a log volume that fills / goes read-only) would
// otherwise throw EPIPE/ENOSPC out of an ordinary log call — and because the
// process guards log through this same module, that would recurse. Logging must
// never be the thing that takes the agent down.
let ConsoleAvailable = true;

// A ShowTrak Client started with a pipe (a launcher, a CI shell, `| head`) can
// outlive the reader. Node reports that asynchronously as an 'error' on the
// stream — NOT as a throw from console.log — so without a listener it escalates
// to an uncaughtException, and with only a process-level guard it would emit one
// warning per log line forever. Attaching a listener both stops the escalation
// and lets us latch the sink off after the first failure.
for (const Stream of [process.stdout, process.stderr]) {
  Stream.on('error', () => {
    ConsoleAvailable = false;
  });
}

function WriteToConsole(...args: unknown[]): void {
  if (!ConsoleAvailable) return;
  try {
    console.log(...args);
  } catch {
    // Synchronous failure (a closed fd); the file sink remains the record.
    ConsoleAvailable = false;
  }
}

function WriteToFile(Line: unknown): void {
  if (IsInInstallation) return;
  if (typeof Line !== 'string') return;
  try {
    if (!fs.existsSync(LogDirectory)) return;
    fs.appendFileSync(LogFilePath, `${GetDateTimeStamp()} > ${Line}` + '\n', 'utf8');
  } catch {
    // Disk full, permissions changed, directory removed — never fatal.
  }
}

class Logger {
  Alias: string;

  constructor(Alias: string) {
    this.Alias = Alias;
  }
  log(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Info'), arg));
    args.forEach(WriteToFile);
  }
  info(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Info'), arg));
    args.forEach(WriteToFile);
  }
  silent(...args: unknown[]): void {
    args.forEach(WriteToFile);
  }
  warn(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Warn'), arg));
    args.forEach(WriteToFile);
  }
  error(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Error'), arg));
    args.forEach(WriteToFile);
  }
  // NOTE: this used to be gated on `Config.Production`, but Logger imported the
  // Config *module* rather than its `Config` export, so the flag was always
  // undefined and debug output was never actually suppressed. The dead guard
  // (and the Config import that existed only to serve it) is gone; behaviour is
  // unchanged. Reintroducing a real production gate is a separate decision.
  debug(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Debug'), arg));
  }
  success(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Success'), arg));
    args.forEach(WriteToFile);
  }
  database(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Database'), arg));
    args.forEach(WriteToFile);
  }
  databaseError(...args: unknown[]): void {
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Database'), colors.red(String(arg))));
    args.forEach(WriteToFile);
  }
}

export type { Logger };

export function CreateLogger(Alias: string): Logger {
  return new Logger(Alias);
}
