---
status: active
authority: implementation-spec
last_verified: 2026-05-06
source_paths:
  - src/discord/discord-session-log-thread-router.ts
  - src/discord/discord-command-handlers.ts
  - src/discord/discord-bot.ts
  - src/discord/discord-service-bootstrap.ts
scope: job 할당 후 lifecycle 메시지를 채팅 채널이 아닌 세션 로그 부모 채널의 새 스레드로 라우팅하는 동작 명세.
---

# 스펙: Discord 세션 로그 스레드 라우팅

## 사용 시점

`/ask`, `/research`, 자연어 멘션 등으로 Job이 수락된 직후, 같은 채팅 채널에서
계속해서 lifecycle 메시지(`Accepted`, `running-update`, `terminal-result`,
`status-reply` 등)를 누적하는 대신, 미리 지정된 **세션 로그 부모 채널** 아래
**Job 단위로 새 스레드**를 만들어 그곳에서 이어가도록 한다. 부모 채널은
일반 텍스트 채널(`GUILD_TEXT`)이며, 필요시 forum 채널을 동일 인터페이스로
공급할 수 있도록 라우터는 채널 타입에 의존하지 않는다.

## 결정

- 라우팅은 옵트인이다. `AUTO_ARCHIVE_DISCORD_SESSION_LOG_PARENT_CHANNEL_ID`가
  비어 있거나 미설정이면 기존 동작을 100% 유지한다.
- 환경 변수가 설정되면 그 값은 봇이 thread를 생성할 수 있는 텍스트 채널 ID여야
  한다. 같은 인터페이스로 forum 채널 어댑터를 끼워 넣을 수도 있으나 표준
  운영 모델은 텍스트 채널 + thread-per-Task다.
- 초기 응답(`Accepted`, `editReply`)은 여전히 원본 채팅 채널/interaction 으로
  나간다. 이 메시지는 사용자에게 즉시 가시적이어야 하며, 사용자가 Job 진행
  상황을 어디서 볼 수 있는지를 안내하는 thread mention(또는 `채널 / 스레드:`
  스타일 보조 라인)을 포함할 수 있다.
- 모든 후속 메시지(`followUp`)는 새 스레드로 라우팅한다. 같은 Task ID에
  대한 첫 후속 호출 시점에 스레드가 lazy 하게 생성된다 — 텍스트 채널의
  `threads.create({ name })`는 시작 메시지를 요구하지 않으며, 첫 후속 payload는
  thread 생성 직후 별도의 `thread.send(payload)`로 보낸다.
- 스레드 이름은 `Task ${taskId}` (또는 짧은 instruction 접두사 + taskId
  마지막 12자) 형태로 표준화한다. 운영자 제공 prefix는 상수로 시작.
- 스레드 → Task 매핑은 in-process Map. 프로세스 재기동 시점에는 사라지지만
  Discord 측 스레드 자체는 유지되며, 같은 Task ID로 다시 followUp이 들어오면
  새 스레드가 만들어진다(중복 스레드 가능). 이는 명시적 trade-off이며
  retention 정책은 §의 평가 메모를 따른다.

## 라우팅 표면

`DiscordSessionLogThreadRouter` 포트:

```ts
interface DiscordSessionLogThreadRouter {
  routeFollowUp(input: {
    taskId: string;
    payload: DiscordMessagePayload;
    eventType?: DiscordDeliveryEventType;
  }): Promise<{
    delivered: 'thread' | 'channel-fallback';
    threadId?: string;
    fallbackReason?: string;
  }>;
}
```

- `delivered: 'thread'`: 정상적으로 thread로 보낸 경우.
- `delivered: 'channel-fallback'`: thread 생성 / 송신 실패시 caller가 원본
  channel followUp으로 fail-open. 운영자에게는 단일 메시지 누락이 thread
  일관성보다 더 큰 사고이기 때문이다.

`DefaultDiscordSessionLogThreadRouter` 기본 구현:
- 첫 호출 시 resolver를 통해 부모 채널 핸들을 가져오고
  `parent.threads.create({ name, autoArchiveDurationMinutes })`로 빈 thread를
  만든 뒤 첫 followUp payload를 `thread.send(payload)`로 보낸다.
- 결과 Promise를 Map<taskId, Promise<thread>>에 캐시. 두 번째부터는 캐시된
  thread에 직접 `thread.send(payload)`.
- discord.js 에러는 caller에게 throw하지 않고 `'channel-fallback'`을
  반환해 fail-open한다. thread 생성 실패는 캐시를 비우고 다음 호출에 재시도
  가능하게 한다.

## 호출 지점

`DiscordCommandHandlers.deliver()`의 executor lambda:

```ts
if (req.operation === 'editReply') {
  await interaction.editReply(req.payload);
} else {
  const router = this.options.sessionLogThreadRouter;
  const taskId = req.context?.taskId;
  if (router && taskId) {
    const result = await router.routeFollowUp({
      taskId,
      payload: req.payload,
      eventType: req.context?.eventType,
    });
    if (result.delivered === 'thread') {
      return;
    }
  }
  await interaction.followUp(req.payload);
}
```

해당 분기점은 모든 lifecycle followUp(`running-update`, `terminal-result`,
`status-reply`, `cancel-ack`, …)을 단일 위치에서 가로채므로 추가 분산 변경
포인트가 없다. `editReply`(initial-accept)는 영향받지 않는다.

## 구성

- `AUTO_ARCHIVE_DISCORD_SESSION_LOG_PARENT_CHANNEL_ID`: 세션 로그 부모 채널 ID.
  빈 문자열이면 비활성화(라우터 미생성).
- 추가 구성은 두지 않는다. 스레드 이름 규칙과 자동 archive 기간(기본 1440분)은
  코드 상수로 고정하여 운영 매뉴얼 변경을 줄인다.

## 보안 / 권한

- 봇 토큰의 권한이 부모 채널에 thread 생성 + send 가능해야 한다.
  사전 확인은 `core:stack:health` Doctor flow로 추가 검사 가능하나, 이번
  변경에서는 fail-open 처리만 보장한다.
- 부모 채널 ID 검증: 잘못된 ID(또는 thread 생성을 지원하지 않는 type)인
  경우 첫 followUp에서 channel-fallback이 발생하고 운영자 로그에 분류된 에러가
  남는다. 이 경계는 명시적 사양이다.

## 운영자 영향

- 기존 채팅 채널은 Job 수락 사실 + thread 링크만 받는다(또는 Accepted
  payload 단일 메시지만).
- 모든 후속 lifecycle/observability 메시지는 thread로 이동한다.
  archive/검색은 부모 채널의 thread 목록 + 검색 기능 이용.
- `runtime-state/discord-dlq.jsonl`의 `context.channelId`는 송신 실패시
  여전히 원본 channel ID를 가지며, thread route 실패는 별도 로그로 구분
  로깅(`route=thread-fallback`).

## 트레이드오프 평가 (Forum vs Thread)

본 스펙은 **텍스트 채널 + thread per Job**을 표준으로 채택하고, 동일 인터페이스
(`DiscordSessionLogThreadRouter`)에 forum 어댑터를 끼우는 가능성을 열어 둔다.

| axis | Plain text + thread (default) | Forum + thread |
| --- | --- | --- |
| 발견성 | 채널 사이드바 "Threads" 메뉴 / "Active Threads" 빠르게 도달 | 포럼 첫 페이지에서 task 단위 sort/filter |
| Tag/Sort | thread 메타 + name prefix 정렬 | 포럼 tag, pinned, sort by latest |
| 검색 | 채널 검색이 thread 본문도 노출 | 포럼 channel-scoped 검색 자연 |
| 모바일 UX | 채널에서 thread 진입 1단계 | 포럼 view가 첫 메시지 + 메타 우선 노출 |
| 권한 모델 | 채널 권한이 thread에 자동 상속 | 포럼 channel 단위 권한 — 운영자 일괄 통제 |
| 링크 공유 | thread URL 안정 | thread URL 동일하나 발견성 더 높음 |
| 보존/Archive | thread auto-archive 후 사이드바에서 사라지나 검색은 가능 | 포럼은 archived posts를 별도 보존 표면으로 |
| REST 관찰성 | thread 리스트 API 동일 | thread 리스트 + forum 메타 |
| 알림 정책 | 채널 알림에 thread 알림이 묶임 | follow-by-default 옵션 사용자별 제어 |
| 운영 부담 | 추가 인프라 불필요, 기존 채널 사용 | 포럼 채널 1개 신설 + 권한 셋업 |
| 라우터 변경 | 표준 — `parent.threads.create({ name })` | 어댑터 — `parent.threads.create({ name, message })` |

권고: **텍스트 채널 + per-Job thread**. forum의 발견성/태그 이점은 매력적이나
운영 시 추가 인프라가 필요하고, thread-per-Job 모델은 텍스트 채널만으로도
신호:잡음 분리, 검색, 보존 측면에서 충분히 동작한다. forum 도입은 운영자가
forum 채널을 별도로 신설할 의지를 가지는 경우에만 어댑터로 합류한다.

## 평가 메모: 스레드 적재 패턴 (Task 3 결론)

같은 부모 채널 안에서도 세 가지 적재 패턴이 가능하다.

1. **single thread reply chain**: 모든 Job을 단일 thread에 누적.
2. **per-Job thread** (현재 채택): Job 하나 = thread 하나. 본 스펙의 default.
3. **per-batch thread**: 운영자가 정의한 묶음(예: 일자별, 채널별) 단위로
   thread 1개. 그 안에 여러 Job 메시지를 누적.

| axis | 1) single thread chain | 2) per-Job thread (default) | 3) per-batch thread |
| --- | --- | --- | --- |
| 신호:잡음 비율 | 한 thread 안에 여러 Job 섞임 → 낮음 | Job 1개에 lifecycle 메시지만 → 높음 | batch 내부에서는 일관 — 단, 동시 Job이 많으면 인터리브 발생 |
| 검색/링크 | thread URL 1개로 끝 — 특정 Job 찾기 어려움 | thread name이 task ID라 즉시 jump | batch 식별자로 navigate 후 task 검색 |
| 알림 부담 | 모든 follower가 모든 Job 알림 수신 → 노이즈 | 본인 관심 Job thread만 follow | 제한된 batch 단위 follow |
| Discord 한도 | 단일 thread 메시지 누적 → 페이지네이션 부담 | thread당 메시지 수 적어 페이지네이션 자연 | 1)과 2)의 중간 |
| 보존 정책 | 단일 thread archived 시 모든 Job 동시 영향 | Job 별 archive/태깅 — fine-grained | batch archive로 일괄 처리 가능 |
| 운영자 인지 부담 | 가장 단순(URL 하나) | 중간(thread 인덱스 사용) | 운영자 batch 정책 정의 필요 |
| 구현 부담 | 가장 작음 (router 단일 thread cache) | 작음 (Map<taskId, thread>) | batch 키 생성/만료 정책 필요 |
| Discord REST 비용 | 가장 적음 — 첫 thread 1회 생성 | 평이 — Job마다 1회 생성 | batch 첫 메시지마다 1회 |
| 동시 Job 분리 | 없음 — Job 내용 재구성 어려움 | 자연 — 각 thread 독립 | 부분적 — thread 안 인터리브 가능 |
| 병행성 (lifecycle 빠른 fan-out) | thread 락/순서 보장 X — 메시지 인터리브 위험 | thread 단위로 직렬화 — 자연 | batch 안에서 인터리브 위험 |

### 결론 (Task 3 답)

**(2) per-Job thread**가 운영 편의성이 가장 높다.

- 핵심 근거: Job 단위로 메시지가 분리되므로 (i) 검색/링크 공유, (ii) 보존
  정책, (iii) 동시 Job 분리, (iv) name prefix 활용이 모두 단일 차원 — task ID — 으로
  깨끗하게 정렬된다.
- (1) single thread chain 은 가장 적은 구현 부담을 갖지만 신호:잡음 비율이
  급격히 악화된다. 운영자가 "방금 끝난 task X의 lifecycle 어디서 봐?"에
  대해 thread를 스크롤해야 한다.
- (3) per-batch thread 는 절충안이지만 batch 정책이 추가 운영 변수가 되어
  per-Job thread 의 단순함을 깨뜨린다.

### 단, 다음 조건에서는 (1) 또는 (3) 재검토:

- Job 발생 빈도가 hour당 수십 이상으로 가속해 thread 인덱스가
  포화되는 경우 — 운영자 hot 페이지 유지 cost가 올라감.
- Job lifecycle 메시지가 매우 짧고 사용자 follow가 거의 없는 경우 —
  per-Job thread 의 발견성 이점이 약화됨.
- 외부(REST/observability) 시스템이 batch 단위로 ledger를 수집하는 경우 —
  per-batch thread가 ledger와 더 잘 정렬됨.

이 조건이 관측되면 라우터 구현은 같은 인터페이스 (`routeFollowUp`) 위에서
키 전략만 바꿔(주: taskId → batchKey) 재사용하므로 마이그레이션 비용은 작다.

## 검증 절차

1. `AUTO_ARCHIVE_DISCORD_SESSION_LOG_PARENT_CHANNEL_ID` 미설정 상태에서 기존
   라이브 회귀 테스트 통과(채널-only 동작 유지).
2. 환경 변수 설정 후 `pnpm discord:gui-ask --observe-mode image` 라이브
   1회: 원본 채널에는 Accepted만, 부모 채널에는 새 thread + running 업데이트
   + terminal 메시지가 모두 적재되는 것을 PNG 캡처로 확인.
3. 권한 누락 또는 잘못된 parent ID 케이스에서 첫 followUp이 channel-fallback
   되고 운영자 로그에 명시적 분류 메시지가 남는지 확인.
