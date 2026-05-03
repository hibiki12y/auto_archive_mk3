---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/insights.py
  - resource/hermes-agent/agent/usage_pricing.py
scope: Hermes Agent Insights Engine 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용. M6의 InsightsEngine 등가물 설계 근거 자료.
---

# Insights Engine

## 1. Purpose & Boundary

`InsightsEngine`은 SQLite SessionDB의 30일치 세션 이력을 분석해 토큰 소비, 비용 추정, 도구/스킬 사용량, 활동 패턴, 모델/플랫폼 분포, 상위 세션을 종합 리포트로 산출한다. Claude Code `/insights`에서 영감을 받아 Hermes 다중 플랫폼 구조(CLI/Discord/Telegram)에 platform breakdown과 비용 추정을 덧붙였다. 본 서브시스템은 **사후 분석 read-only 조회**이며 정상 세션 흐름이나 자동 결정에 관여하지 않는다.

## 2. Source Anchors

| 영역 | Citation |
| --- | --- |
| 모듈 docstring | `resource/hermes-agent/agent/insights.py:1-17` |
| `_estimate_cost` (session/model 양식) | `resource/hermes-agent/agent/insights.py:41-77` |
| `_bar_chart` ASCII 헬퍼 | `resource/hermes-agent/agent/insights.py:85-90` |
| `InsightsEngine.__init__` | `resource/hermes-agent/agent/insights.py:93-109` |
| `generate(days, source)` 진입점 | `resource/hermes-agent/agent/insights.py:111-173` |
| 세션 컬럼 / SQL 쿼리 상수 | `resource/hermes-agent/agent/insights.py:179-197` |
| `_compute_overview` | `resource/hermes-agent/agent/insights.py:411-483` |
| 모델/플랫폼 breakdown | `resource/hermes-agent/agent/insights.py:485-551` |
| `format_terminal` 렌더러 | `resource/hermes-agent/agent/insights.py:726-799` |
| `CanonicalUsage` dataclass | `resource/hermes-agent/agent/usage_pricing.py:28-44` |
| `BillingRoute` / `PricingEntry` / `CostResult` | `resource/hermes-agent/agent/usage_pricing.py:47-76` |
| Official docs 가격 스냅샷 | `resource/hermes-agent/agent/usage_pricing.py:84-150` |
| `CostStatus` / `CostSource` Literal | `resource/hermes-agent/agent/usage_pricing.py:16-25` |

## 3. Architecture Sketch

```
SessionDB (sqlite3) ── SELECT 17개 컬럼 (system_prompt/model_config 제외)
      │
      ▼
InsightsEngine.generate(days=30, source=None)
      │
      ├── _get_sessions / _get_tool_usage / _get_skill_usage / _get_message_stats
      │
      ▼
_compute_overview / model / platform / tool / skill / activity / top_sessions
      │
      ▼
report dict {days, source_filter, empty, generated_at,
             overview, models[], platforms[], tools[],
             skills{summary, top_skills[]}, activity, top_sessions[]}
      │
      ▼
format_terminal(report) → str  (ASCII bar charts via _bar_chart)
```

비용 추정은 별도 모듈 `agent/usage_pricing.py`. 흐름: `_estimate_cost(session) → estimate_usage_cost(model, CanonicalUsage, provider, base_url) → CostResult(amount_usd, status, source)`. status는 `actual / estimated / included / unknown` 4종이며 **모르면 0으로 떨어뜨리지 않고 unknown 마킹**을 유지한다.

## 4. Key Invariants

- 세션 0개면 `empty=True` + 빈 컨테이너로 즉시 반환 — 이후 컴퓨테이션은 비-empty 가정 (`insights.py:130-150`).
- SQL은 클래스 정의 시점 f-string 1회 평가, 사용자 입력은 `?` placeholder 전용 (`insights.py:185-197`).
- 비용 status 4종(`actual`/`estimated`/`included`/`unknown`); 알 수 없는 모델은 0 합산 + 별도 카운터(`unknown_cost_sessions`).
- duration은 `end > start`만 합산 — 시계 드리프트 음수 차단 (`insights.py:444-449`).
- 모델명: 슬래시 있으면 마지막 segment (`insights.py:433`, `:496`).
- 가격 스냅샷은 `pricing_version` 메타 항상 동봉.

## 5. Notable Constants & Defaults

- `days=30`: 기본 lookback (`insights.py:111`).
- `_SESSION_COLS` (`insights.py:180-184`): system_prompt / model_config BLOB 의도적 제외.
- `_bar_chart(values, max_width=20)`: ASCII `█` (`insights.py:85-90`).
- 가격 단위: `Decimal("1000000")` 토큰 당 USD (`usage_pricing.py:14`).
- `_OFFICIAL_DOCS_PRICING` (`usage_pricing.py:84-150`): Anthropic / OpenAI 모델군이 `pricing_version="anthropic-prompt-caching-2026-03-16"` 같은 dated key로 저장.
- `CostSource` Literal 7종: `provider_cost_api` / `provider_generation_api` / `provider_models_api` / `official_docs_snapshot` / `user_override` / `custom_contract` / `none`.
- format_terminal: emoji 박스 헤더 + 56자 구분선 + 상위 15개 도구 컷오프.

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes Insights | auto_archive_mk3 (현재) |
| --- | --- | --- |
| 데이터 소스 | SQLite SessionDB (수십 컬럼) | 분산된 로그/JSONL, 정형 통합 스토어 없음 |
| 진입점 | `InsightsEngine(db).generate(days=30)` | 없음 |
| 출력 형식 | 단일 dict 리포트 + terminal renderer | 없음 |
| 비용 추정 | `CanonicalUsage` + `PricingEntry` + status 4종 | 없음 |
| 가격 스냅샷 | 코드 내 dated dict + provider API 보강 | 없음 |
| 도구/스킬 분해 | 별 테이블 join | 없음 |
| 시간대별 활동 | `_compute_activity_patterns` | 없음 |
| 상위 세션 | "Most tokens / Most tool calls" 류 | 없음 |

## 7. Adoption Notes

**채택 결정: PORT (M6 매핑)**

PORT 시 가져오는 핵심:

- `generate() → dict → render(report)` 분리 — 컴퓨테이션을 dict로 산출하고 사람용/Discord/JSON 렌더는 별도.
- `CanonicalUsage` 토큰 dataclass: input/output/cache_read/cache_write 4채널 + 파생 property.
- `CostResult.status` 4종 — **모르는 가격을 0으로 떨어뜨리지 않는다** 원칙이 PORT의 핵심.
- 가격 스냅샷의 `pricing_version` dated key — 추정 시점 추적.

변형: 데이터 소스는 우리 세션 저장소 형태로, 렌더러는 Discord embed 우선, ASCII bar chart는 보조. Skill 통계는 우선순위 낮음.

연결 spec: `specs/CURRENT/m6-insights-plan.md` (작성 시 본 doc 인용); 가격 dated versioning은 별도 spec 가능.

## 8. Pitfalls / Anti-Patterns Observed

- **actual vs estimated 분리 강제**: status 4종이며 sentinel 0으로 실패를 숨기지 않는다. PORT invariant: "모르면 모른다고 표시, 0으로 더하지 않는다."
- **SQL 사전 평가**: `f"SELECT {_SESSION_COLS} FROM ..."`을 클래스 정의 시점에 한 번 만들어 사용자 입력이 쿼리 구조에 닿지 않게 한다 (`insights.py:185-197`). PORT 시 컬럼 화이트리스트는 코드 시점, 동적 값은 placeholder.
- **무거운 BLOB 컬럼 제외**: `system_prompt`, `model_config`는 select 안 함 — 통계 쿼리가 행 크기로 느려지는 사고 방지.
- **시계 드리프트 가드**: `if start and end and end > start`로 음수 duration 차단 (`insights.py:444-449`).
- **ASCII bar chart 한계**: `_bar_chart`는 80자 초과 환경(Discord embed)에서 깨진다. PORT 시 dict-first / renderer-second 분리 유지.
- **모델명 정규화 분산**: `model.split("/")[-1]`이 두 군데(`insights.py:433`, `:496`). 헬퍼화하면 슬래시 prefix 변형에서 일관성 유지.
- **가격 스냅샷 staleness**: 코드 내 dict는 stale된다. PORT 시 `pricing_version` + `fetched_at` 항상 노출.
