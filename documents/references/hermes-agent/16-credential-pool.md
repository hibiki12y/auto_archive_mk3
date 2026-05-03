---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/credential_pool.py
  - resource/hermes-agent/agent/credential_sources.py
scope: Hermes Agent Credential Pool / Sources 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용. 단일 provider bootstrap 환경이라 SKIP 결정.
---

# Credential Pool + Sources

## 1. Purpose & Boundary

`agent/credential_pool.py`는 동일 provider의 여러 인증 키를 보관하고 rate-limit/quota 발생 시 자동 failover하는 영구화된 풀이다. `agent/credential_sources.py`는 풀을 채우는 9종 소스(env/claude_code/hermes_pkce/device_code/qwen-cli/gh_cli/config/model_config/manual)의 **통합 제거(removal) 계약**을 정의한다. 다중 키 운영(여러 OpenAI 키, Codex 5h-quota burn, Copilot gh_cli 경유 등)에서만 가치가 있는 인프라 layer다.

## 2. Source Anchors

| 영역 | Citation |
| --- | --- |
| Status / auth_type / strategy 상수 | `resource/hermes-agent/agent/credential_pool.py:48-67` |
| Exhaustion TTL (1h for 429/402) | `resource/hermes-agent/agent/credential_pool.py:69-73` |
| `CUSTOM_POOL_PREFIX` "custom:" | `resource/hermes-agent/agent/credential_pool.py:75-78` |
| `PooledCredential` dataclass | `resource/hermes-agent/agent/credential_pool.py:89-117` |
| `from_dict` / `to_dict` 직렬화 | `resource/hermes-agent/agent/credential_pool.py:124-157` |
| `_exhausted_ttl` 분기 | `resource/hermes-agent/agent/credential_pool.py:190-194` |
| `_normalize_error_context` | `resource/hermes-agent/agent/credential_pool.py:240-262` |
| `_exhausted_until` (reset_at 우선) | `resource/hermes-agent/agent/credential_pool.py:265-273` |
| `get_pool_strategy(provider)` | `resource/hermes-agent/agent/credential_pool.py:344-357` |
| `CredentialPool.select` | `resource/hermes-agent/agent/credential_pool.py:819-930` |
| `mark_exhausted_and_rotate` | `resource/hermes-agent/agent/credential_pool.py:933-954` |
| `acquire_lease` / `release_lease` | `resource/hermes-agent/agent/credential_pool.py:956-1010` |
| credential_sources 모듈 docstring | `resource/hermes-agent/agent/credential_sources.py:1-44` |
| `RemovalResult` / `RemovalStep` | `resource/hermes-agent/agent/credential_sources.py:53-110` |
| `find_removal_step` 디스패처 | `resource/hermes-agent/agent/credential_sources.py:120-132` |
| `_remove_env_source` 구현 | `resource/hermes-agent/agent/credential_sources.py:143-191` |
| `_remove_claude_code` (suppress only) | `resource/hermes-agent/agent/credential_sources.py:194-204` |
| `_remove_hermes_pkce` (delete OAuth file) | `resource/hermes-agent/agent/credential_sources.py:207-219` |
| `_remove_codex_device_code` (dual-source) | `resource/hermes-agent/agent/credential_sources.py:268-299` |

## 3. Architecture Sketch

```
~/.hermes/auth.json  (canonical, _auth_store_lock)
   providers / credential_pool / suppress[(provider, source_id)]
        ▲                                ▲
        │ load_pool()         _seed_from_*  (9 sources)
        ▼                                │
CredentialPool(provider, entries)        │
    select() → strategy:                 │
      fill_first / round_robin /         │
      random / least_used                │
    acquire_lease(id) → HTTP call → release_lease(id)
        │                                │
        └─ on 429/402: mark_exhausted_and_rotate
           (last_status=EXHAUSTED, last_error_reset_at, TTL=1h)
                                         │
hermes auth remove <provider> <N>        │
    find_removal_step(provider, source) ─┘
    step.remove_fn() → RemovalResult{cleaned[], hints[], suppress}
    suppress_credential_source(provider, source_id)  ← 재 seed 차단
```

`PooledCredential` 단일 dataclass가 OAuth와 API key를 모두 담는다(`access_token`, `refresh_token`, `expires_at_ms`, `agent_key`). 풀은 provider별 1개이며, custom provider는 `custom:<normalized_name>` prefix로 키 분리.

## 4. Key Invariants

- **Exhaustion은 영구 차단이 아닌 cooldown**: 429/402 1h TTL, provider reset_at 헤더가 있으면 우선 (`credential_pool.py:265-273`).
- **단일-사용 refresh token 동기화**: claude_code, device_code 소스는 외부 프로세스가 파일을 갱신할 수 있다 가정. `select` 직전 sync path 항상 거침 (`credential_pool.py:421-519`).
- **Removal contract 통일**: 모든 source가 `RemovalStep.remove_fn → RemovalResult` 한 형태. 신규 소스는 `_seed_from_*` + `RemovalStep` register 둘만으로 끝.
- **Suppress vs Delete 분리**: 외부 도구 owner 파일(claude_code, qwen-cli)은 **suppress만**, hermes owner(hermes_pkce OAuth)만 delete.
- **Codex dual-source 함정**: openai-codex device_code는 ~/.codex/auth.json에서 다시 시드되므로 suppress key를 `device_code`로 박는다 (`credential_sources.py:268-299`).

## 5. Notable Constants & Defaults

- 상태/타입: `STATUS_OK="ok"` / `STATUS_EXHAUSTED="exhausted"` / `AUTH_TYPE_OAUTH` / `AUTH_TYPE_API_KEY` (`credential_pool.py:50-54`).
- 4 selection strategies: `fill_first`(기본, priority 순) / `round_robin` / `random` / `least_used` (`credential_pool.py:58-67`).
- `EXHAUSTED_TTL_429_SECONDS = EXHAUSTED_TTL_DEFAULT_SECONDS = 3600` (`credential_pool.py:72-73`).
- `CUSTOM_POOL_PREFIX = "custom:"`, `DEFAULT_MAX_CONCURRENT_PER_CREDENTIAL = 1`.
- `_EXTRA_KEYS`: JSON-only round-trip 필드 frozenset (`credential_pool.py:82-86`).
- 9 credential 소스: env / claude_code / hermes_pkce / device_code / qwen-cli / gh_cli / config / model_config / manual (`credential_sources.py:5-13`).

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| Provider 다중성 | 16+ providers, 24+ env var | 단일 codex bootstrap |
| 키 다중성 | provider당 N개 | provider당 1 |
| Failover | 자동 rotate (429/402) | 사용자 안내만 |
| OAuth flow | claude_code/hermes_pkce/device_code/minimax/qwen | codex만 |
| 외부 도구 통합 | gh_cli, qwen-cli, claude_code 파일 공유 | 없음 |
| Removal 계약 | `RemovalStep` 통합 | 단일 위치 cleanup |
| Cooldown TTL | 1h + reset_at override | 없음 |
| 동시성 제어 | `acquire_lease`/`release_lease` | 없음 |

## 7. Adoption Notes

**채택 결정: SKIP**

이유:

- 단일 codex bootstrap, 단일 키 환경이라 풀이 1-element가 되어 Hermes 풀의 모든 가치(rotate, lease, exhaustion TTL, dual-source sync)가 0이 된다.
- ~2K LOC가 thin wrapper 1개를 위해 끌려오는 비용 대비 효익 음수. M-item 없음.

향후 PORT 정당화 시 가져올 핵심: `RemovalStep → RemovalResult` 통합 계약, 1h cooldown + provider-supplied reset_at 우선, 외부 도구 owned 파일은 **삭제 대신 suppress**, single-use refresh token race를 sync로 해결하는 패턴.

연결 spec/문서: 없음.

## 8. Pitfalls / Anti-Patterns Observed

- **External-tool owned 파일 삭제 금지**: claude_code, qwen-cli, gh_cli처럼 다른 CLI가 owner인 자격 파일을 지우면 사용자의 다른 도구도 망가진다. Hermes는 **suppress만** (`credential_sources.py:194-204, 302-312`).
- **Silent suppression 디버깅 지옥**: suppress 후 사용자가 외부 도구로 다시 OAuth하면 파일은 갱신되지만 hermes는 무시한다. "왜 안 잡히나" hint 메시지(`credential_sources.py:295-298`) 필수.
- **reset_at 파싱 사고 → 영구 차단**: ms vs s 혼동으로 reset_at이 거대한 값이 되면 키가 사실상 영구 차단. `_parse_absolute_timestamp`(`credential_pool.py:197-224`)가 `numeric > 1_000_000_000_000`로 ms 판정 + ISO-8601도 처리.
- **Dual-source 망각**: openai-codex가 hermes auth.json + ~/.codex/auth.json 두 곳에 산다는 것을 모르고 한쪽만 cleanup하면 다음 load에서 부활. 신규 소스는 "어디 어디에 사는가"를 먼저 mapping.
- **Single-use refresh token race**: 여러 프로세스가 같은 자격을 쓰면 refresh token이 한 번만 유효해 한쪽이 stale. `_sync_*_from_*`가 select 직전 외부 파일 재로드로 race 처리.
- **Lease 누수**: `acquire_lease` / `release_lease`를 try/finally로 안 감싸면 카운터 누수로 멀쩡한 키도 concurrent limit으로 막힌다.
