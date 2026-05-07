/**
 * Surface-tag audit — DT Audit Ultra-Team v3.1 NF-2 가드.
 *
 * 목적:
 *   COMMAND_REGISTRY는 ACP(Agent Client Protocol) 슬래시 커맨드 표면의 단일 source.
 *   `surfaceTags === undefined`는 default-permissive — 모든 surface 노출.
 *   PR3 `/escalate`, PR4b `/feed`처럼 운영 권한이 Discord-only로 제한되어야 하는
 *   신규 커맨드는 explicit `surfaceTags: ['discord']` 누락 시 ACP에 자동 누출되어
 *   `discord-access-policy` 게이팅을 우회한다.
 *
 *   본 테스트는:
 *     1) 현재 시점 baseline(21개 default-permissive command)을 핀.
 *     2) 신규 명령이 추가되면 EXPECTED_DISCORD_ONLY_COMMANDS에 명시되거나
 *        baseline list에 명시 추가되어야 통과 — 자동 ACP 노출을 방지.
 *
 * 참조: /home/deepsky/.claude/plans/quiet-frolicking-whistle.md (DT Audit v3 plan, G5 gate)
 *      DT Audit Phase 4 NF-2 (Gemini stress test)
 *      src/discord/discord-command-registry.ts:381-384 (default-permissive 동작)
 *      src/acp/acp-slash-commands.ts (COMMAND_REGISTRY filter consumer)
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  type DiscordCommandDef,
  type DiscordFirstSliceCommandName,
} from '../src/discord/discord-command-registry.js';

/**
 * 현재 시점 baseline: 21 commands는 default-permissive(surfaceTags unset)이다.
 * `/escalate`처럼 Discord-only로 landed 된 command는 별도 set에서 핀다.
 *
 * 신규 명령 추가 시 두 옵션 중 하나:
 *   (A) Discord 전용이 자연스러운 경우(escalate/feed 등) — EXPECTED_DISCORD_ONLY_COMMANDS에 추가.
 *   (B) 양쪽 surface 노출이 의도된 경우(ask/research 같은 task 명령) — 본 list에 추가.
 *
 * 절대 금지:
 *   - 새 명령을 surfaceTags unset으로 두고 본 list 바깥에 방치 (자동 ACP 누출).
 */
const KNOWN_DEFAULT_PERMISSIVE_COMMANDS: ReadonlySet<DiscordFirstSliceCommandName> =
  new Set([
    'ask',
    'research',
    'status',
    'cancel',
    'rerun',
    'archive',
    'unarchive',
    'tasks',
    'traits',
    'agenda',
    'history',
    'context',
    'approve',
    'deny',
    'doctor',
    'subagents',
    'focus',
    'unfocus',
    'auth',
    'config',
    'insights',
    'help',
  ]);

/**
 * Discord-only이어야 할 명령 (PR3·PR4b 등 future).
 * 각 명령은 등록 시 explicit `surfaceTags: ['discord']`를 가져야 한다.
 *
 * 신규 추가 절차:
 *   1) PR에서 본 set에 명령 이름 추가.
 *   2) discord-command-registry.ts에 surfaceTags: ['discord'] 명시 등록.
 *   3) 별도 isolation 테스트(tests/acp-slash-commands.surface-isolation.spec.ts)에서
 *      ACP availableCommands에 미노출 회귀 검증.
 */
const EXPECTED_DISCORD_ONLY_COMMANDS: ReadonlySet<string> = new Set<string>([
  'escalate',
  'feed',
]);

describe('Discord COMMAND_REGISTRY surface-tag audit (DT Audit v3 G5)', () => {
  it('exposes exactly the known default-permissive and Discord-only commands', () => {
    expect(COMMAND_REGISTRY.length).toBe(
      KNOWN_DEFAULT_PERMISSIVE_COMMANDS.size +
        EXPECTED_DISCORD_ONLY_COMMANDS.size,
    );
  });

  it('every registered command is classified — default-permissive baseline OR explicit Discord-only', () => {
    for (const cmd of COMMAND_REGISTRY) {
      const inBaseline = KNOWN_DEFAULT_PERMISSIVE_COMMANDS.has(cmd.name);
      const inDiscordOnly = EXPECTED_DISCORD_ONLY_COMMANDS.has(cmd.name);
      expect(
        inBaseline || inDiscordOnly,
        `Command "${cmd.name}" not classified. Add to KNOWN_DEFAULT_PERMISSIVE_COMMANDS (both surfaces) or EXPECTED_DISCORD_ONLY_COMMANDS (Discord only).`,
      ).toBe(true);
    }
  });

  it('every Discord-only expected command has explicit surfaceTags=[discord]', () => {
    const registeredNames = new Set(COMMAND_REGISTRY.map((cmd) => cmd.name));
    for (const name of EXPECTED_DISCORD_ONLY_COMMANDS) {
      expect(registeredNames.has(name as DiscordFirstSliceCommandName), name).toBe(
        true,
      );
    }
    for (const cmd of COMMAND_REGISTRY) {
      if (!EXPECTED_DISCORD_ONLY_COMMANDS.has(cmd.name)) {
        continue;
      }
      expect(
        cmd.surfaceTags,
        `Command "${cmd.name}" is in EXPECTED_DISCORD_ONLY_COMMANDS but surfaceTags is unset (default-permissive ACP leak).`,
      ).toBeDefined();
      expect(cmd.surfaceTags).toEqual(['discord']);
    }
  });

  it('every default-permissive baseline command has surfaceTags unset (historical posture)', () => {
    for (const cmd of COMMAND_REGISTRY) {
      if (!KNOWN_DEFAULT_PERMISSIVE_COMMANDS.has(cmd.name)) {
        continue;
      }
      expect(
        cmd.surfaceTags,
        `Command "${cmd.name}" baseline expected default-permissive (surfaceTags unset). To restrict, also remove from KNOWN_DEFAULT_PERMISSIVE_COMMANDS.`,
      ).toBeUndefined();
    }
  });

  it('command names are unique', () => {
    const names = COMMAND_REGISTRY.map((cmd: DiscordCommandDef) => cmd.name);
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });
});
