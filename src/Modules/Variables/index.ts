import fs from 'fs';
import path from 'path';

import type { VariableEnvironment, VariablePayload } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { Manager as WindowsEnvironment } from '../WindowsEnvironment';

const Logger = CreateLogger('Variables');

// Show variables (client side).
//
// The server resolves each client's variables — defaults, per-client overrides,
// prefixing — and pushes a finished environment block here. This module's only
// jobs are to hold that block, survive a restart, hand it to ScriptManager at
// spawn time, and (on Windows) mirror the exported subset into the user
// environment.
//
// Why it is persisted: the tray menu and the run-on-launch action can both fire
// before — or entirely without — a server connection. A script that runs at boot
// with an empty environment would silently behave as though every variable were
// unset, which is worse than acting on values that are one edit stale. The cache
// is refreshed on every connect, so the stale window is the time between launch
// and the first connection.
//
// The file is plain text and readable by any process running as this user. That
// is documented in the server's UI: variables are configuration, not secrets.

/** Filename inside the profile directory, beside ScriptDeploymentState.json. */
const VARIABLES_FILE = 'Variables.json';

/**
 * Only names matching this are ever injected.
 *
 * The server already applies the prefix, so this is a second, independent gate:
 * it means a compromised or spoofed server cannot use this channel to set PATH,
 * COMSPEC or any other variable the script's tooling trusts. Adoption pins the
 * server identity, so it is not reachable by an unauthenticated peer — but the
 * blast radius of a bad server should stop short of rewriting the environment.
 */
const VARIABLE_NAME_PATTERN = /^SHOWTRAK_VAR_[A-Z0-9_]+$/;

let Environment: VariableEnvironment = {};
let Exported: string[] = [];
let Loaded = false;

const Internal = {
  GetStatePath(): string {
    return path.join(AppDataManager.GetProfileDirectory(), VARIABLES_FILE);
  },

  /**
   * Drop anything that is not a well-formed show variable.
   *
   * Values are coerced to strings and stripped of control characters: NUL would
   * be rejected by Node outright, and CR/LF break batch parsing in ways that
   * look like a corrupt script rather than a bad value. The server sanitizes
   * too; this repeats it because the file on disk can also be hand-edited.
   */
  Sanitize(Raw: unknown): VariableEnvironment {
    const Result: VariableEnvironment = {};
    if (!Raw || typeof Raw !== 'object') return Result;
    for (const [Key, Value] of Object.entries(Raw as Record<string, unknown>)) {
      if (!VARIABLE_NAME_PATTERN.test(Key)) {
        Logger.warn(`Ignoring variable with unexpected name: ${Key}`);
        continue;
      }
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      Result[Key] = String(Value == null ? '' : Value).replace(/[\u0000-\u001F\u007F]/g, '');
    }
    return Result;
  },

  SanitizeExported(Raw: unknown, Available: VariableEnvironment): string[] {
    if (!Array.isArray(Raw)) return [];
    return Raw.map((Name) => String(Name == null ? '' : Name)).filter(
      (Name) => VARIABLE_NAME_PATTERN.test(Name) && Object.hasOwn(Available, Name)
    );
  },

  Load(): void {
    if (Loaded) return;
    Loaded = true;
    const StatePath = Internal.GetStatePath();
    try {
      if (!fs.existsSync(StatePath)) return;
      const Parsed = JSON.parse(fs.readFileSync(StatePath, 'utf-8') || '{}');
      Environment = Internal.Sanitize(Parsed && Parsed.Environment);
      Exported = Internal.SanitizeExported(Parsed && Parsed.Exported, Environment);
      Logger.log(`Loaded ${Object.keys(Environment).length} variable(s) from disk`);
    } catch (Err) {
      Logger.warn(`Failed to load variables from disk: ${(Err as Error).message}`);
      Environment = {};
      Exported = [];
    }
  },

  Persist(): void {
    const StatePath = Internal.GetStatePath();
    try {
      fs.writeFileSync(
        StatePath,
        JSON.stringify({ Environment, Exported, UpdatedAt: Date.now() }, null, 2)
      );
    } catch (Err) {
      Logger.warn(`Failed to persist variables: ${(Err as Error).message}`);
    }
  },
};

export const Manager = {
  /**
   * Replace the cached environment with a server push.
   *
   * Always reconciles the Windows user environment afterwards, including when
   * the set shrinks: a variable that was deleted server-side has to be REMOVED
   * from the registry, or it would linger on that machine for good. Reconcile is
   * a no-op on macOS and Linux.
   */
  async Set(Payload: VariablePayload | null | undefined): Promise<void> {
    Internal.Load();
    const Next = Internal.Sanitize(Payload && Payload.Environment);
    const NextExported = Internal.SanitizeExported(Payload && Payload.Exported, Next);

    Environment = Next;
    Exported = NextExported;
    Internal.Persist();
    Logger.log(`Applied ${Object.keys(Environment).length} variable(s) from server`);

    await WindowsEnvironment.Reconcile(Manager.GetExportedEnvironment());
  },

  /** The full environment block injected into every script this client runs. */
  GetEnvironment(): VariableEnvironment {
    Internal.Load();
    return { ...Environment };
  },

  /** Only the subset the operator marked for the Windows user environment. */
  GetExportedEnvironment(): VariableEnvironment {
    Internal.Load();
    const Result: VariableEnvironment = {};
    for (const Name of Exported) {
      if (Object.hasOwn(Environment, Name)) Result[Name] = Environment[Name] as string;
    }
    return Result;
  },

  /**
   * Sanitize a per-dispatch environment sent alongside an ExecuteScript.
   *
   * The server resolves variables at dispatch time, so this is fresher than the
   * pushed cache and wins for that one run. It is deliberately NOT stored: it
   * describes one execution, and an older server omits it entirely, in which
   * case the caller falls back to the cache.
   */
  Adopt(Raw: unknown): VariableEnvironment | null {
    if (!Raw || typeof Raw !== 'object') return null;
    return Internal.Sanitize(Raw);
  },

  /**
   * Forget everything and clear anything exported to the Windows environment.
   * Called on unadoption — a client that no longer belongs to a show must not
   * keep that show's values in its registry.
   */
  async Clear(): Promise<void> {
    Internal.Load();
    Environment = {};
    Exported = [];
    Internal.Persist();
    await WindowsEnvironment.Reconcile({});
  },
};

export const _internal = Internal;
