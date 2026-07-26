// Console + file logger with coloured tags.
//
// Level ranking, default-level derivation and the formatting helpers come from
// @showtrak/protocol/runtime, shared with ShowTrakServer. The SINK below does
// not: this app appends SYNCHRONOUSLY, because an unattended agent that crashes
// must not lose the lines that explain why — the Server queues asynchronous
// appends instead. That difference is deliberate, which is why only the pure
// half is shared.
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';

import IsInInstallation from 'electron-squirrel-startup';

import {
  GetDatestampLabel,
  GetDateTimeStamp,
  IsLevelEnabled as IsLevelEnabledFor,
  Pad,
  ResolveDefaultLevel,
} from '@showtrak/protocol/runtime';
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

const Types = {
  Info: pc.cyan(Pad('INFO')),
  Warn: pc.magenta(Pad('WARN')),
  Error: pc.red(Pad('ERROR')),
  Trace: pc.magenta(Pad('TRACE')),
  Debug: pc.gray(Pad('DEBUG')),
  Success: pc.green(Pad('SUCCESS')),
  Database: pc.gray(Pad('DATABASE')),
};

type LogType = keyof typeof Types;

function Tag(Text: string, Type: LogType): string {
  return `[${pc.cyan('ShowTrakClient')}] [${pc.cyan(Pad(Text))}] [${Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types['Info']}]`;
}

// --- Log level gating -------------------------------------------------------
//
// The rule itself lives in ResolveDefaultLevel (shared with the Server, so the
// two cannot drift apart again — they had). `process.defaultApp` is passed in
// rather than read there because Logger is the lowest module in the tree:
// everything imports it, and an `electron` dependency would stop it loading
// outside an Electron main process, including in the test suite.
//
// LOG_LEVEL overrides the derived default, which is the point: a client
// misbehaving on site can be relaunched with LOG_LEVEL=debug and the extra
// detail lands in the log file the operator sends back.
const DefaultLevel = ResolveDefaultLevel({
  nodeEnv: process.env.NODE_ENV,
  isPackagedBuild: !process.defaultApp,
});

const Settings = {
  level: (process.env.LOG_LEVEL || DefaultLevel).toLowerCase(),
};

function IsLevelEnabled(Level: string): boolean {
  return IsLevelEnabledFor(Level, Settings.level, DefaultLevel);
}

interface LoggerConfigureOptions {
  level?: string;
}

/** Change the active level at runtime (e.g. from a setting). */
export function configure(options: LoggerConfigureOptions = {}): void {
  if (options.level) Settings.level = String(options.level).toLowerCase();
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
    if (!IsLevelEnabled('info')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Info'), arg));
    args.forEach(WriteToFile);
  }
  info(...args: unknown[]): void {
    if (!IsLevelEnabled('info')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Info'), arg));
    args.forEach(WriteToFile);
  }
  // Deliberately NOT gated: silent() exists to put something in the file that
  // was never meant for the console, so suppressing it by level would lose the
  // record entirely rather than just quieten it.
  silent(...args: unknown[]): void {
    args.forEach(WriteToFile);
  }
  warn(...args: unknown[]): void {
    if (!IsLevelEnabled('warn')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Warn'), arg));
    args.forEach(WriteToFile);
  }
  error(...args: unknown[]): void {
    if (!IsLevelEnabled('error')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Error'), arg));
    args.forEach(WriteToFile);
  }
  // Suppressed in a shipped build unless LOG_LEVEL says otherwise. Debug output
  // now also reaches the log FILE when enabled — without that, LOG_LEVEL=debug
  // on a client in the field would only reach a console nobody is watching,
  // which is the case the override exists for.
  debug(...args: unknown[]): void {
    if (!IsLevelEnabled('debug')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Debug'), arg));
    args.forEach(WriteToFile);
  }
  success(...args: unknown[]): void {
    if (!IsLevelEnabled('info')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Success'), arg));
    args.forEach(WriteToFile);
  }
  database(...args: unknown[]): void {
    if (!IsLevelEnabled('debug')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Database'), arg));
    args.forEach(WriteToFile);
  }
  // Kept at error level: a database failure on a client is not diagnostic
  // chatter, it is the reason the client will misbehave next.
  databaseError(...args: unknown[]): void {
    if (!IsLevelEnabled('error')) return;
    args.forEach((arg) => WriteToConsole(Tag(this.Alias, 'Database'), pc.red(String(arg))));
    args.forEach(WriteToFile);
  }
}

export type { Logger };

export function CreateLogger(Alias: string): Logger {
  return new Logger(Alias);
}
