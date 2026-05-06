---
status: active
authority: implementation-spec
last_verified: 2026-05-06
source_paths:
  - src/discord/discord-session-log-forum-router.ts
  - src/discord/discord-command-handlers.ts
  - src/discord/discord-bot.ts
  - src/discord/discord-service-bootstrap.ts
scope: job 할당 후 lifecycle 메시지를 채팅 채널이 아닌 세션 로그 포럼의 새 스레드로 라우팅하는 동작 명세.
---

# 스펙: Discord 세션 로그 포럼 라우팅

## 사용 시점

`/ask`, `/research`, 자연어 멘션 등으로 Job이 수락된 직후, 같은 채팅 채널에서
계속해서 lifecycle 메시지(`Accepted`, `running-update`, `terminal-result`,
`status-reply` 등)를 누적하는 대신, 미리 지정된 **세션 로그 포럼 채널**에서
**Job 단위로 새 스레드**를 만들어 그곳에서 이어가도록 한다.

## 결정

- 라우팅은 옵트인이다. `AUTO_ARCHIVE_DISCORD_SESSION_LOG_FORUM_ID`가 비어
  있거나 미설정이면 기존 동작을 100% 유지한다.
- 환경 변수가 설정되면 그 값은 Discord `GUILD_FORUM` 채널 ID여야 한다.
- 초기 응답(`Accepted`, `editReply`)은 여전히 원본 채팅 채널/interaction 으로
  나간다. 이 메시지는 사용자에게 즉시 가시적이어야 하며, 사용자가 Job 진행
  상황을 어디서 볼 수 있는지를 안내하는 thread mention(또는 `채널 / 스레드:`
  스타일 보조 라인)을 포함할 수 있다.
- 모든 후속 메시지(`followUp`)는 새 스레드로 라우팅한다. 같은 Task ID에
  대한 첫 후속 호출 시점에 스레드가 lazy 하게 생성된다 — 포럼 채널은 빈
  스레드 생성을 허용하지 않으므로, 첫 후속 메시지 자체가 스레드의 시작
  메시지가 된다.
- 스레드 이름은 `Task ${taskId}` (또는 짧은 instruction 접두사 + taskId
  마지막 12자) 형태로 표준화한다. 운영자 제공 prefix는 상수로 시작.
- 스레드 → Task 매핑은 in-process Map. 프로세스 재기동 시점에는 사라지지만
  Discord 측 스레드 자체는 유지되며, 같은 Task ID로 다시 followUp이 들어오면
  새 스레드가 만들어진다(중복 스레드 가능). 이는 명시적 trade-off이며
  retention 정책은 §의 평가 메모를 따른다.

## 라우팅 표면

`DiscordSessionLogForumRouter` 포트:

```ts
interface DiscordSessionLogForumRouter {
  routeFollowUp(input: {
    taskId: string;
    payload: DiscordMessagePayload;
    eventType?: DiscordDeliveryEventType;
  }): Promise<{ delivered: 'thread' | 'channel-fallback' }>;
}
```

- `delivered: 'thread'`: 정상적으로 thread로 보낸 경우.
- `delivered: 'channel-fallback'`: thread 생성 / 송신 실패시 caller가 원본
  channel followUp으로 fail-open. 운영자에게는 단일 메시지 누락이 thread
  일관성보다 더 큰 사고이기 때문이다.

`DiscordJsSessionLogForumRouter` 기본 구현:
- 첫 호출 시 `client.channels.fetch(forumId)`로 forum channel을 가져와
  `forumChannel.threads.create({ name, message: { content: payload.content } })`
  로 스레드를 생성한다.
- 결과 Promise를 Map<taskId, Promise<thread>>에 캐시. 두 번째부터는
  `thread.send(payload)`.
- discord.js 에러는 caller에게 throw하지 않고 `'channel-fallback'`을
  반환해 fail-open한다.

## 호출 지점

`DiscordCommandHandlers.deliver()`의 executor lambda:

```ts
if (req.operation === 'editReply') {
  await interaction.editReply(req.payload);
} else {
  const router = this.options.sessionLogForumRouter;
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

- `AUTO_ARCHIVE_DISCORD_SESSION_LOG_FORUM_ID`: 세션 로그 포럼 채널 ID. 빈
  문자열이면 비활성화(라우터 미생성).
- 추가 구성은 두지 않는다. 스레드 이름 규칙은 코드 상수로 고정하여 운영
  매뉴얼 변경을 줄인다.

## 보안 / 권한

- 봇 토큰의 권한이 포럼 채널에 thread 생성 + send 가능해야 한다.
  사전 확인은 `core:stack:health` Doctor flow로 추가 검사 가능하나, 이번
  변경에서는 fail-open 처리만 보장한다.
- 포럼 채널 ID 검증: 잘못된 ID(또는 GUILD_FORUM 이외 type)인 경우 첫
  followUp에서 channel-fallback이 발생하고 운영자 로그에 분류된 에러가
  남는다. 이 경계는 명시적 사양이다.

## 운영자 영향

- 기존 채팅 채널은 Job 수락 사실 + thread 링크만 받는다(또는 Accepted
  payload 단일 메시지만).
- 모든 후속 lifecycle/observability 메시지는 forum thread로 이동한다.
  archive/검색은 forum의 internal 정렬/태그 기능 이용.
- `runtime-state/discord-dlq.jsonl`의 `context.channelId`는 송신 실패시
  여전히 원본 channel ID를 가지며, thread route 실패는 별도 로그로 구분
  로깅(`route=thread-fallback`).

## 트레이드오프 평가 (Forum-post vs Thread)

본 스펙은 **forum 채널 + thread per Job** 조합을 기본으로 채택한다. 일반
text 채널의 thread와 비교하면 다음과 같다.

| axis | Forum + per-Job thread | Plain text channel + threads |
| --- | --- | --- |
| 발견성 | 포럼 첫 페이지에서 task 단위 sort/filter | 채널 사이드바의 "Threads" 메뉴 의존 |
| Tag/Sort | 포럼 tag, pinned, sort by latest 가능 | thread metadata 외에는 정렬 옵션 부족 |
| 검색 | 포럼 channel-scoped 검색 자연 | thread별 분산, 채널 검색은 thread 일부만 노출 |
| 모바일 UX | 포럼 view가 첫 메시지 + 메타 보여줌 | 채널 화면에서 thread 진입 1단계 더 |
| 권한 모델 | 포럼 channel 단위 권한 — 운영자 일괄 통제 용이 | 채널 권한이 thread에도 자동 상속, override 별도 |
| 링크 공유 | thread URL이 forum post URL로 안정 | thread URL 동일하지만 발견성 낮음 |
| 보존/Archive | 포럼은 archived posts를 별도 보존 표면으로 가짐 | thread auto-archive 후 발견성 거의 0 |
| REST 관찰성 | thread 리스트 API + post 메타로 enumerate | thread enumeration 동일하나 forum 메타가 풍부 |
| 알림 정책 | 포럼은 follow-by-default 옵션 사용자별 제어 | 채널 알림에 thread 알림이 묶임 |
| 운영 부담 | 포럼 채널 1개 신설 + 권한 셋업 | 추가 인프라 불필요, 기존 채널 사용 |

권고: **forum + per-Job thread**. 운영 부담은 1회성 설정뿐이고 발견성/검색
/Archive 측면 이점이 thread-only 모델 대비 충분히 크다. 단, 운영 환경이
forum 채널 신설을 허용하지 않는다면 plain channel + thread도 동일한
라우팅 코드가 동작하도록 라우터 구현은 forum-only API에 의존하지 않게
유지한다(예: `channel.threads.create` 가 ForumChannel/TextChannel 모두에서
유효).

## 평가 메모: 포럼 적재 vs 스레드 활용 (Task 3 결론)

위 §의 axis 표는 채널 형태(forum vs text)에 한정한 비교였다. 본 §은 같은
GUILD_FORUM 채널 안에서도 세 가지 적재 패턴이 가능함을 분리한다.

1. **single forum post + thread reply chain**: 모든 Job을 한 forum post의
   reply chain에 누적. (Forum post의 본질이 thread이므로 사실상 단일 thread.)
2. **per-Job forum post = per-Job thread** (현재 채택): Job 하나 = forum post
   하나 = thread 하나. 본 스펙의 default.
3. **forum-post-per-batch**: 운영자가 정의한 묶음(예: 일자별, 채널별) 단위로
   thread 1개. 그 안에 여러 Job 메시지를 누적.

| axis | 1) single post chain | 2) per-Job thread (default) | 3) per-batch thread |
| --- | --- | --- | --- |
| 신호:잡음 비율 | 한 thread 안에 여러 Job 섞임 → 낮음 | Job 1개에 lifecycle 메시지만 → 높음 | batch 내부에서는 일관 — 단, 동시 Job이 많으면 인터리브 발생 |
| 검색/링크 | thread URL 1개로 끝 — 특정 Job 찾기 어려움 | post 제목이 task ID라 즉시 jump | batch 식별자로 navigate 후 task 검색 |
| 알림 부담 | 모든 follower가 모든 Job 알림 수신 → 노이즈 | 본인 관심 Job thread만 follow | 제한된 batch 단위 follow |
| Forum tag UX | 사용 곤란(태그가 thread 단위로 의미 없음) | 강함 — task type/severity 등 운영자 정의 가능 | 약함 — batch 단위 tag만 |
| Discord 한도 | 단일 thread 메시지 누적 → 페이지네이션 부담 | thread당 메시지 수 적어 페이지네이션 자연 | 1)과 2)의 중간 |
| 보존 정책 | 단일 thread archived 시 모든 Job 동시 영향 | Job 별 archive/태깅 — fine-grained | batch archive로 일괄 처리 가능 |
| 운영자 인지 부담 | 가장 단순(URL 하나) | 중간(forum 인덱스 사용) | 운영자 batch 정책 정의 필요 |
| 구현 부담 | 가장 작음 (router 단일 thread cache) | 작음 (Map<taskId, thread>) | batch 키 생성/만료 정책 필요 |
| Discord REST 비용 | 가장 적음 — 첫 thread 1회 생성 | 평이 — Job마다 1회 생성 | batch 첫 메시지마다 1회 |
| 동시 Job 분리 | 없음 — Job 내용 재구성 어려움 | 자연 — 각 thread 독립 | 부분적 — thread 안 인터리브 가능 |
| 병행성 (lifecycle 빠른 fan-out) | thread 락/순서 보장 X — 메시지 인터리브 위험 | thread 단위로 직렬화 — 자연 | batch 안에서 인터리브 위험 |

### 결론 (Task 3 답)

**(2) per-Job thread**가 운영 편의성이 가장 높다.

- 핵심 근거: Job 단위로 메시지가 분리되므로 (i) 검색/링크 공유, (ii) 보존
  정책, (iii) 동시 Job 분리, (iv) tag 활용이 모두 단일 차원 — task ID — 으로
  깨끗하게 정렬된다.
- (1) single post chain 은 가장 적은 구현 부담을 갖지만 신호:잡음 비율이
  급격히 악화된다. 운영자가 "방금 끝난 task X의 lifecycle 어디서 봐?"에
  대해 thread를 스크롤해야 한다.
- (3) per-batch thread 는 절충안이지만 batch 정책이 추가 운영 변수가 되어
  forum + per-Job thread 의 단순함을 깨뜨린다.

### 단, 다음 조건에서는 (1) 또는 (3) 재검토:

- Job 발생 빈도가 hour당 수십 이상으로 가속해 forum post 인덱스가
  포화되는 경우 — Discord forum은 archive를 잘 처리하지만 운영자 hot 페이지
  유지 cost가 올라감.
- Job lifecycle 메시지가 매우 짧고 사용자 follow가 거의 없는 경우 —
  per-Job thread 의 발견성 이점이 약화됨.
- 외부(REST/observability) 시스템이 batch 단위로 ledger를 수집하는 경우 —
  per-batch thread가 ledger와 더 잘 정렬됨.

이 조건이 관측되면 라우터 구현은 같은 인터페이스 (`routeFollowUp`) 위에서
키 전략만 바꿔(주: taskId → batchKey) 재사용하므로 마이그레이션 비용은 작다.

## 검증 절차

1. `AUTO_ARCHIVE_DISCORD_SESSION_LOG_FORUM_ID` 미설정 상태에서 기존 라이브
   회귀 테스트 통과(채널-only 동작 유지).
2. 환경 변수 설정 후 `pnpm discord:gui-ask --observe-mode image` 라이브
   1회: 원본 채널에는 Accepted만, forum 채널에는 새 thread + running 업데이트
   + terminal 메시지가 모두 적재되는 것을 PNG 캡처로 확인.
3. Forum 권한 누락(잘못된 forumId) 케이스에서 첫 followUp이 channel-fallback
   되고 운영자 로그에 명시적 분류 메시지가 남는지 확인.
