import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_SETTINGS,
  PersonaSettingsValidationError,
  coerceSettingValue,
  loadPersonaSettings,
  savePersonaSettings,
  validatePersonaName,
  validateSettingKey,
  withPersonaReset,
  withPersonaSetting,
} from '../src/discord/persona-settings-store.js';

describe('persona settings store', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persona-settings-'));
    path = join(dir, 'persona-settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns EMPTY_SETTINGS when the file does not exist', () => {
    expect(loadPersonaSettings(path)).toEqual(EMPTY_SETTINGS);
    expect(existsSync(path)).toBe(false);
  });

  it('round-trips a populated record', () => {
    const next = withPersonaSetting(
      withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.5'),
      'plana',
      'model',
      'claude-opus-4-7',
    );
    savePersonaSettings(path, next);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      arona: { model: 'gpt-5.5' },
      plana: { model: 'claude-opus-4-7' },
    });
    expect(loadPersonaSettings(path)).toEqual(next);
  });

  it('drops unknown keys silently when loading a foreign record', () => {
    savePersonaSettings(path, {
      schemaVersion: 1,
      arona: { model: 'gpt-5.5', extraneous: 'ignored' } as never,
      plana: {},
    });
    expect(loadPersonaSettings(path).arona).toEqual({ model: 'gpt-5.5' });
  });

  it('returns EMPTY_SETTINGS when schemaVersion is missing or wrong', () => {
    savePersonaSettings(path, {
      // @ts-expect-error testing schema mismatch
      schemaVersion: 999,
      arona: { model: 'gpt-5.5' },
      plana: {},
    });
    expect(loadPersonaSettings(path)).toEqual(EMPTY_SETTINGS);
  });

  it('rejects unknown personas and keys', () => {
    expect(() => validatePersonaName('xenon')).toThrow(
      PersonaSettingsValidationError,
    );
    expect(() => validateSettingKey('temperature')).toThrow(
      PersonaSettingsValidationError,
    );
    expect(validatePersonaName('arona')).toBe('arona');
    expect(validateSettingKey('model')).toBe('model');
  });

  it('coerces values per key with strict validation', () => {
    expect(coerceSettingValue('arona', 'provider', '  codex  ')).toBe('codex');
    expect(coerceSettingValue('plana', 'effort', 'high')).toBe('high');
    expect(coerceSettingValue('arona', 'model', 'claude-opus-4-7')).toBe(
      'claude-opus-4-7',
    );
    expect(coerceSettingValue('arona', 'max_turns', '7')).toBe(7);
    expect(() => coerceSettingValue('arona', 'provider', 'gemini')).toThrow();
    expect(() => coerceSettingValue('arona', 'effort', 'turbo')).toThrow();
    expect(() => coerceSettingValue('arona', 'model', '   ')).toThrow();
    expect(() =>
      coerceSettingValue('arona', 'model', 'has space'),
    ).toThrow();
    expect(() => coerceSettingValue('arona', 'max_turns', '0')).toThrow();
    expect(() => coerceSettingValue('arona', 'max_turns', '500')).toThrow();
    expect(() => coerceSettingValue('arona', 'max_turns', '4.5')).toThrow();
  });

  it('withPersonaSetting returns new records and never mutates the input', () => {
    const before = withPersonaSetting(EMPTY_SETTINGS, 'arona', 'effort', 'high');
    const after = withPersonaSetting(before, 'plana', 'model', 'claude-opus-4-7');
    expect(after.arona).toEqual({ effort: 'high' });
    expect(after.plana).toEqual({ model: 'claude-opus-4-7' });
    expect(before.plana).toEqual({});
  });

  it('withPersonaReset clears only the targeted persona', () => {
    const populated = withPersonaSetting(
      withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.5'),
      'plana',
      'model',
      'claude-opus-4-7',
    );
    const cleared = withPersonaReset(populated, 'arona');
    expect(cleared.arona).toEqual({});
    expect(cleared.plana).toEqual({ model: 'claude-opus-4-7' });
  });
});
