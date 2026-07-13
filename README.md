# location-todo-api-nest

Location Todo의 NestJS API, PostgreSQL recurrence/transition/outbox workers, auth-api-nest OIDC BFF, React/Vite 관리 웹이다. 서버가 occurrence trigger authority이며 모바일은 위치 전환 evidence만 업로드한다.

## Local Run

Requirements: Node.js 20+, PostgreSQL 15+ and a running `auth-api-nest` on port 3032.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run start:dev
```

Web/API: `http://localhost:3042`, health: `GET /api/health`. Vite-only web development uses `npm run build:web` or `npx vite --config web/vite.config.ts`; its `/api` proxy targets port 3042.

The local database and role can be provisioned by a PostgreSQL administrator:

```sql
create role location_todo login password 'replace-this';
create database location_todo owner location_todo;
```

Migrations are ordered SQL files in `src/database/migrations`. The runner obtains a PostgreSQL advisory lock, applies each file transactionally, and records a SHA-256 checksum in `schema_migrations`. Never edit an applied migration. Recovery from a failed migration is rerunning `npm run db:migrate`; the failed transaction is rolled back. Rollback to an older application version is restore-from-backup, not an automatic down migration.

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
TEST_DATABASE_URL=postgresql://localhost/location_todo_test npm run test:e2e
npm run build
```

`npm run build` compiles Nest, builds React, copies SPA assets to `dist/public`, and copies migration SQL to `dist/database/migrations`. The SPA fallback explicitly excludes `/api`.

## Workers And Retention

Due and notification outbox workers run in every API process when `WORKER_ENABLED=true`. PostgreSQL `FOR UPDATE SKIP LOCKED` allows multiple replicas. Stale `RUNNING`/`SENDING` claims older than five minutes return to the queue after restart. FCM retries use exponential backoff; invalid tokens are cleared. Inbox reconciliation remains authoritative even when push/realtime delivery fails.

Retention is idempotent: notification/trigger/delivery and transition audit is purged after 30 days, inactive devices after 90 days, while `todo_trigger_guards` remain to prevent a previously emitted occurrence from firing again. TODO/geofence soft-delete history remains until account deletion.

Back up with `pg_dump --format=custom location_todo > location_todo.dump`; restore into an empty database with `pg_restore --clean --if-exists --dbname=location_todo location_todo.dump`. Pause application workers during a point-in-time restore.

## Production

```bash
docker build -t location-todo-api-nest .
docker run --env-file .env -p 3042:3042 location-todo-api-nest
```

The container runs migrations before starting the process and exposes a Docker `HEALTHCHECK` against `/api/health`. Set `PUBLIC_ORIGIN=https://loc.lafamila.xyz`, `WEB_ALLOWED_ORIGINS` to exact allowed origins (`ALLOWED_ORIGINS` remains a compatibility alias), `DATABASE_SSL` for the target PostgreSQL service, and inject secrets from a secret manager. Production rejects insecure public/auth URLs and a missing OIDC client secret. Do not put OIDC client secrets, auth refresh tokens, Kakao REST keys, or Firebase credentials in web/Flutter build variables.

External provisioning still required for production: DNS/TLS and reverse proxy for `loc.lafamila.xyz`, Kakao `Location Todo` app REST/JavaScript keys plus exact domains, Firebase `location-todo` service account plus iOS APNs connection, and auth onboarding approval/one-time OIDC client secret.

## Auth Onboarding

Submit [the onboarding request](docs/auth-onboarding-request.json) to auth-api-nest `POST /api/service-onboarding-requests` or import it in `/service`. Auth rewrites requester identity in the admin UI. On approval, copy the one-time client secret only to `LOCATION_TODO_OIDC_CLIENT_SECRET`. Core changes require an onboarding update request; do not edit the approved service spec directly. No backend service credential is requested.

## Contracts

[API v1](docs/api-v1.md) and `fixtures/v1/*.json` are the Flutter integration checkpoints. Collection envelopes are `{todos}`, `{geofences}`, and `{notifications,nextCursor}`. Errors always use `{error:{code,message,details?}}` and never include upstream/server secret detail.
