---
status: COMPLETED
summary: "Location Todo의 OIDC BFF, 위치·시간 반복 scheduler, Kakao 기반 웹 UI와 멀티디바이스 알림 API 구현"
completed_at: 2026-07-13
completion_reason: "Nest API·React 웹·PostgreSQL workers·Docker 구현과 단위 21개·통합 39개 검증을 완료했다."
---

# LOCATION TODO — location-todo-api-nest execution plan

Canonical orchestration plan:

`../../.idea/LOCATION_TODO_IDEA.md`

## Repo Responsibility

이 repo는 Location Todo의 server authority다. 계정·권한·quota, 저장 지오펜스, 위치·일반 TODO, recurrence·lifecycle, 모바일 transition 판정, 시간/delayed/dwell due job, occurrence별 exactly-once trigger, notification outbox/inbox, FCM, desktop realtime, Kakao Local proxy, React/Vite 웹을 소유한다.

Flutter client는 감지 evidence와 UI intent를 보내며 trigger authority가 아니다. `auth-api-nest`는 OIDC provider이고, 이 repo가 confidential client 및 service-owned session을 소유한다.

## Inputs / Dependencies

- Root canonical plan의 확정된 behavior와 retention 계약
- `auth-api-nest/docs/service-integration.md`, `docs/auth-flows.md`
- `game-platform-api-nest`의 PKCE/session precedent와 `body-lab-api-nest`의 BFF boundary
- PostgreSQL `location_todo` database/role
- Kakao Developers `Location Todo` app의 REST/JavaScript keys와 domain 등록
- Firebase `location-todo` project/service account, APNs 연결
- production DNS/TLS `https://loc.lafamila.xyz`
- Flutter repo와 공유할 versioned API fixtures

## Work Items

### 1. Project and quality scaffold

1. NestJS 11 TypeScript project와 `web/` React 19 + Vite project를 생성한다.
2. format, lint, typecheck, unit, integration/e2e, production build scripts를 만든다.
3. strict env parser가 `.env.example` key와 invariant를 검증하게 한다.
4. `/api/health`는 process, DB migration state를 확인하며 secret을 노출하지 않는다.
5. Nest build가 Vite assets를 `dist/public` 등 명확한 위치에 포함하고 `/api` 밖에서만 SPA fallback을 제공한다.

### 2. PostgreSQL migration foundation

1. `pg` pool과 transaction helper를 만든다.
2. ordered SQL migration files와 migration ledger/lock을 구현한다.
3. UUID, `timestamptz`, check constraint, partial unique index를 사용해 invariant를 DB에도 둔다.
4. 최소 tables를 설계한다.
   - accounts/service permission cache as needed
   - devices, app_sessions, login_transactions
   - saved_geofences
   - todos, todo_recurrence_rules, todo_schedule_windows, todo_geofences
   - todo_occurrences, occurrence_due_jobs
   - device_geofence_states, transition_events
   - todo_trigger_guards/events, due_jobs, dwell_states
   - notification_inbox, notification_outbox, delivery_attempts
5. session raw token은 hash만, auth token은 authenticated encryption으로 저장한다.
6. account hard-delete transaction과 30/90-day retention jobs를 구현한다.

### 3. Auth onboarding and persistent BFF session

1. repo 문서에 onboarding request payload를 둔다.
   - serviceKey `location-todo`
   - permission `user`
   - client `location-todo-api`, confidential, PKCE S256
   - scopes `openid profile email service.permission`
   - callbacks local/prod
   - TTL 900/2592000
   - service credentials empty
2. start/callback/complete/me/logout endpoints를 구현한다.
3. web은 HttpOnly Secure SameSite cookie + CSRF, native는 hashed opaque header session을 사용한다.
4. native return URI는 allowlisted `loc://auth/complete`만 허용하고 one-time transaction id 외 token을 넣지 않는다.
5. device/installation binding, state, PKCE verifier, expiry, one-time consumption을 검증한다.
6. refresh rotation을 DB lock으로 직렬화하고 새 token을 atomically persist한다.
7. 400/401/403 permanent rejection과 network/5xx transient failure를 구분한다.
8. idle 30d/absolute 180d service session과 per-device token family를 테스트한다.
9. `visitor -> user` service application request/status flow를 BFF에 노출한다.

### 4. Permission and quota domain

1. access token의 `service:location-todo` audience, issuer, exp, permission claim을 검증한다.
2. permission policy를 한 모듈에 둔다.
   - visitor: 3 location TODO, unlimited time TODO, 1 saved geofence
   - user: 20 location TODO, unlimited time TODO, 5 saved geofence
   - superadmin: unlimited location/time TODO, 20 saved geofence
3. location TODO와 saved geofence create/restore는 transaction 안에서 quota를 확인해 concurrent over-allocation을 막는다.
4. time TODO는 permission별 count quota를 적용하지 않되 mutation rate/payload limit을 적용한다. location TODO의 soft-deleted row는 quota에서 제외하고 inactive row는 포함한다.
5. structured quota response는 current permission, used, limit, upgrade status를 포함한다.

### 5. Saved geofence APIs and Kakao proxy

1. account-scoped create/list/get/update/soft-delete/restore를 구현한다.
2. radius check `100..5000`, WGS84 range, name/address length를 검증한다.
3. active/untriggered TODO relation이 있는 geofence projection을 device sync용으로 제공한다.
4. relation이 남은 geofence delete/restore semantics를 canonical plan과 일치시킨다.
5. Kakao address/keyword search proxy는 server REST key를 사용하고 request rate/size를 제한한다.
6. map handoff endpoint는 one-time id, account/session binding, short TTL, allowed origin을 검증한다.

### 6. TODO recurrence, schedule, relation, lifecycle APIs

1. content, recurrence, active/lifecycle 상태를 validation하고 `geofenceIds`가 비었으면 시간 TODO, 하나 이상이면 위치 TODO로 파생한다. 시간대는 `Asia/Seoul`로 고정한다.
2. 공통 recurrence rule을 저장하고 future occurrence를 계산한다.
   - `ONCE`: time TODO는 local date/time 필수
   - `DAILY`: startDate 이후 매일
   - `WEEKLY`: 하나 이상의 ISO weekday
   - `MONTHLY`: 하나 이상의 day 1..31, 없는 달은 skip
   - DST gap은 다음 유효 local time, overlap은 첫 instant 한 번
   - time ONCE는 future only; 과거 repeat start는 next future occurrence부터
3. location schedule windows를 여러 개 저장한다.
   - optional local date
   - start < end
   - end-only `24:00`
   - no cross-midnight single interval
   - 반복 location TODO는 fixed-date window와 함께 저장하지 못하게 한다.
4. location TODO는 one-or-more saved geofence OR relation과 trigger condition을 필수로 하고, time TODO는 geofence/location data를 거부한다.
5. time TODO의 exact local time과 location TODO의 eligibility windows를 kind별로 검증한다.
6. create/edit/list/get/soft-delete/restore/active toggle/complete/reactivate를 구현한다.
7. deactivate/delete/complete는 monitoring projection과 pending jobs를 transactionally cancel한다.
8. restore는 inactive로, reactivate는 과거를 backfill하지 않고 future occurrence부터 시작하게 한다.
9. optimistic concurrency/version conflict를 구조화한다.

### 7. General time occurrence scheduler

1. PostgreSQL due job이 앱/위치 상태와 무관하게 time TODO occurrence를 실행하게 한다.
2. `(todo_id, occurrence_key)` unique guard로 worker restart, retry, concurrency에서도 occurrence를 한 번만 발행한다.
3. due 시각을 지나 server가 복구되면 아직 유효한 occurrence를 expiry 없이 즉시 발행한다.
4. 반복 occurrence trigger는 series를 active로 유지하고 다음 occurrence를 같은 transaction에서 예약한다.
5. inactive 기간 occurrence는 backfill하지 않고 reactivation 이후 future occurrence만 예약한다.
6. recurrence 수정은 future jobs만 재계산하고 emitted occurrence는 보존한다.

### 8. Transition batch and state machine

1. authenticated device가 ordered idempotent batch를 업로드하고 event별 ACK를 받게 한다.
2. client UUID + device sequence unique constraint로 replay를 안전하게 처리한다.
3. observed time, accuracy, transition만 저장하고 raw route를 금지한다.
4. device/geofence state를 unknown/inside/outside/armed로 모델링한다.
5. create/reactivate while inside는 trigger하지 않고 outside 후 re-entry만 인정한다.
6. schedule eligibility를 `Asia/Seoul`과 observed entry time으로 평가한다.
7. inactive/completed/deleted state와 이미 발행된 occurrence는 late offline event보다 우선한다.
8. offline batch의 enter/exit 순서를 먼저 적용한 뒤 dwell evidence를 판정한다.
9. 반복 location TODO는 occurrence마다 한 번만 trigger하고, 다음 occurrence도 fresh outside -> inside가 있어야 한다. 계속 inside인 상태의 calendar rollover는 trigger하지 않는다.

### 9. Immediate, delayed, dwell authority

1. `ENTRY_IMMEDIATE` valid entry가 trigger guard를 획득하도록 한다.
2. `ENTRY_DELAYED`는 occurrence별 최초 valid entry 하나만 due job을 생성하고 exit로 취소하지 않는다.
3. `DWELL`은 device/geofence별 timer를 만들고 exit 전 N분 완료만 후보로 인정한다.
4. due worker는 `FOR UPDATE SKIP LOCKED` 또는 동등한 PostgreSQL locking으로 multi-worker 안전성을 보장한다.
5. trigger transaction은 occurrence 상태, series lifecycle, trigger event, inbox, outbox를 함께 commit한다.
6. simultaneous devices/geofences/jobs가 occurrence별 하나의 trigger만 만들도록 unique guard를 둔다.
7. restart/crash/retry/clock boundary test를 작성한다.

### 10. Notification delivery and realtime

1. Firebase Admin/FCM HTTP v1 adapter를 server-only credential로 구현한다.
2. device token registration/rotation/revocation과 invalid-token deactivation을 구현한다.
3. outbox worker는 retry/backoff, attempt history, terminal failure를 기록한다.
4. desktop authenticated realtime channel과 reconnect cursor를 구현한다.
5. notification inbox list/cursor/ack API로 launch/resume reconciliation을 제공한다.
6. outbox send 전후 crash와 duplicate delivery가 앱 event id로 dedupe 가능하게 한다.
7. device logout은 해당 endpoint만 제거하고 다른 devices를 유지한다.

### 11. React/Vite web app

1. 기존 workspace UI pattern을 확인하고 quiet utilitarian management UI를 만든다.
2. login/session, permission/quota, upgrade request 상태를 제공한다.
3. saved geofence CRUD와 휴지통/복원을 구현한다.
4. `/map-picker`에서 Kakao search, draggable marker, numeric radius, visible circle을 동기화한다.
5. TODO editor는 저장 위치 선택 여부로 시간/위치 입력을 자동 전환하고 `ONCE/DAILY/WEEKLY/MONTHLY` recurrence editor를 제공한다.
6. location form은 multiple windows, multi-geofence OR, three trigger modes를 제공하고 time form은 주소 없이 exact date/time을 받는다.
7. TODO list는 저장 위치에서 파생한 유형, recurrence, lifecycle, next occurrence/condition, geofences, monitoring state, trigger/complete/reactivate를 스캔 가능하게 표시한다.
8. notification inbox와 device/session management를 구현한다.
9. keyboard, focus, validation, mobile responsive behavior를 테스트한다.
10. API error codes를 사용자 행동 가능한 상태로 매핑하고 secret/server detail을 표시하지 않는다.

### 12. Retention and account deletion

1. TODO/geofence soft delete와 restore history를 유지한다.
2. notification/trigger/delivery audit 30-day purge를 구현한다.
3. 90-day inactive device cleanup과 logout immediate purge를 구현한다.
4. service account delete endpoint/job은 account-owned rows와 secrets를 hard delete한다.
5. purge 작업은 idempotent하고 FK/partial failure 테스트를 가진다.

### 13. Documentation and deploy readiness

1. README에 local auth/PostgreSQL/API/web run path를 완성한다.
2. `.env.example`과 runtime parser를 일치시킨다.
3. migration, healthcheck, backup/restore, worker operation, external provisioning을 문서화한다.
4. Docker build에 Vite assets, migration strategy, healthcheck가 포함되는지 검증한다.
5. auth onboarding request/approval/secret-copy 절차를 문서화한다.
6. Flutter repo에 versioned API examples와 error contract 변경을 보고한다.

## API Contract Checkpoints For Flutter

- session start/complete/header and native return transaction
- device registration and active monitoring projection
- geofence relation-derived TODO behavior, recurrence/schedule DTOs, and location quota error shape
- transition batch event/ACK/idempotency shape
- notification inbox cursor and realtime event envelope
- map handoff request/result envelope

Contract가 바뀌면 Flutter repo subagent에게 즉시 handoff하고 fixtures를 같은 checkpoint에서 갱신한다.

## Acceptance Criteria

- Empty PostgreSQL에서 migrations가 순서대로 적용되고 rollback/recovery가 문서화된다.
- visitor/user/superadmin location TODO/geofence quota가 create/restore concurrency에서도 정확하고 time TODO는 모두 unlimited다.
- web/native auth는 client secret을 노출하지 않고 per-device session/refresh family를 유지한다.
- time TODO가 client나 위치 권한 없이 due 시각에 실행되고 restart 후 overdue occurrence를 복구한다.
- ONCE/DAILY/WEEKLY/MONTHLY와 DST/month-missing 규칙이 occurrence tests로 고정된다.
- create/reactivate inside 상태, schedule windows, multi-geofence OR, 반복 회차의 fresh re-entry, inactive/late event 규칙이 tests로 고정된다.
- immediate/delayed/dwell의 concurrent candidates가 occurrence별 trigger/outbox 하나만 만든다.
- API restart 후 sessions, due jobs, offline ACK, outbox delivery가 복구된다.
- FCM failure와 desktop disconnect 뒤 inbox reconciliation이 가능하다.
- React/Vite UI가 일반·위치 TODO, recurrence, full geofence/TODO lifecycle과 permission request를 수행한다.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`가 통과한다.
- production build에서 SPA가 `/api`를 shadow하지 않고 `/api/health`가 정상이다.

## Report Back To Orchestrator

- final OpenAPI/DTO fixtures와 Flutter에 필요한 contract
- auth onboarding request id/spec와 아직 외부 승인이 필요한 provisioning
- 추가·변경된 env keys와 secret acquisition path
- PostgreSQL schema/migration/retention decisions
- physical-device integration을 막는 Firebase/Kakao/DNS blocker
- 남은 delivery/geofence timing risk

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator에게 전달해 결정받은 뒤 진행한다. orchestrator에 보고할 수 없으면 workspace root `.idea/`에 handoff 문서를 남긴다.
