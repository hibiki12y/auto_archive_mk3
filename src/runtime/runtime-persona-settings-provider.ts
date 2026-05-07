/**
 * Runtime persona settings provider.
 *
 * Dispatch-boundary hot-swap seam (multi-provider-scope.md §1.3.0). Each
 * RuntimeDriver consults this provider when entering `run()` to resolve the
 * effective model / effort / maxTurns for the persona it represents. The
 * provider returns *operator-specified overrides only*; the driver falls back
 * to its bootstrap-time defaults when an override is absent.
 *
 * Two implementations are useful in production:
 *
 *   1. {@link InMemoryRuntimePersonaSettingsProvider} — in-process state,
 *      mutated synchronously by Discord `/config set`.
 *   2. {@link FileBackedRuntimePersonaSettingsProvider} — reads
 *      `runtime-state/persona-settings.json` lazily on each call so an
 *      out-of-process writer (CLI, future REST surface) is also picked up.
 *
 * The provider does NOT validate values — coercion happens at the input
 * boundary (`coerceSettingValue` in `discord/persona-settings-store.ts`).
 * The provider treats the store's typed override shape as authoritative and
 * just plumbs it to the driver.
 */

import type {
  PersonaName,
  PersonaOverride,
  PersonaSettingsRecord,
} from '../discord/persona-settings-store.js';

export interface RuntimePersonaSettings {
  readonly model?: string;
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTurns?: number;
  readonly provider?: 'codex' | 'claude-agent';
}

export interface RuntimePersonaSettingsProvider {
  /** Snapshot of the current operator overrides for `persona`. */
  readSettings(persona: PersonaName): RuntimePersonaSettings;
}

/**
 * In-memory provider. The Discord `/config` handler holds a reference and
 * calls `apply()` after each successful store write so the next dispatch
 * reads the new values without restart.
 */
export class InMemoryRuntimePersonaSettingsProvider
  implements RuntimePersonaSettingsProvider
{
  private aronaSnapshot: RuntimePersonaSettings;
  private planaSnapshot: RuntimePersonaSettings;

  constructor(initial?: PersonaSettingsRecord) {
    this.aronaSnapshot = projectSettings(initial?.arona);
    this.planaSnapshot = projectSettings(initial?.plana);
  }

  readSettings(persona: PersonaName): RuntimePersonaSettings {
    return persona === 'arona' ? this.aronaSnapshot : this.planaSnapshot;
  }

  /**
   * Replace the in-memory snapshot wholesale. Pass the post-write store record.
   */
  apply(record: PersonaSettingsRecord): void {
    this.aronaSnapshot = projectSettings(record.arona);
    this.planaSnapshot = projectSettings(record.plana);
  }
}

/**
 * File-backed provider. Re-reads the JSON store on each access so an
 * out-of-process writer is also visible. Failures (missing file, malformed
 * JSON) collapse to "no override" — the dispatch keeps running with the
 * bootstrap-time defaults instead of failing closed.
 */
export class FileBackedRuntimePersonaSettingsProvider
  implements RuntimePersonaSettingsProvider
{
  constructor(
    private readonly filePath: string,
    private readonly loader: (path: string) => PersonaSettingsRecord,
  ) {}

  readSettings(persona: PersonaName): RuntimePersonaSettings {
    let record: PersonaSettingsRecord;
    try {
      record = this.loader(this.filePath);
    } catch {
      return {};
    }
    return projectSettings(persona === 'arona' ? record.arona : record.plana);
  }
}

/**
 * Composite provider: prefer a primary provider's value, fall back to a
 * secondary. Used when both an in-memory writer (Discord `/config`) and a
 * file-backed writer (out-of-process) are wired simultaneously.
 */
export class CompositeRuntimePersonaSettingsProvider
  implements RuntimePersonaSettingsProvider
{
  constructor(
    private readonly primary: RuntimePersonaSettingsProvider,
    private readonly fallback: RuntimePersonaSettingsProvider,
  ) {}

  readSettings(persona: PersonaName): RuntimePersonaSettings {
    const primary = this.primary.readSettings(persona);
    const fallback = this.fallback.readSettings(persona);
    return {
      ...(primary.provider !== undefined
        ? { provider: primary.provider }
        : fallback.provider !== undefined
          ? { provider: fallback.provider }
          : {}),
      ...(primary.model !== undefined
        ? { model: primary.model }
        : fallback.model !== undefined
          ? { model: fallback.model }
          : {}),
      ...(primary.effort !== undefined
        ? { effort: primary.effort }
        : fallback.effort !== undefined
          ? { effort: fallback.effort }
          : {}),
      ...(primary.maxTurns !== undefined
        ? { maxTurns: primary.maxTurns }
        : fallback.maxTurns !== undefined
          ? { maxTurns: fallback.maxTurns }
          : {}),
    };
  }
}

function projectSettings(
  override: PersonaOverride | undefined,
): RuntimePersonaSettings {
  if (!override) return {};
  const out: RuntimePersonaSettings = {};
  if (override.provider !== undefined) {
    (out as { provider?: 'codex' | 'claude-agent' }).provider =
      override.provider;
  }
  if (override.model !== undefined && override.model.length > 0) {
    (out as { model?: string }).model = override.model;
  }
  if (override.effort !== undefined) {
    (out as { effort?: RuntimePersonaSettings['effort'] }).effort =
      override.effort;
  }
  if (override.max_turns !== undefined) {
    (out as { maxTurns?: number }).maxTurns = override.max_turns;
  }
  return out;
}
