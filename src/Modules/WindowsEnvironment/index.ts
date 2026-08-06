import { spawn } from 'child_process';

import type { VariableEnvironment } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('WindowsEnvironment');

// Mirrors show variables into the Windows *user* environment (HKCU\Environment)
// so applications outside ShowTrak can read them.
//
// WHY .NET AND NOT `setx`
// `setx` truncates any value over 1024 characters (with a warning nobody sees in
// a headless service), and its change notification is unreliable. The .NET call
// `[Environment]::SetEnvironmentVariable(name, value, 'User')` writes the same
// registry key AND broadcasts WM_SETTINGCHANGE itself, which is what makes
// Explorer pick the change up. Since Explorer hands its environment to
// everything launched from the desktop or Start menu afterwards, that broadcast
// is the entire difference between "works" and "works after a reboot".
//
// WHAT THIS CANNOT DO
// An environment block is copied into a process when it is created and is never
// shared afterwards. No OS offers a way to change a running process's
// environment from outside. So a program that was ALREADY OPEN when a value
// changed will not see the new one until it is restarted. This is a property of
// Windows, not a limitation of the implementation, and the server's UI says so.
//
// SCOPE
// User scope only. Machine scope (HKLM) requires elevation, and the client runs
// as the logged-in user; asking for elevation to set a show variable would be a
// far worse trade than the per-user limitation. It also means a script running
// as a different account (a service, a scheduled task) will not see these.

/**
 * Names this module is allowed to touch.
 *
 * Every write and, more importantly, every DELETE is constrained to the show
 * variable namespace. The reconcile step below removes stale names by
 * enumerating what is in the registry — without this gate, a bug in that
 * enumeration could delete a user's real environment variables.
 */
const VARIABLE_NAME_PATTERN = /^SHOWTRAK_VAR_[A-Z0-9_]+$/;

/** Mirrors what we last wrote, so a no-op push does not re-hit the registry. */
let LastAppliedSignature: string | null = null;

/**
 * Set when PowerShell cannot be started at all (missing, blocked by policy).
 * Once unavailable we stop retrying on every push — a failing spawn on every
 * variable edit is its own problem, and the scripts still get their variables
 * through the injected environment regardless.
 */
let Unavailable = false;

function BuildSignature(Environment: VariableEnvironment): string {
  return JSON.stringify(
    Object.keys(Environment)
      .sort()
      .map((Key) => [Key, Environment[Key]])
  );
}

/**
 * Escape a value for embedding in a PowerShell single-quoted string.
 *
 * Single quotes are PowerShell's literal-string delimiter: nothing inside is
 * expanded, so `$(...)`, backticks and `;` are all inert. The only character
 * that can terminate the literal is a single quote, which is escaped by
 * doubling it. Values reach here from an operator's typing, so this is the seam
 * that decides whether a value can become a command.
 */
function QuoteForPowerShell(Value: string): string {
  return `'${String(Value).replace(/'/g, "''")}'`;
}

/**
 * Build the script that makes the machine's show variables match `Environment`
 * exactly: set/update everything present, remove anything prefixed that is not.
 *
 * Removal is what makes this a reconcile rather than an append. Without it,
 * deleting a variable in the Variable Manager (or unadopting the client) would
 * leave the value in that machine's registry indefinitely, and a script testing
 * `if defined %SHOWTRAK_VAR_X%` would keep seeing a variable the show no longer
 * has. Setting a value to $null is how .NET deletes it.
 */
function BuildReconcileScript(Environment: VariableEnvironment): string {
  const Lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    // Enumerate what is actually there rather than tracking it locally: the
    // registry is the source of truth, and it survives reinstalls, profile
    // resets and this process being killed mid-write.
    "$Existing = [Environment]::GetEnvironmentVariables('User').Keys | Where-Object { $_ -like 'SHOWTRAK_VAR_*' }",
  ];

  const Names = Object.keys(Environment).filter((Name) => VARIABLE_NAME_PATTERN.test(Name));

  const Wanted = Names.map((Name) => QuoteForPowerShell(Name)).join(', ');
  // @() forces an array even for zero or one element, so the -notin test below
  // behaves the same whether the show has one variable or fifty.
  Lines.push(`$Wanted = @(${Wanted})`);

  for (const Name of Names) {
    Lines.push(
      `[Environment]::SetEnvironmentVariable(${QuoteForPowerShell(Name)}, ${QuoteForPowerShell(
        Environment[Name] as string
      )}, 'User')`
    );
  }

  Lines.push(
    'foreach ($Name in $Existing) { if ($Name -notin $Wanted) { ' +
      "[Environment]::SetEnvironmentVariable($Name, $null, 'User') } }"
  );

  return Lines.join('\n');
}

function RunPowerShell(Script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let Child;
    try {
      Child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true }
      );
    } catch (Err) {
      Unavailable = true;
      return reject(Err as Error);
    }

    let StdErr = '';
    if (Child.stderr) {
      Child.stderr.setEncoding('utf8');
      Child.stderr.on('data', (Chunk: string) => {
        StdErr += Chunk;
      });
    }
    if (Child.stdout) Child.stdout.resume();

    Child.on('error', (Err: Error) => {
      // A spawn-time ENOENT lands here rather than as a throw.
      Unavailable = true;
      reject(Err);
    });

    Child.on('close', (Code: number | null) => {
      if (Code === 0) return resolve();
      reject(new Error(StdErr.trim() || `powershell exited with code ${Code}`));
    });

    // The script is fed over stdin rather than passed as an argument: it can run
    // to several KB with a large variable set, and a command line that long is
    // close to the Windows limit.
    if (!Child.stdin) return reject(new Error('powershell stdin unavailable'));
    Child.stdin.end(Script);
  });
}

export const Manager = {
  /** True only where the export is actually implemented. */
  IsSupported(): boolean {
    return process.platform === 'win32';
  },

  /**
   * Make the Windows user environment match `Environment` exactly.
   *
   * A no-op on macOS and Linux: `launchctl setenv` does not survive a logout and
   * `/etc/environment` needs root and a re-login, so neither delivers what this
   * promises on Windows. Scripts on those platforms still receive every variable
   * through the environment ShowTrak injects at spawn — only visibility to OTHER
   * applications is Windows-only.
   *
   * Never throws: a failure here must not stop scripts from running, since they
   * get their variables through the injected environment either way.
   */
  async Reconcile(Environment: VariableEnvironment): Promise<void> {
    if (!Manager.IsSupported()) return;
    if (Unavailable) return;

    const Signature = BuildSignature(Environment);
    // Skip a registry write and a WM_SETTINGCHANGE broadcast when nothing moved.
    // Definition changes fan out to every client, so without this every client
    // would rewrite its registry whenever any variable anywhere was edited.
    if (Signature === LastAppliedSignature) return;

    try {
      await RunPowerShell(BuildReconcileScript(Environment));
      LastAppliedSignature = Signature;
      Logger.success(
        `Windows environment reconciled (${Object.keys(Environment).length} variable(s) exported)`
      );
    } catch (Err) {
      Logger.warn(
        `Failed to update the Windows user environment: ${(Err as Error).message}. ` +
          'Scripts still receive variables normally; other applications will not see them.'
      );
    }
  },

  /** Test seam: forget the applied signature and the unavailable latch. */
  Reset(): void {
    LastAppliedSignature = null;
    Unavailable = false;
  },
};

export const _internal = { BuildReconcileScript, QuoteForPowerShell, BuildSignature };
