/**
 * Wave 0 baseline — DT Audit Ultra-Team v3.1 산출물.
 *
 * 목적: Wave 0 이후 PR들(/history --talk landed, mid-cycle observer,
 * /escalate, OTel+/feed, rate-throttle chokepoint)의 의존 surface shape를
 * snapshot으로 핀.
 * Wave 0 정리 작업(현재 26 modified + 36 untracked)이 진행되는 동안 이 의존
 * surface가 의도치 않게 drift되면 본 테스트가 즉시 fail해 PR 시작을 막는다.
 *
 * 변경 절차:
 *   1) 의존 surface를 의도적으로 변경하려면 본 파일의 baseline list를 함께 갱신하고
 *      관련 spec(specs/CURRENT/task-health-and-escalation.md 등) 업데이트.
 *   2) baseline 변경은 후속 PR(PR1-PR5)의 가정을 깨뜨릴 수 있으므로
 *      별도 commit + 의존 PR 재검토 필요.
 *
 * 참조: /home/deepsky/.claude/plans/quiet-frolicking-whistle.md (DT Audit v3 plan, G4 gate)
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_EVENT_SCHEMA_VERSION,
  type ControlPlaneEventType,
} from '../src/control/control-plane-ledger.js';
import {
  DISPATCH_LIFECYCLE_PHASES,
  type DispatchLifecyclePhase,
} from '../src/contracts/dispatch-lifecycle.js';
import type {
  AdmissionTrigger,
  AdmissionVerdict,
  ChokepointKind,
} from '../src/contracts/admission-rule.js';

/**
 * 현재 ControlPlaneEventType union의 알려진 멤버 전체.
 * PR3 첫 slice로 escalation.requested가 landed. deferred/acknowledged/resolved
 * 상태 전이를 추가하면 본 list와 컴파일-타임 exhaustiveness check를 함께 갱신한다.
 */
const KNOWN_CONTROL_PLANE_EVENT_TYPES = [
  'conversation.message_observed',
  'conversation.context_selected',
  'task.requested',
  'task.accepted',
  'task.marker_audit_recorded',
  'task.lifecycle_observed',
  'task.health_stalled',
  'task.terminal',
  'task.cancel_requested',
  'task.archived',
  'task.unarchived',
  'task.delivery_observed',
  'approval.requested',
  'approval.resolved',
  'escalation.requested',
  'session.binding_created',
  'session.binding_released',
  'session.focus_changed',
  'session.binding_expired',
  'session.binding_evicted',
  'research.agenda_item_added',
  'research.agenda_item_completed',
  'research.cadence_set',
  'research.mission_draft_created',
  'research.mission_thread_bound',
  'research.mission_approved',
  'research.mission_status_updated',
  'research.evidence_added',
  'research.claim_added',
  'research.claim_supported',
  'research.claim_challenged',
  'research.synthesis_generated',
  'research.proof_linked',
  'steering.submitted',
  'memory.promotion_candidate',
  'memory.promotion_decided',
] as const satisfies readonly ControlPlaneEventType[];

/**
 * 컴파일-타임 exhaustiveness 보호. union에 새 멤버가 추가되는데
 * 위 list가 동기화되지 않으면 typecheck fail (ExhaustiveCheck=never).
 * union이 좁아져도 fail (KNOWN list가 union 밖 멤버 가짐).
 */
type ExhaustiveSetEqual<U, V extends U> =
  [Exclude<U, V>] extends [never]
    ? [Exclude<V, U>] extends [never]
      ? true
      : never
    : never;
const _eventTypesExhaustive: ExhaustiveSetEqual<
  ControlPlaneEventType,
  (typeof KNOWN_CONTROL_PLANE_EVENT_TYPES)[number]
> = true;
void _eventTypesExhaustive;

/** AdmissionTrigger 알려진 5 멤버 — PR5는 절대 이 list 변경 안 함 (ChokepointKind만 widening). */
const KNOWN_ADMISSION_TRIGGERS = [
  'T1_DispatcherEntry',
  'T2_ChokepointCrossing',
  'T3_RetryAttempt',
  'T4_ExplicitReevaluation',
  'T5_ResourceExhaustion',
] as const satisfies readonly AdmissionTrigger[];

const _triggersExhaustive: ExhaustiveSetEqual<
  AdmissionTrigger,
  (typeof KNOWN_ADMISSION_TRIGGERS)[number]
> = true;
void _triggersExhaustive;

/** ChokepointKind 알려진 4 멤버 — PR5에서 'rate-throttle'로 widening (DT Audit v3). */
const KNOWN_CHOKEPOINT_KINDS = [
  'compute-submit',
  'tool-invoke',
  'delivery',
  'rate-throttle',
] as const satisfies readonly ChokepointKind[];

const _chokepointsExhaustive: ExhaustiveSetEqual<
  ChokepointKind,
  (typeof KNOWN_CHOKEPOINT_KINDS)[number]
> = true;
void _chokepointsExhaustive;

/** AdmissionVerdict 알려진 3 멤버. */
const KNOWN_ADMISSION_VERDICTS = [
  'admit',
  'deny',
  'defer',
] as const satisfies readonly AdmissionVerdict[];

const _verdictsExhaustive: ExhaustiveSetEqual<
  AdmissionVerdict,
  (typeof KNOWN_ADMISSION_VERDICTS)[number]
> = true;
void _verdictsExhaustive;

/** DispatchLifecyclePhase 6 멤버 + 순서 — 변경 금지. */
const EXPECTED_DISPATCH_LIFECYCLE_PHASES: readonly DispatchLifecyclePhase[] = [
  'accepted',
  'admission-denied',
  'runtime-entering',
  'runtime-running',
  'settling',
  'terminal',
];

describe('Wave 0 baseline — DT Audit v3 schema-freeze snapshot', () => {
  it('CONTROL_PLANE_EVENT_SCHEMA_VERSION is 1', () => {
    expect(CONTROL_PLANE_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('ControlPlaneEventType has exactly 36 known members', () => {
    expect(KNOWN_CONTROL_PLANE_EVENT_TYPES.length).toBe(36);
  });

  it('all known ControlPlaneEventType members are unique', () => {
    const set = new Set<string>(KNOWN_CONTROL_PLANE_EVENT_TYPES);
    expect(set.size).toBe(KNOWN_CONTROL_PLANE_EVENT_TYPES.length);
  });

  it('AdmissionTrigger has exactly 5 known members in spec order T1-T5', () => {
    expect(KNOWN_ADMISSION_TRIGGERS).toEqual([
      'T1_DispatcherEntry',
      'T2_ChokepointCrossing',
      'T3_RetryAttempt',
      'T4_ExplicitReevaluation',
      'T5_ResourceExhaustion',
    ]);
  });

  it('ChokepointKind has exactly 4 known members (PR5 widened with explicit baseline update)', () => {
    expect(KNOWN_CHOKEPOINT_KINDS).toEqual([
      'compute-submit',
      'tool-invoke',
      'delivery',
      'rate-throttle',
    ]);
  });

  it('AdmissionVerdict has exactly 3 known members', () => {
    expect(KNOWN_ADMISSION_VERDICTS).toEqual(['admit', 'deny', 'defer']);
  });

  it('DISPATCH_LIFECYCLE_PHASES exposes exactly 6 ordered phases', () => {
    expect(DISPATCH_LIFECYCLE_PHASES).toEqual(
      EXPECTED_DISPATCH_LIFECYCLE_PHASES,
    );
    expect(DISPATCH_LIFECYCLE_PHASES.length).toBe(6);
  });
});
