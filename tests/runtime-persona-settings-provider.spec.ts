import { describe, expect, it } from 'vitest';

import {
  CompositeRuntimePersonaSettingsProvider,
  FileBackedRuntimePersonaSettingsProvider,
  InMemoryRuntimePersonaSettingsProvider,
} from '../src/runtime/runtime-persona-settings-provider.js';
import {
  EMPTY_SETTINGS,
  withPersonaSetting,
} from '../src/discord/persona-settings-store.js';

describe('InMemoryRuntimePersonaSettingsProvider', () => {
  it('starts empty when no initial record is provided', () => {
    const provider = new InMemoryRuntimePersonaSettingsProvider();
    expect(provider.readSettings('arona')).toEqual({});
    expect(provider.readSettings('plana')).toEqual({});
  });

  it('projects model/effort/maxTurns from the record into the runtime shape', () => {
    const record = withPersonaSetting(
      withPersonaSetting(
        withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.5'),
        'arona',
        'effort',
        'high',
      ),
      'plana',
      'max_turns',
      7,
    );
    const provider = new InMemoryRuntimePersonaSettingsProvider(record);
    expect(provider.readSettings('arona')).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(provider.readSettings('plana')).toEqual({ maxTurns: 7 });
  });

  it('apply() replaces the snapshot — subsequent reads see the new values', () => {
    const provider = new InMemoryRuntimePersonaSettingsProvider();
    provider.apply(
      withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.5'),
    );
    expect(provider.readSettings('arona')).toEqual({ model: 'gpt-5.5' });
    provider.apply(
      withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.4'),
    );
    expect(provider.readSettings('arona')).toEqual({ model: 'gpt-5.4' });
    provider.apply(EMPTY_SETTINGS);
    expect(provider.readSettings('arona')).toEqual({});
  });
});

describe('FileBackedRuntimePersonaSettingsProvider', () => {
  it('returns {} when the loader throws', () => {
    const provider = new FileBackedRuntimePersonaSettingsProvider(
      '/nonexistent.json',
      () => {
        throw new Error('boom');
      },
    );
    expect(provider.readSettings('arona')).toEqual({});
  });

  it('re-reads on every call so out-of-process writers are visible', () => {
    let counter = 0;
    const provider = new FileBackedRuntimePersonaSettingsProvider(
      '/anywhere.json',
      () => {
        counter += 1;
        return withPersonaSetting(
          EMPTY_SETTINGS,
          'arona',
          'model',
          `gpt-5.${counter}`,
        );
      },
    );
    expect(provider.readSettings('arona')).toEqual({ model: 'gpt-5.1' });
    expect(provider.readSettings('arona')).toEqual({ model: 'gpt-5.2' });
  });
});

describe('CompositeRuntimePersonaSettingsProvider', () => {
  it('prefers primary values; falls back to secondary on a per-field basis', () => {
    const primary = new InMemoryRuntimePersonaSettingsProvider(
      withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.5'),
    );
    const secondary = new InMemoryRuntimePersonaSettingsProvider(
      withPersonaSetting(
        withPersonaSetting(EMPTY_SETTINGS, 'arona', 'model', 'gpt-5.4'),
        'arona',
        'effort',
        'medium',
      ),
    );
    const composite = new CompositeRuntimePersonaSettingsProvider(
      primary,
      secondary,
    );
    expect(composite.readSettings('arona')).toEqual({
      model: 'gpt-5.5',
      effort: 'medium',
    });
  });
});
