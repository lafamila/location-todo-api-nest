# location-todo-api-nest

Location Todo의 API, `auth-api-nest` OIDC BFF, PostgreSQL 알림 파이프라인, React/Vite 등록·관리 웹을 제공한다.

현재 repo는 실행 계획과 배포 계약만 준비된 bootstrap 상태다. 구현은 [repo execution plan](./.idea/LOCATION_TODO_LOCATION_TODO_API_NEST_PLAN.md)을 따른다.

## 실행 (local)

```bash
npm install
npm run migrate
npm run start:dev   # http://localhost:3042
```

필요 env는 `.env.example`을 기준으로 `.env`에 채운다. 실제 secret은 커밋하지 않는다.

## 빌드 / 테스트

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## 배포

```bash
docker build -t location-todo-api-nest .
docker run --env-file .env -p 3042:3042 location-todo-api-nest
```

- healthcheck: `GET /api/health`
- production origin: `https://loc.lafamila.xyz`
- migration: `npm run migrate`
- seed: 없음. auth 연동은 request-driven service onboarding을 사용한다.

전체 아키텍처와 결정은 [`CLAUDE.md`](./CLAUDE.md)와 [canonical plan](../.idea/LOCATION_TODO_IDEA.md)을 참조한다.
