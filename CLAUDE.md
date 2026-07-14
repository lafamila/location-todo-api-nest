# location-todo-api-nest

Location Todo의 NestJS API, OIDC BFF, PostgreSQL 위치·시간 recurrence pipeline, React/Vite 웹 UI를 소유하는 서비스.

> 이 파일이 본 레포의 canonical 가이드입니다. `AGENTS.md` 는 Codex CLI 호환용 stub 입니다.

- **Lifecycle**: DEPLOY
- **Status**: draft
- **Port**: 3042
- **Auth**: serviceKey `location-todo`

위 헤더 값은 루트 `.workspace-registry.yaml` 과 일치해야 한다 (`.scripts/check-workspace.sh` 가 검증).

## 워크스페이스 대원칙 (canonical)

이 레포는 `../CLAUDE.md` 의 **DEVELOPMENT PRINCIPLES** 섹션을 따른다. 핵심 재진술:

1. **인증** — `auth-api-nest` OIDC를 confidential BFF로 통합하며 자체 계정/비밀번호를 만들지 않는다.
2. **기능 단위 커밋** — 한 기능이 계획-구현-검토를 통과하면 즉시 1개의 Conventional Commit. 여러 기능을 묶지 않는다.
3. **Agent co-author 제외** — `Co-authored-by` trailer를 추가하지 않는다.
4. **계획 → 구현 → 검토** — 계획 단계에서 검토 통과 기준과 실행할 테스트를 명시한다.
5. **Docker 빌드 가능** — repo-local Dockerfile(HEALTHCHECK 포함), env/deploy/migration 문서를 유지한다. Root compose 앱 등록은 기본값이 아니다.
6. **Cross-repo 영향 보고** — Flutter contract, auth spec, env/deploy에 영향이 있으면 orchestrator에 보고하거나 `../.idea/LOCATION_TODO_API_NEST_CROSS_REPO_IMPACT_{YYYYMMDD}.md`를 남긴다.
7. **사용자 결정 에스컬레이션** — 주요 사안은 임의 결정하지 않고 orchestrator/사용자에게 전달한다.

## Auth 결정표 (원칙 2)

| 항목 | 결정 |
|------|------|
| `serviceKey` | `location-todo` |
| 권한등급 정의 | onboarding permission `user`; location TODO/geofence quota는 visitor 3/1, user 20/5, superadmin unlimited/20; time TODO는 전 등급 unlimited |
| `visitor` | 로그인 직후 일반 시간 알림은 무제한, 위치 기능은 저한도로 사용하며 앱에서 `user` 상승 요청 가능 |
| `superadmin` | auth `is_super_admin`에서 lazy 부여되는 최고 권한; TODO 무제한, geofence 20 |
| OIDC client 필요 여부 | confidential client `location-todo-api`, PKCE S256 required |
| redirect/callback URI | local `http://localhost:3042/api/session/oidc/callback`; prod `https://loc.lafamila.xyz/api/session/oidc/callback` |
| 로그인 시작/UX | API start -> auth hosted login -> API callback; web cookie 또는 native one-time `loc://auth/complete` handoff |
| token/session 검증·refresh 전략 | RS256 issuer/audience/exp/permission 검증, backend refresh rotation, DB lock, opaque service session idle 30d/absolute 180d |
| 권한 분기 지점 | create/restore quota, geofence/TODO mutation, permission-upgrade 상태 |
| access denied 동작 | 로그인 redirect loop 금지; 현재 permission/quota와 upgrade request 상태를 구조화 응답 |
| backend service credential | 불필요; account search/permission-read service scope를 사용하지 않음 |
| local/prod env vars | `AUTH_*`, `LOCATION_TODO_OIDC_*`, session TTL/header/cookie, origin, encryption key를 `.env.example`로 관리 |
| 비밀 노출 금지 보증 | client secret, auth access/refresh token, Firebase service credential, Kakao REST key는 SPA/Flutter bundle에 포함하지 않는다. |

## Project Decisions

- Canonical plan: `../.idea/LOCATION_TODO_IDEA.md`
- Production origin: `https://loc.lafamila.xyz`
- Stack: NestJS 11, raw SQL + `pg`, PostgreSQL, React 19 + Vite SPA, Socket.IO-compatible realtime boundary.
- The SPA lives under `web/`, builds into the Nest production artifact, and is served only outside `/api`.
- PostgreSQL owns sessions, domain data, due jobs, durable outbox, notification inbox, delivery attempts, and idempotency.
- TODO는 kind 필드를 저장하거나 노출하지 않는다. `todo_geofences` 관계가 없으면 시간 TODO, 하나 이상이면 위치 TODO로 파생하며 두 유형 모두 `ONCE/DAILY/WEEKLY/MONTHLY` recurrence를 공유한다.
- Exactly-once 경계는 series 전체가 아니라 `(todoId, occurrenceKey)`다. 반복 location TODO는 다음 회차에 fresh outside-to-inside가 필요하다.
- Redis and Azure/WNS are excluded from the current plan.
- Migrations are ordered SQL files with an explicit migration ledger; do not grow an ad hoc `CREATE TABLE IF NOT EXISTS` block in application startup.
- API contract DTOs are the cross-repo source of truth. Flutter fixtures must be updated when contracts change.
- All instants are stored as `timestamptz`; calendar and schedule evaluation is fixed to `Asia/Seoul` and no timezone field is accepted.
- Raw continuous GPS coordinates and movement paths must never be persisted or logged.

## Structure Target

```text
src/
  auth/              # OIDC BFF, sessions, permission upgrade
  config/            # strict env parsing
  database/          # pg pool, migrations, transaction helpers
  devices/           # installation/session/push registration
  geofences/         # saved geofence domain + quota
  todos/             # location/time TODO, recurrence, schedules, OR relations, lifecycle
  transitions/       # idempotent offline batches and state machine
  notifications/     # time/location occurrences, due jobs, outbox, FCM, inbox
  realtime/          # authenticated desktop fan-out
  kakao/             # server-only Local API proxy and map handoff
  health/
web/
  src/               # React/Vite registration and management SPA
migrations/
test/
```

## Local Dev Commands

```bash
npm install
npm run migrate
npm run start:dev
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Security Boundaries

- Browser auth uses HttpOnly Secure SameSite cookie plus CSRF protection.
- Native auth uses a hashed opaque session token supplied through `X-Location-Todo-Session`.
- Auth refresh tokens are backend-only and encrypted at rest.
- Every account-owned query includes `account_id`; ownership tests cover cross-account identifiers.
- Client event timestamps are evidence, not authority. Validate event sequence, known device, active TODO, schedule, and idempotency.
- `loc://` carries only a one-time transaction id bound to state and installation id.

## Review Criteria

- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e` pass.
- `npm run build` produces Nest code and React/Vite assets; the SPA fallback never captures `/api/*`.
- migrations apply from empty PostgreSQL and reject incompatible/partial state.
- concurrent time/transition/due workers prove exactly-one trigger and outbox event per occurrence.
- auth secrets do not appear in built web assets or API responses.
- Docker build and `/api/health` pass during repo wrapup.
