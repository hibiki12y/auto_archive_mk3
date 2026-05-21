/**
 * PR5 — Provider별 inflight rate-throttle counter.
 *
 * Spec: `specs/ARCHIVE/dispatcher-rate-throttle.md`.
 *
 * 책임:
 *   - 두 런타임 provider(`codex`, `claude-agent`)의 active inflight task count 추적.
 *   - lease 객체로 reserve/release 사이클 보장.
 *   - admission-rule이 사용할 `isQuotaAvailable(provider): boolean` 단일 boolean 노출.
 *   - `/doctor` snapshot용 utilization 통계.
 *
 * 비책임:
 *   - admission rule 자체 평가 — `rate-throttle-rule.ts`가 담당.
 *   - dispatcher integration — sub-PR-B에서 처리.
 *   - 큐/circuit breaker — 1차 PR 미포함.
 *
 * 1:1:1 lifecycle 보존: lease는 task scope. dispatcher가 terminal phase에서
 * release 호출 의무. 본 모듈은 task identity를 안 보유 — 카운터만 유지.
 *
 * DT Audit ATTACK-3 가드: snapshot 외부에서 cross-task state 누설 금지.
 * admission rule은 `quotaAvailable: boolean` 한 비트만 metadata 통과.
 */

export type RuntimeProvider = 'codex' | 'claude-agent';

/**
 * Provider별 동시 inflight cap. `-1`은 unlimited (fail-open default).
 *
 * env helper {@link rateThrottleConfigFromEnv}는 다음 변수 사용:
 *   - `AUTO_ARCHIVE_CODEX_MAX_INFLIGHT`
 *   - `AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT`
 *
 * 각 변수는 음이 아닌 정수. 미설정 / 비정수 / 음수 → -1 (unlimited).
 */
export interface RateThrottleConfig {
  readonly codexMaxInflight: number;
  readonly claudeAgentMaxInflight: number;
}

/**
 * lease 객체 — reserve의 반환값. release에 다시 전달.
 *
 * 의도적으로 opaque: caller는 leasedAt 검사하지 않는다 (디버깅/로그 외).
 */
export interface RateLease {
  readonly provider: RuntimeProvider;
  readonly leasedAt: string;
}

export interface RateThrottleSnapshot {
  readonly provider: RuntimeProvider;
  readonly inflight: number;
  /** -1이면 unlimited. */
  readonly limit: number;
  /** 0..100. limit < 0이면 0 고정 (utilization 의미 없음). */
  readonly utilizationPercent: number;
}

export interface RateThrottlePort {
  /**
   * provider quota를 1 차감하고 lease 반환. quota 소진 시 undefined.
   *
   * 호출자(dispatcher)는 undefined 받으면 admission-denied lifecycle phase로
   * dispatch 거부.
   */
  reserve(provider: RuntimeProvider): RateLease | undefined;
  /**
   * lease 반환. counter 1 감소. lease가 잘못되어도 (이중 release 등) silently
   * floor at 0 — 1:1:1 보존을 위해 negative count 허용 안 함.
   */
  release(lease: RateLease): void;
  /**
   * admission-rule이 호출. metadata pre-fetch 용도. side-effect 없음 (counter
   * 변경 X). reserve와 결과가 다를 수 있음 (race) — admission gate evaluate가
   * deterministic snapshot 위에서 동작하도록 caller가 reserve 직전에 호출하면
   * race window 최소화.
   */
  isQuotaAvailable(provider: RuntimeProvider): boolean;
  /**
   * `/doctor` 표시용 read-only snapshot. cross-task state 노출 없음 (총 카운트만).
   */
  snapshot(): readonly RateThrottleSnapshot[];
}

const ALL_PROVIDERS: readonly RuntimeProvider[] = ['codex', 'claude-agent'];

/**
 * env에서 두 cap을 파싱. 비정수 / 음수 / 미설정 → -1 (unlimited).
 */
export function rateThrottleConfigFromEnv(
  env: NodeJS.ProcessEnv,
): RateThrottleConfig {
  const parse = (key: string): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return -1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return -1;
    if (n < 0) return -1;
    return Math.floor(n);
  };
  return {
    codexMaxInflight: parse('AUTO_ARCHIVE_CODEX_MAX_INFLIGHT'),
    claudeAgentMaxInflight: parse('AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT'),
  };
}

export interface RateThrottleOptions {
  readonly clock?: () => Date;
}

export function createRateThrottle(
  config: RateThrottleConfig,
  options: RateThrottleOptions = {},
): RateThrottlePort {
  const inflight = new Map<RuntimeProvider, number>();
  for (const p of ALL_PROVIDERS) {
    inflight.set(p, 0);
  }
  const clock = options.clock ?? ((): Date => new Date());

  const limitOf = (provider: RuntimeProvider): number =>
    provider === 'codex'
      ? config.codexMaxInflight
      : config.claudeAgentMaxInflight;

  const isQuotaAvailable = (provider: RuntimeProvider): boolean => {
    const limit = limitOf(provider);
    if (limit < 0) return true; // unlimited fail-open
    return (inflight.get(provider) ?? 0) < limit;
  };

  return {
    reserve(provider) {
      if (!isQuotaAvailable(provider)) {
        return undefined;
      }
      inflight.set(provider, (inflight.get(provider) ?? 0) + 1);
      return { provider, leasedAt: clock().toISOString() };
    },
    release(lease) {
      const cur = inflight.get(lease.provider) ?? 0;
      if (cur > 0) {
        inflight.set(lease.provider, cur - 1);
      }
    },
    isQuotaAvailable,
    snapshot() {
      return ALL_PROVIDERS.map((provider) => {
        const limit = limitOf(provider);
        const cur = inflight.get(provider) ?? 0;
        const utilizationPercent =
          limit < 0 ? 0 : Math.round((cur / Math.max(limit, 1)) * 100);
        return { provider, inflight: cur, limit, utilizationPercent };
      });
    },
  };
}
