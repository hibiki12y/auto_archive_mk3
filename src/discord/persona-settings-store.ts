/**
 * Persona settings store.
 *
 * Operator-facing convention bound to the Discord `/config` command:
 *
 *   Arona  := dispatched-task runtime  (`AUTO_ARCHIVE_RUNTIME_PROVIDER`)
 *   Plana  := runtime advisor          (`AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER`)
 *
 * The store persists operator intent — the desired provider, model, reasoning
 * effort, and max-turns for each persona. It is a *layer above* the env-var
 * bootstrap path: env values remain authoritative for the currently-running
 * service, and a setting written here applies on the next service restart.
 *
 * The store does not mid-flight switch the runtime provider — that case is
 * explicitly out of scope per `specs/CLARIFICATIONS/multi-provider-scope.md`.
 *
 * Persistence: a single JSON file at `<runtimeStateDir>/persona-settings.json`
 * (gitignored as part of `runtime-state/`). Concurrent writers are serialized
 * by the JS event loop within one process; this is not a multi-process safe
 * record store and that limitation is acceptable for the Discord bot's
 * single-instance posture.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type PersonaName = 'arona' | 'plana';
export const PERSONA_NAMES: readonly PersonaName[] = ['arona', 'plana'];

export type PersonaSettingKey = 'provider' | 'model' | 'effort' | 'max_turns';
export const PERSONA_SETTING_KEYS: readonly PersonaSettingKey[] = [
  'provider',
  'model',
  'effort',
  'max_turns',
];

export type PersonaProvider = 'codex' | 'claude-agent';
export const PERSONA_PROVIDER_VALUES: readonly PersonaProvider[] = [
  'codex',
  'claude-agent',
];

export type PersonaEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export const PERSONA_EFFORT_VALUES: readonly PersonaEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface PersonaOverride {
  readonly provider?: PersonaProvider;
  readonly model?: string;
  readonly effort?: PersonaEffort;
  readonly max_turns?: number;
}

export interface PersonaSettingsRecord {
  readonly schemaVersion: 1;
  readonly arona: PersonaOverride;
  readonly plana: PersonaOverride;
}

export const EMPTY_SETTINGS: PersonaSettingsRecord = Object.freeze({
  schemaVersion: 1,
  arona: Object.freeze({}),
  plana: Object.freeze({}),
});

export class PersonaSettingsValidationError extends Error {
  readonly persona: PersonaName | undefined;
  readonly key: PersonaSettingKey | undefined;
  constructor(
    message: string,
    options: {
      persona?: PersonaName;
      key?: PersonaSettingKey;
    } = {},
  ) {
    super(message);
    this.name = 'PersonaSettingsValidationError';
    this.persona = options.persona;
    this.key = options.key;
  }
}

const MODEL_MAX_LENGTH = 80;
const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 100;

export function validatePersonaName(value: string): PersonaName {
  if (!PERSONA_NAMES.includes(value as PersonaName)) {
    throw new PersonaSettingsValidationError(
      `persona must be one of: ${PERSONA_NAMES.join(', ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as PersonaName;
}

export function validateSettingKey(value: string): PersonaSettingKey {
  if (!PERSONA_SETTING_KEYS.includes(value as PersonaSettingKey)) {
    throw new PersonaSettingsValidationError(
      `key must be one of: ${PERSONA_SETTING_KEYS.join(', ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as PersonaSettingKey;
}

/**
 * Coerce a raw operator-supplied value into the typed override shape for the
 * given key. Throws PersonaSettingsValidationError on invalid input.
 */
export function coerceSettingValue(
  persona: PersonaName,
  key: PersonaSettingKey,
  raw: string,
): string | number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PersonaSettingsValidationError(`${key} value must not be empty`, {
      persona,
      key,
    });
  }
  if (key === 'provider') {
    if (!PERSONA_PROVIDER_VALUES.includes(trimmed as PersonaProvider)) {
      throw new PersonaSettingsValidationError(
        `provider must be one of: ${PERSONA_PROVIDER_VALUES.join(', ')}; got ${JSON.stringify(trimmed)}`,
        { persona, key },
      );
    }
    return trimmed;
  }
  if (key === 'effort') {
    if (!PERSONA_EFFORT_VALUES.includes(trimmed as PersonaEffort)) {
      throw new PersonaSettingsValidationError(
        `effort must be one of: ${PERSONA_EFFORT_VALUES.join(', ')}; got ${JSON.stringify(trimmed)}`,
        { persona, key },
      );
    }
    return trimmed;
  }
  if (key === 'model') {
    if (trimmed.length > MODEL_MAX_LENGTH) {
      throw new PersonaSettingsValidationError(
        `model name must be ≤ ${MODEL_MAX_LENGTH} chars; got ${trimmed.length}`,
        { persona, key },
      );
    }
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      throw new PersonaSettingsValidationError(
        'model name allows only A-Z, a-z, 0-9, dot, dash, underscore',
        { persona, key },
      );
    }
    return trimmed;
  }
  if (key === 'max_turns') {
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < MAX_TURNS_MIN || n > MAX_TURNS_MAX) {
      throw new PersonaSettingsValidationError(
        `max_turns must be an integer in [${MAX_TURNS_MIN}, ${MAX_TURNS_MAX}]; got ${JSON.stringify(trimmed)}`,
        { persona, key },
      );
    }
    return n;
  }
  throw new PersonaSettingsValidationError(`unhandled key ${key}`, { persona, key });
}

/**
 * Load the persona settings record from disk. Returns EMPTY_SETTINGS when the
 * file does not exist or is unreadable; the caller need not handle ENOENT.
 *
 * Schema validation: the file must contain a JSON object with `schemaVersion`
 * 1 and zero or more `arona`/`plana` override blobs. Unknown keys inside an
 * override are dropped silently. A schema mismatch yields EMPTY_SETTINGS so
 * that operator typos do not poison subsequent reads.
 */
export function loadPersonaSettings(filePath: string): PersonaSettingsRecord {
  if (!existsSync(filePath)) {
    return EMPTY_SETTINGS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return EMPTY_SETTINGS;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return EMPTY_SETTINGS;
  }
  const root = parsed as Record<string, unknown>;
  return {
    schemaVersion: 1,
    arona: sanitizeOverride(root.arona),
    plana: sanitizeOverride(root.plana),
  };
}

export function savePersonaSettings(
  filePath: string,
  record: PersonaSettingsRecord,
): void {
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Merge a single setting into the existing record and return the new record.
 * Pure: input is not mutated.
 */
export function withPersonaSetting(
  record: PersonaSettingsRecord,
  persona: PersonaName,
  key: PersonaSettingKey,
  value: string | number,
): PersonaSettingsRecord {
  const existing = persona === 'arona' ? record.arona : record.plana;
  const next = { ...existing, [key]: value };
  return {
    schemaVersion: 1,
    arona: persona === 'arona' ? next : record.arona,
    plana: persona === 'plana' ? next : record.plana,
  };
}

/**
 * Drop all overrides for `persona` and return the new record.
 */
export function withPersonaReset(
  record: PersonaSettingsRecord,
  persona: PersonaName,
): PersonaSettingsRecord {
  return {
    schemaVersion: 1,
    arona: persona === 'arona' ? {} : record.arona,
    plana: persona === 'plana' ? {} : record.plana,
  };
}

function sanitizeOverride(raw: unknown): PersonaOverride {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const result: PersonaOverride = {};
  if (
    typeof obj.provider === 'string' &&
    PERSONA_PROVIDER_VALUES.includes(obj.provider as PersonaProvider)
  ) {
    (result as { provider?: PersonaProvider }).provider =
      obj.provider as PersonaProvider;
  }
  if (typeof obj.model === 'string' && obj.model.trim().length > 0) {
    (result as { model?: string }).model = obj.model.trim();
  }
  if (
    typeof obj.effort === 'string' &&
    PERSONA_EFFORT_VALUES.includes(obj.effort as PersonaEffort)
  ) {
    (result as { effort?: PersonaEffort }).effort = obj.effort as PersonaEffort;
  }
  if (
    typeof obj.max_turns === 'number' &&
    Number.isInteger(obj.max_turns) &&
    obj.max_turns >= MAX_TURNS_MIN &&
    obj.max_turns <= MAX_TURNS_MAX
  ) {
    (result as { max_turns?: number }).max_turns = obj.max_turns;
  }
  return result;
}
