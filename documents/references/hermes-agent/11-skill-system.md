---
status: stable
authority: external-code-reference
last_verified: 2026-05-05
source_paths:
  - resource/hermes-agent/agent/skill_commands.py
  - resource/hermes-agent/agent/skill_utils.py
  - resource/hermes-agent/agent/skill_preprocessing.py
  - resource/hermes-agent/tools/skill_usage.py
  - resource/hermes-agent/tools/skills_hub.py
scope: Hermes Agent skill system (SKILL.md 로드/검색/주입)의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 11 — Skill System

## 1. Purpose & Boundary

Hermes의 skill 시스템은 markdown + YAML frontmatter로 작성한 **재사용 가능한 절차**(`SKILL.md`)를 슬래시 커맨드/자연어로 활성화하는 표면이다. `agent/skill_*`이 frontmatter 파싱·플랫폼 게이팅·템플릿 변수 치환·인라인 셸 확장을 담당하고, `tools/skills_*`이 디스크 인덱싱·텔레메트리·라이프사이클·hub 설치를 책임진다. 본 문서는 **로드 파이프라인과 캐시 친화적 주입 패턴**을 정리한다 — auto_archive_mk3는 **개념 PORT**로 일부만 차용.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| `parse_frontmatter()` (CSafeLoader fallback) | `resource/hermes-agent/agent/skill_utils.py:52-86` |
| `skill_matches_platform()` + `PLATFORM_MAP` | `resource/hermes-agent/agent/skill_utils.py:21-25, 92-115` |
| `EXCLUDED_SKILL_DIRS` | `resource/hermes-agent/agent/skill_utils.py:27` |
| `SKILL_CONFIG_PREFIX` + `resolve_skill_config_values()` | `resource/hermes-agent/agent/skill_utils.py:367-409` |
| Template/inline-shell regex + max output | `resource/hermes-agent/agent/skill_preprocessing.py:13-20` |
| `run_inline_shell()` + `preprocess_skill_content()` | `resource/hermes-agent/agent/skill_preprocessing.py:63-131` |
| `scan_skill_commands()` (인덱싱) | `resource/hermes-agent/agent/skill_commands.py:220-275` |
| `reload_skills()` (cache-preserving rescan) | `resource/hermes-agent/agent/skill_commands.py:287-313` |
| `_build_skill_message()` (USER 메시지) | `resource/hermes-agent/agent/skill_commands.py:112-160` |
| `bump_use` 호출 지점 + 정의 | `resource/hermes-agent/agent/skill_commands.py:399-400`, `tools/skill_usage.py:315-336` |
| 라이프사이클 상태 + `OptionalSkillSource` | `resource/hermes-agent/tools/skill_usage.py:39-42`, `tools/skills_hub.py:2324` |
| URL install / Pinned write block (v0.12.0 #16323/#17562) | `resource/hermes-agent/RELEASE_v0.12.0.md:94, 97` |

## 3. Architecture Sketch

흐름은 4단이다. **(1) 인덱싱**: `scan_skill_commands()`가 `SKILLS_DIR`(`~/.hermes/skills/`) + `skills.external_dirs` + `optional-skills/`(opt-in)을 순회. `EXCLUDED_SKILL_DIRS = {.git, .github, .hub, .archive}` 제외, 각 파일을 `_parse_frontmatter` → `skill_matches_platform` → `_get_disabled_skill_names` 검사 후 슬러그(`[a-z0-9-]+`)로 정규화한 `/<command>` 키를 `_skill_commands` 전역 dict에 적재. **(2) 로드**: `/dogfood` 입력 시 `build_skill_invocation_message()`가 `_load_skill_payload()`를 통해 `skills_tool.skill_view()`로 raw content를 받음. 옵션 frontmatter: `name/description/version/platforms/metadata.hermes.{tags,category,config}` (config는 `skills.config.<key>`에 저장). **(3) 전처리**: `preprocess_skill_content()`가 `${HERMES_SKILL_DIR}`/`${HERMES_SESSION_ID}` 치환, opt-in 시 `!`cmd``을 `bash -c`로 실행해 4000자 cap. 미해소 토큰은 그대로 둔다. **(4) 조립 + 텔레메트리**: `_build_skill_message()`가 activation 안내 + content + `[Skill directory: ...]` + config 값을 단일 문자열로 만들어 **USER role 메시지**로 주입(system이 아님). `bump_use(skill_name)`이 `~/.hermes/skill_usage.json` 카운터 갱신, Curator가 라이프사이클 결정에 활용.

## 4. Key Invariants

1. **Skill = USER 메시지** — system에 넣으면 prompt cache 4 breakpoints가 매 호출마다 무효화. `_build_skill_message()`는 user-role만 반환, `reload_skills()`도 system 캐시 보존 (`skill_commands.py:287-298`).
2. **Frontmatter = YAML 우선 + key:value fallback** — CSafeLoader 실패 시 단순 라인 파서로 자동 전환 (`skill_utils.py:74-84`).
3. **Platform gating prefix 매칭** — `macos`→`darwin` 매핑 후 `current.startswith(mapped)` (`skill_utils.py:113`). 미지정 시 모든 OS.
4. **Inline shell OPT-IN** — `skills.inline_shell: true` 필요, default 비활성, 4000자 cap (`skill_preprocessing.py:128`).
5. **Inline shell 실패 = marker 격리** — bash 미존재/timeout/예외 모두 `[inline-shell error: ...]`로 치환, 한 snippet 실패가 skill 전체 손상 없음 (`skill_preprocessing.py:78-83`).
6. **Slash command 슬러그 `[a-z0-9-]+`** — `+`/`/` 제거로 Telegram BotCommand 호환 (`skill_commands.py:262-264`).
7. **Skill config = `skills.config.<key>` 정형 경로** — logical key 선언, 시스템이 prefix 부착/스트립 (`skill_utils.py:367-370`).
8. **두 표면 분리** — `skills/`(built-in 즉시 활성) vs `optional-skills/`(opt-in heavy, `hermes skills install` 필요) (`skills_hub.py:2324`).
9. **Pinned skill 쓰기 차단** — Curator/skill_manage가 `pinned: true` 미수정 (RELEASE_v0.12.0 §97).

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| `EXCLUDED_SKILL_DIRS` | `{.git, .github, .hub, .archive}` | `skill_utils.py:27` |
| `_INLINE_SHELL_MAX_OUTPUT` | 4000 chars | `skill_preprocessing.py:20` |
| Inline shell timeout | 10초 | `skill_preprocessing.py:129` |
| `SKILL_CONFIG_PREFIX` | `"skills.config"` | `skill_utils.py:370` |
| 라이프사이클 | active/stale/archived | `skill_usage.py:39-42` |
| 텔레메트리 카운터 | view_count/use_count/patch_count | `skill_usage.py:315-336` |
| Built-in 카테고리 | 25개 (apple/dogfood/email/gaming/gifs/github/mcp/media/...) |
| Optional 카테고리 | 16개 (blockchain/communication/health/migration/security/...) |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 정의 단위 | SKILL.md (md + YAML) | trait module / plana plugin |
| 로드 시점 | 슬래시 커맨드 lazy | trait 등록 즉시 |
| 주입 위치 | USER 메시지 | 동일 채택 권고 (M3) |
| OS 게이팅 | `platforms` frontmatter | 단일 OS 가정 |
| 인라인 셸 | opt-in 4000자 cap | **미채택** — 보안 위험 |
| 라이프사이클 | active/stale/archived | Curator 미구현 (M2) |
| 텔레메트리 | bump_use/view/patch JSON | `skillBumpUse` hook + `InMemoryTraitUsageTelemetry` sidecar + optional `/traits` use-count view + Discord service/smoke in-process wiring; view_count/patch_count counters는 미채택 |
| Hub 설치 | GitHub/URL/optional | **SKIP** — 단일 카탈로그 |

## 7. Adoption Notes

**PORT (개념) — M2 일부.** 5개 사상 차용: (1) **USER 메시지 주입** — system 갱신 금지로 prompt cache invariant(`05-...`) 보호, (2) **선언적 config + 정형 prefix** — `metadata.hermes.config ↔ skills.config.<key>` 패턴 매핑 (M2/M3), (3) **라이프사이클 ACTIVE/STALE/ARCHIVED** — `archive`만 사용, `delete`는 사용자 명시 명령에만, (4) **Pinned write-block** — 사용자 pin은 curator 미수정 (RELEASE_v0.12.0 §97), (5) **사용 텔레메트리** — Hermes `bump_use` JSON counter를 직접 파일로 복제하지 않고 `skillBumpUse` observe hook과 `InMemoryTraitUsageTelemetry` sidecar로 노출하며, Discord `/traits`는 sidecar가 주입된 경우 use_count/latest task를 read-only로 표시한다. Discord smoke 및 service의 `current-node`/`git-clone` in-process 경로는 동일 sidecar를 runtime hook과 `/traits`에 공유한다. 기본 host wiring은 built-in methodology TraitModule을 관측하며, 추가 TraitModule은 별도 hook binding을 명시적으로 붙인다. 기본 `slurm-apptainer` service 경로는 별도 컨테이너 프로세스라 host 메모리 sidecar와 공유되지 않으며, durable store/IPC가 추가되기 전까지는 의도적 잔여 한계다.

미채택: **인라인 셸 확장**(`!`cmd``)은 보안/감사 비용 → SKIP, **Hub URL install**은 단일 사용자 환경에 과도 → SKIP, **`external_dirs` 자동 스캔**도 단일 카탈로그로 단순화. 인접: `01-curator-self-improvement.md`, `05-prompt-caching-strategy.md`.

## 8. Pitfalls / Anti-Patterns Observed

- **System prompt 주입** — 4 breakpoints 전부 무효화 → prefix 전체 재청구. user-role만 사용 (`skill_commands.py:294-298`).
- **Inline shell 미bound** — `find /` 한 줄로 컨텍스트 폭발. 4000자 cap + timeout 둘 다 필수 (`skill_preprocessing.py:88-89`).
- **슬러그 미정규화** — 공백/언더스코어/특수문자가 Telegram BotCommand/ACP AvailableCommand 광고를 깬다. `[a-z0-9-]+` 강제 (`skill_commands.py:262-264`).
- **YAML 파서 단일 의존** — CSafeLoader 미설치 + fallback 없으면 silent 실패. lazy import + SafeLoader fallback (`skill_utils.py:38-46`).
- **Hub URL install 무검증** — quarantine + 스캔 없이 verbatim install 시 임의 코드 실행 (`skills_hub.py:79`).
- **OS 게이팅 strict 비교** — `sys.platform == "macos"`는 항상 false (실제 "darwin"). `PLATFORM_MAP` + prefix 일치 (`skill_utils.py:113`).
- **Reload가 cache 무효화** — `/reload-skills`가 system 재생성 시 prefix 깨짐. dict만 갱신 (`skill_commands.py:294-298`).
- **disabled 검사 사후 적용** — 인덱싱 단계에서 즉시 skip해야 안전 (`skill_commands.py:248-250`).
