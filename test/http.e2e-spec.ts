import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { TokenCipher } from "../src/auth/token-cipher";
import { DatabaseService } from "../src/database/database.service";

describe("HTTP authentication and ownership", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let cipher: TokenCipher;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("TEST_DATABASE_URL is required for e2e tests");
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.WORKER_ENABLED = "false";
    process.env.LOCATION_TODO_OIDC_CLIENT_SECRET = "test-client-secret";
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
    db = module.get(DatabaseService);
    cipher = module.get(TokenCipher);
  });

  beforeEach(async () => {
    await db.query("truncate table accounts cascade");
  });

  afterAll(async () => {
    await app.close();
  });

  test("requires authentication and CSRF for browser mutation", async () => {
    await request(app.getHttpServer()).get("/api/todos").expect(401);
    const owner = await seedHttpAccount(db);
    const session = await seedHttpSession(db, cipher, owner, true);
    await request(app.getHttpServer())
      .post("/api/todos")
      .set("Cookie", `location_todo_session=${session.raw}`)
      .send(timeTodo("CSRF"))
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: "CSRF_INVALID" } }),
      );
  });

  test("slides browser cookies on authenticated activity", async () => {
    const owner = await seedHttpAccount(db);
    const session = await seedHttpSession(db, cipher, owner, true);
    const response = await request(app.getHttpServer())
      .get("/api/session/me")
      .set(
        "Cookie",
        `location_todo_session=${session.raw}; location_todo_csrf=${session.csrf}`,
      )
      .expect(200);
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("location_todo_session="),
        expect.stringContaining("location_todo_csrf="),
      ]),
    );
  });

  test("returns validation envelopes for missing mutation bodies", async () => {
    const owner = await seedHttpAccount(db);
    const session = await seedHttpSession(db, cipher, owner, false);
    const header = { "x-location-todo-session": session.raw };
    const requests = [
      () =>
        request(app.getHttpServer())
          .post("/api/session/oidc/complete")
          .send({}),
      () =>
        request(app.getHttpServer())
          .post(`/api/todos/${randomUUID()}/active`)
          .set(header)
          .send({}),
      () =>
        request(app.getHttpServer())
          .delete(`/api/geofences/${randomUUID()}`)
          .set(header)
          .send({}),
      () =>
        request(app.getHttpServer())
          .post("/api/notifications/inbox/ack")
          .set(header)
          .send({}),
      () =>
        request(app.getHttpServer())
          .post("/api/devices/register")
          .set(header)
          .send({}),
      () =>
        request(app.getHttpServer())
          .post("/api/kakao/map-handoffs")
          .set(header)
          .send({}),
      () =>
        request(app.getHttpServer())
          .post("/api/session/permission-request")
          .set(header)
          .send({}),
    ];
    for (const execute of requests) {
      await execute()
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({ error: { code: "VALIDATION_ERROR" } }),
        );
    }
  });

  test("renders native callback errors without script injection", async () => {
    const started = await request(app.getHttpServer())
      .post("/api/session/oidc/start")
      .send({
        clientKind: "native",
        installationId: randomUUID(),
        platform: "ios",
        appVersion: "1.0",
      })
      .expect(201);
    const state = new URL(started.body.authorizeUrl as string).searchParams.get(
      "state",
    );
    const response = await request(app.getHttpServer())
      .get("/api/session/oidc/callback")
      .query({ state, error: "</script><script>alert(1)</script>" })
      .expect(200);

    expect(response.headers["content-security-policy"]).toMatch(
      /script-src 'nonce-[A-Za-z0-9+/=]+'/,
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toContain("</script><script>");
    expect(response.text).toContain("loc://auth/complete");
    expect(response.text).toContain("error=authorization_error");
  });

  test("deletes an authenticated account and cascades owned durable data", async () => {
    const owner = await seedHttpAccount(db);
    const session = await seedHttpSession(db, cipher, owner, false);
    const device = await db.query<{ id: string }>(
      `insert into devices(account_id,installation_id,platform,app_version,push_token)
       values($1,$2,'ios','1.0','delete-token') returning id`,
      [owner, randomUUID()],
    );
    const geofence = await db.query<{ id: string }>(
      `insert into saved_geofences(account_id,name,address,latitude,longitude,radius_meters)
       values($1,'Delete me','Seoul',37.5,127,200) returning id`,
      [owner],
    );
    const todo = await db.query<{ id: string }>(
      `insert into todos(account_id,content,kind,timezone,recurrence_type,recurrence_start_date,local_time)
       values($1,'Delete me','TIME','UTC','DAILY','2020-01-01','09:00') returning id`,
      [owner],
    );
    const occurrence = await db.query<{ id: string }>(
      `insert into todo_occurrences(todo_id,occurrence_key,due_at)
       values($1,'delete-cascade',now()) returning id`,
      [todo.rows[0]!.id],
    );
    const event = await db.query<{ id: string }>(
      `insert into trigger_events(account_id,todo_id,occurrence_id,occurrence_key,content,source_type)
       values($1,$2,$3,'delete-cascade','Delete me','TIME') returning id`,
      [owner, todo.rows[0]!.id, occurrence.rows[0]!.id],
    );
    await db.query(
      `insert into notification_inbox(account_id,trigger_event_id,payload) values($1,$2,'{}')`,
      [owner, event.rows[0]!.id],
    );
    const outbox = await db.query<{ id: string }>(
      `insert into notification_outbox(trigger_event_id,device_id,event_id,payload)
       values($1,$2,$3,'{}') returning id`,
      [event.rows[0]!.id, device.rows[0]!.id, randomUUID()],
    );
    await db.query(
      `insert into delivery_attempts(outbox_id,attempt_number,outcome) values($1,1,'failed')`,
      [outbox.rows[0]!.id],
    );
    const handoff = await db.query<{ id: string }>(
      `insert into map_handoffs(account_id,session_id,allowed_origin,expires_at)
       values($1,$2,'http://localhost:3042',now()+interval '5 minutes') returning id`,
      [owner, session.id],
    );
    await db.query(
      `insert into rate_limit_counters(scope,subject,window_start,count)
       values('kakao_search',$1,date_trunc('minute',now()),1)`,
      [owner],
    );

    const header = { "x-location-todo-session": session.raw };
    await request(app.getHttpServer())
      .delete("/api/account")
      .set(header)
      .expect(200)
      .expect({ deleted: true });
    await request(app.getHttpServer())
      .get("/api/session/me")
      .set(header)
      .expect(401);

    const remaining = await db.query<{
      accounts: number;
      devices: number;
      sessions: number;
      geofences: number;
      todos: number;
      occurrences: number;
      events: number;
      inbox: number;
      outbox: number;
      attempts: number;
      handoffs: number;
      rate_limits: number;
    }>(
      `select
       (select count(*)::int from accounts where id=$1) accounts,
       (select count(*)::int from devices where account_id=$1) devices,
       (select count(*)::int from app_sessions where account_id=$1) sessions,
       (select count(*)::int from saved_geofences where id=$2) geofences,
       (select count(*)::int from todos where id=$3) todos,
       (select count(*)::int from todo_occurrences where id=$4) occurrences,
       (select count(*)::int from trigger_events where id=$5) events,
       (select count(*)::int from notification_inbox where trigger_event_id=$5) inbox,
       (select count(*)::int from notification_outbox where id=$6) outbox,
       (select count(*)::int from delivery_attempts where outbox_id=$6) attempts,
       (select count(*)::int from map_handoffs where id=$7) handoffs,
       (select count(*)::int from rate_limit_counters where subject=$8) rate_limits`,
      [
        owner,
        geofence.rows[0]!.id,
        todo.rows[0]!.id,
        occurrence.rows[0]!.id,
        event.rows[0]!.id,
        outbox.rows[0]!.id,
        handoff.rows[0]!.id,
        owner,
      ],
    );
    expect(remaining.rows[0]).toEqual({
      accounts: 0,
      devices: 0,
      sessions: 0,
      geofences: 0,
      todos: 0,
      occurrences: 0,
      events: 0,
      inbox: 0,
      outbox: 0,
      attempts: 0,
      handoffs: 0,
      rate_limits: 0,
    });
  });

  test("hides account-owned TODO, geofence, device, and handoff resources", async () => {
    const owner = await seedHttpAccount(db);
    const outsider = await seedHttpAccount(db);
    const ownerSession = await seedHttpSession(db, cipher, owner, false);
    const outsiderSession = await seedHttpSession(db, cipher, outsider, false);
    const geofence = await db.query<{ id: string }>(
      `insert into saved_geofences(account_id,name,address,latitude,longitude,radius_meters)
       values($1,'Private','Seoul',37.5,127,200) returning id`,
      [owner],
    );
    const deletedGeofence = await db.query<{ id: string }>(
      `insert into saved_geofences(account_id,name,address,latitude,longitude,radius_meters,deleted_at)
       values($1,'Deleted private','Seoul',37.5,127,200,now()) returning id`,
      [owner],
    );
    const todo = await db.query<{ id: string }>(
      `insert into todos(account_id,content,kind,timezone,recurrence_type,recurrence_start_date,local_time)
       values($1,'Private','TIME','UTC','DAILY','2020-01-01','09:00') returning id`,
      [owner],
    );
    const deletedTodo = await db.query<{ id: string }>(
      `insert into todos(account_id,content,kind,timezone,recurrence_type,recurrence_start_date,local_time,active,lifecycle_status,deleted_at)
       values($1,'Deleted private','TIME','UTC','DAILY','2020-01-01','09:00',false,'INACTIVE',now()) returning id`,
      [owner],
    );
    const device = await db.query<{ id: string }>(
      `insert into devices(account_id,installation_id,platform,app_version)
       values($1,$2,'ios','1.0') returning id`,
      [owner, randomUUID()],
    );
    const handoff = await db.query<{ id: string }>(
      `insert into map_handoffs(account_id,session_id,allowed_origin,expires_at)
       values($1,$2,'http://localhost:3042',now()+interval '5 minutes') returning id`,
      [owner, ownerSession.id],
    );
    const header = { "x-location-todo-session": outsiderSession.raw };

    await request(app.getHttpServer())
      .get("/api/todos")
      .set(header)
      .expect(200)
      .expect(({ body }) => expect(body.todos).toEqual([]));
    await request(app.getHttpServer())
      .get("/api/geofences")
      .set(header)
      .expect(200)
      .expect(({ body }) => expect(body.geofences).toEqual([]));
    await request(app.getHttpServer())
      .get("/api/devices")
      .set(header)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));

    await request(app.getHttpServer())
      .get(`/api/todos/${todo.rows[0]!.id}`)
      .set(header)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/todos/${todo.rows[0]!.id}`)
      .set(header)
      .send({ ...timeTodo("Changed"), version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/todos/${todo.rows[0]!.id}/active`)
      .set(header)
      .send({ active: false, version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/todos/${todo.rows[0]!.id}/complete`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/todos/${todo.rows[0]!.id}/reactivate`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/todos/${todo.rows[0]!.id}`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/todos/${deletedTodo.rows[0]!.id}/restore`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/geofences/${geofence.rows[0]!.id}`)
      .set(header)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/geofences/${geofence.rows[0]!.id}`)
      .set(header)
      .send({
        name: "Changed",
        address: "Seoul",
        latitude: 37.5,
        longitude: 127,
        radiusMeters: 200,
        version: 1,
      })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/geofences/${geofence.rows[0]!.id}`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/geofences/${deletedGeofence.rows[0]!.id}/restore`)
      .set(header)
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/devices/${device.rows[0]!.id}`)
      .set(header)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/kakao/map-handoffs/${handoff.rows[0]!.id}/result`)
      .set(header)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/kakao/map-handoffs/${handoff.rows[0]!.id}`)
      .set("Origin", "https://evil.example")
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/kakao/map-handoffs/${handoff.rows[0]!.id}/search`)
      .query({ type: "keyword", q: "office" })
      .set("Origin", "https://evil.example")
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/kakao/map-handoffs/${handoff.rows[0]!.id}/result`)
      .set("Origin", "https://evil.example")
      .send({
        name: "Attacker",
        address: "Seoul",
        latitude: 37.5,
        longitude: 127,
        radiusMeters: 200,
      })
      .expect(403);

    const eventId = await seedHttpNotification(db, owner);
    await request(app.getHttpServer())
      .get("/api/notifications/inbox")
      .set(header)
      .expect(200)
      .expect(({ body }) => expect(body.notifications).toEqual([]));
    await request(app.getHttpServer())
      .post("/api/notifications/inbox/ack")
      .set(header)
      .send({ eventIds: [eventId] })
      .expect(201)
      .expect(({ body }) => expect(body).toEqual({ acknowledged: 0 }));
    const inbox = await db.query<{ acknowledged_at: Date | null }>(
      "select acknowledged_at from notification_inbox where trigger_event_id=$1",
      [eventId],
    );
    expect(inbox.rows[0]?.acknowledged_at).toBeNull();
  });
});

async function seedHttpAccount(db: DatabaseService): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts(id,display_name,permission) values($1,'HTTP Tester','user')`,
    [id],
  );
  return id;
}

async function seedHttpSession(
  db: DatabaseService,
  cipher: TokenCipher,
  accountId: string,
  browser: boolean,
): Promise<{ id: string; raw: string; csrf: string }> {
  const id = randomUUID();
  const raw = randomUUID();
  const csrf = randomUUID();
  await db.query(
    `insert into app_sessions
     (id,account_id,token_hash,csrf_hash,access_token_encrypted,refresh_token_encrypted,
      access_token_expires_at,idle_expires_at,absolute_expires_at,client_platform)
     values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day',now()+interval '30 days','web')`,
    [
      id,
      accountId,
      cipher.hash(raw),
      browser ? cipher.hash(csrf) : null,
      cipher.encrypt("access"),
      cipher.encrypt("refresh"),
    ],
  );
  return { id, raw, csrf };
}

function timeTodo(content: string) {
  return {
    content,
    kind: "TIME",
    timezone: "UTC",
    recurrence: { type: "DAILY", startDate: "2020-01-01" },
    localTime: "09:00",
  };
}

async function seedHttpNotification(
  db: DatabaseService,
  accountId: string,
): Promise<string> {
  const todo = await db.query<{ id: string }>(
    `insert into todos(account_id,content,kind,timezone,recurrence_type,recurrence_start_date,local_time)
     values($1,'Notification','TIME','UTC','ONCE','2026-07-13','09:00') returning id`,
    [accountId],
  );
  const occurrence = await db.query<{ id: string }>(
    `insert into todo_occurrences(todo_id,occurrence_key,status,triggered_at)
     values($1,'http-test','TRIGGERED',now()) returning id`,
    [todo.rows[0]!.id],
  );
  const event = await db.query<{ id: string }>(
    `insert into trigger_events(account_id,todo_id,occurrence_id,occurrence_key,content,source_type)
     values($1,$2,$3,'http-test','Notification','TIME') returning id`,
    [accountId, todo.rows[0]!.id, occurrence.rows[0]!.id],
  );
  await db.query(
    `insert into notification_inbox(account_id,trigger_event_id,payload)
     values($1,$2,'{}')`,
    [accountId, event.rows[0]!.id],
  );
  return event.rows[0]!.id;
}
