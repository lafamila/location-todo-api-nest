import { randomUUID } from "node:crypto";
import { AuthAccount, ServiceSession } from "../src/auth/auth.types";
import { SessionService } from "../src/auth/session.service";
import { TokenCipher } from "../src/auth/token-cipher";
import { ConfigService } from "../src/config/config.service";
import { DatabaseService } from "../src/database/database.service";
import { DeviceService } from "../src/devices/device.service";
import { GeofenceService } from "../src/geofences/geofence.service";
import { KakaoService } from "../src/kakao/kakao.service";
import { DueWorkerService } from "../src/notifications/due-worker.service";
import { NotificationService } from "../src/notifications/notification.service";
import { OutboxWorkerService } from "../src/notifications/outbox-worker.service";
import { TriggerService } from "../src/notifications/trigger.service";
import { QuotaService } from "../src/quota/quota.service";
import { RetentionService } from "../src/retention/retention.service";
import { TodoService } from "../src/todos/todo.service";
import { TransitionService } from "../src/transitions/transition.service";

describe("PostgreSQL authority integration", () => {
  let config: ConfigService;
  let db: DatabaseService;
  let quota: QuotaService;
  let geofences: GeofenceService;
  let todos: TodoService;
  let triggers: TriggerService;
  let notifications: NotificationService;
  let transitions: TransitionService;
  let sessions: SessionService;
  let cipher: TokenCipher;
  let devices: DeviceService;
  let verifyAccessToken: jest.Mock;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("TEST_DATABASE_URL is required for e2e tests");
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.WORKER_ENABLED = "false";
    process.env.LOCATION_TODO_OIDC_CLIENT_SECRET = "test-client-secret";
    config = new ConfigService();
    db = new DatabaseService(config);
    quota = new QuotaService(db);
    geofences = new GeofenceService(db, quota);
    todos = new TodoService(db, quota, config);
    triggers = new TriggerService();
    notifications = new NotificationService(db);
    transitions = new TransitionService(db, triggers);
    cipher = new TokenCipher(config);
    verifyAccessToken = jest.fn();
    sessions = new SessionService(
      config,
      db,
      { verifyAccessToken } as any,
      cipher,
    );
    devices = new DeviceService(db);
  });

  beforeEach(async () => {
    await db.query("truncate table accounts cascade");
    global.fetch = originalFetch;
    verifyAccessToken.mockReset();
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await db.onModuleDestroy();
  });

  test("serializes visitor geofence quota under concurrent create", async () => {
    const account = await seedAccount(db, "visitor");
    const input = {
      name: "Office",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    };
    const results = await Promise.allSettled([
      geofences.create(account, input),
      geofences.create(account, { ...input, name: "Home" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason.getResponse()).toMatchObject({
      error: { code: "QUOTA_EXCEEDED" },
    });
    expect((await quota.get(account)).savedGeofences).toEqual({
      used: 1,
      limit: 1,
    });
  });

  test("enforces the visitor, user, and superadmin quota matrix", async () => {
    const visitor = await seedAccount(db, "visitor");
    const user = await seedAccount(db, "user");
    const superadmin = await seedAccount(db, "superadmin");
    await seedQuotaRows(db, visitor.id, 3, 1);
    await seedQuotaRows(db, user.id, 20, 5);
    await seedQuotaRows(db, superadmin.id, 25, 20);
    expect(await quota.get(visitor)).toMatchObject({
      locationTodos: { used: 3, limit: 3 },
      savedGeofences: { used: 1, limit: 1 },
    });
    expect(await quota.get(user)).toMatchObject({
      locationTodos: { used: 20, limit: 20 },
      savedGeofences: { used: 5, limit: 5 },
    });
    expect(await quota.get(superadmin)).toMatchObject({
      locationTodos: { used: 25, limit: null },
      savedGeofences: { used: 20, limit: 20 },
    });
    await expect(
      db.transaction((query) =>
        quota.assertAvailable(visitor, "locationTodo", query),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.transaction((query) =>
        quota.assertAvailable(user, "savedGeofence", query),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.transaction((query) =>
        quota.assertAvailable(superadmin, "locationTodo", query),
      ),
    ).resolves.toBeUndefined();
  });

  test("allows unlimited time TODOs without consuming location quota", async () => {
    const account = await seedAccount(db, "visitor");
    for (let index = 0; index < 5; index += 1) {
      await todos.create(account, {
        content: `Time ${index}`,
        recurrence: { type: "DAILY", startDate: "2020-01-01" },
        localTime: "23:59",
      });
    }
    const result = await quota.get(account);
    expect(result.timeTodos).toEqual({ used: 5, limit: null });
    expect(result.locationTodos).toEqual({ used: 0, limit: 3 });
  });

  test("derives reminder behavior from saved places and supports conversion", async () => {
    const account = await seedAccount(db, "user");
    const time = await todos.create(account, {
      content: "Morning reminder",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      localTime: "09:00",
      geofenceIds: [],
    });
    expect(time).not.toHaveProperty("kind");
    expect(time).not.toHaveProperty("timezone");
    expect(time.geofenceIds).toEqual([]);

    const geofence = await geofences.create(account, {
      name: "Home",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const location = await todos.update(account, time.id, {
      content: "Arrive home",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
      version: time.version,
    });
    expect(location.localTime).toBeNull();
    expect(location.geofenceIds).toEqual([geofence.id]);
    expect((await quota.get(account)).locationTodos.used).toBe(1);

    const converted = await todos.update(account, time.id, {
      content: "Evening reminder",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      localTime: "18:00",
      geofenceIds: [],
      version: location.version,
    });
    expect(converted.localTime).toBe("18:00");
    expect(converted.geofenceIds).toEqual([]);
    const quotas = await quota.get(account);
    expect(quotas.locationTodos.used).toBe(0);
    expect(quotas.timeTodos.used).toBe(1);
  });

  test("requires outside before entry, ACKs replay, and emits one event across two devices", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Office",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Arrive at office",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
      scheduleWindows: [],
    });
    const first = await seedDeviceSession(db, account, "ios");
    const second = await seedDeviceSession(db, account, "android");
    const unarmed = event(1, geofence.id, "ENTER");
    expect(
      (await transitions.upload(first, { events: [unarmed] })).acks[0]
        ?.disposition,
    ).toBe("ENTER_NOT_ARMED");
    expect(
      (await transitions.upload(first, { events: [unarmed] })).acks[0]?.status,
    ).toBe("DUPLICATE");
    await Promise.all([
      transitions.upload(first, { events: [event(2, geofence.id, "EXIT")] }),
      transitions.upload(second, { events: [event(1, geofence.id, "EXIT")] }),
    ]);
    const settled = await Promise.allSettled([
      transitions.upload(first, { events: [event(3, geofence.id, "ENTER")] }),
      transitions.upload(second, { events: [event(2, geofence.id, "ENTER")] }),
    ]);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    const results = settled.map(
      (result) => (result as PromiseFulfilledResult<{ acks: any[] }>).value,
    );
    expect(
      results
        .flatMap((result) => result.acks)
        .some((ack) => ack.disposition === "TRIGGERED"),
    ).toBe(true);
    const events = await db.query<{ count: number }>(
      "select count(*)::int count from trigger_events where todo_id=$1",
      [todo.id],
    );
    const inbox = await db.query<{ count: number }>(
      "select count(*)::int count from notification_inbox where account_id=$1",
      [account.id],
    );
    const outbox = await db.query<{ count: number }>(
      "select count(*)::int count from notification_outbox where trigger_event_id in (select id from trigger_events where todo_id=$1)",
      [todo.id],
    );
    expect(events.rows[0]?.count).toBe(1);
    expect(inbox.rows[0]?.count).toBe(1);
    expect(outbox.rows[0]?.count).toBe(2);
  });

  test("recovers and emits an overdue time occurrence once", async () => {
    const account = await seedAccount(db, "visitor");
    const todoId = randomUUID();
    const occurrenceId = randomUUID();
    await db.query(
      `insert into todos(id,account_id,content,recurrence_type,recurrence_start_date,local_time)
       values($1,$2,'Overdue','ONCE','2020-01-01','09:00')`,
      [todoId, account.id],
    );
    await db.query(
      `insert into todo_occurrences(id,todo_id,occurrence_key,due_at) values($1,$2,'2020-01-01T09:00',now()-interval '1 day')`,
      [occurrenceId, todoId],
    );
    await db.query(
      `insert into due_jobs(occurrence_id,kind,due_at) values($1,'TIME',now()-interval '1 day')`,
      [occurrenceId],
    );
    const worker = new DueWorkerService(config, db, triggers);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    const events = await db.query<{ count: number }>(
      "select count(*)::int count from trigger_events where todo_id=$1",
      [todoId],
    );
    expect(events.rows[0]?.count).toBe(1);
  });

  test("cancels dwell before maturity but recognizes matured offline evidence", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Cafe",
      address: "Seoul",
      latitude: 37.51,
      longitude: 127.01,
      radiusMeters: 150,
    });
    const todo = await todos.create(account, {
      content: "Stay at cafe",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "DWELL", dwellMinutes: 10 },
      geofenceIds: [geofence.id],
    });
    const session = await seedDeviceSession(db, account, "ios");
    const base = Date.now() - 40 * 60_000;
    await db.query("update todos set activated_at=$2 where id=$1", [
      todo.id,
      new Date(base - 1000),
    ]);
    const first = [
      timedEvent(1, geofence.id, "EXIT", base),
      timedEvent(2, geofence.id, "ENTER", base + 60_000),
      timedEvent(3, geofence.id, "EXIT", base + 5 * 60_000),
    ];
    await transitions.upload(session, { events: first });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await transitions.upload(session, {
      events: [
        timedEvent(4, geofence.id, "ENTER", base + 6 * 60_000),
        timedEvent(5, geofence.id, "EXIT", base + 18 * 60_000),
      ],
    });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  test("does not cancel delayed entry when an exit arrives", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Station",
      address: "Seoul",
      latitude: 37.52,
      longitude: 127.02,
      radiusMeters: 150,
    });
    const todo = await todos.create(account, {
      content: "Leave station",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_DELAYED", delayMinutes: 1 },
      geofenceIds: [geofence.id],
    });
    const session = await seedDeviceSession(db, account, "android");
    const base = Date.now() - 5 * 60_000;
    await db.query("update todos set activated_at=$2 where id=$1", [
      todo.id,
      new Date(base - 1000),
    ]);
    await transitions.upload(session, {
      events: [
        timedEvent(1, geofence.id, "EXIT", base),
        timedEvent(2, geofence.id, "ENTER", base + 60_000),
        timedEvent(3, geofence.id, "EXIT", base + 90_000),
      ],
    });
    const worker = new DueWorkerService(config, db, triggers);
    expect(await worker.runOnce()).toBe(true);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  test("acknowledges inbox rows by account-scoped trigger event ID", async () => {
    const firstAccount = await seedAccount(db, "user");
    const secondAccount = await seedAccount(db, "user");
    const firstEventId = await seedNotification(db, triggers, firstAccount.id);
    const secondEventId = await seedNotification(
      db,
      triggers,
      secondAccount.id,
    );

    await expect(
      notifications.acknowledge(firstAccount.id, []),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      notifications.acknowledge(firstAccount.id, ["not-a-uuid"]),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      notifications.acknowledge(firstAccount.id, [firstEventId, secondEventId]),
    ).resolves.toEqual({ acknowledged: 1 });
    await expect(
      notifications.acknowledge(firstAccount.id, [firstEventId]),
    ).resolves.toEqual({ acknowledged: 1 });

    const firstInbox = await notifications.list(firstAccount.id);
    const secondInbox = await notifications.list(secondAccount.id);
    expect(firstInbox.notifications).toHaveLength(1);
    expect(firstInbox.notifications[0]).toMatchObject({
      eventId: firstEventId,
      acknowledgedAt: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(firstInbox.notifications[0]).not.toHaveProperty("id");
    expect(secondInbox.notifications[0]).toMatchObject({
      eventId: secondEventId,
      acknowledgedAt: null,
    });
  });

  test("rejects desktop and spoofed sessions before transition state mutation", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Desktop boundary",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    await todos.create(account, {
      content: "Mobile only",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const desktop = await seedDeviceSession(db, account, "macos");
    await expect(
      transitions.upload(desktop, {
        events: [event(1, geofence.id, "EXIT")],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      transitions.upload(
        { ...desktop, platform: "ios", source: "header" },
        { events: [event(1, geofence.id, "EXIT")] },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from transition_events where account_id=$1",
          [account.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  test("terminally ignores nonexistent and foreign geofence evidence", async () => {
    const account = await seedAccount(db, "user");
    const foreignAccount = await seedAccount(db, "user");
    const foreign = await geofences.create(foreignAccount, {
      name: "Foreign",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const session = await seedDeviceSession(db, account, "ios");
    const missing = randomUUID();
    const result = await transitions.upload(session, {
      events: [event(1, missing, "EXIT"), event(2, foreign.id, "ENTER")],
    });
    expect(result.acks).toEqual([
      expect.objectContaining({
        status: "IGNORED",
        disposition: "GEOFENCE_UNAVAILABLE",
      }),
      expect.objectContaining({
        status: "IGNORED",
        disposition: "GEOFENCE_UNAVAILABLE",
      }),
    ]);
    const audit = await db.query<{ account_id: string; geofence_id: string }>(
      `select account_id,geofence_id from transition_events where device_id=$1 order by device_sequence`,
      [session.deviceId],
    );
    expect(audit.rows).toEqual([
      { account_id: account.id, geofence_id: missing },
      { account_id: account.id, geofence_id: foreign.id },
    ]);
  });

  test("rejects replay conflicts and lower cross-batch sequences without mutating state", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Replay",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Replay authority",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const session = await seedDeviceSession(db, account, "ios");
    const first = event(10, geofence.id, "EXIT");
    await transitions.upload(session, { events: [first] });
    await expect(
      transitions.upload(session, {
        events: [{ ...first, id: randomUUID(), transition: "ENTER" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitions.upload(session, {
        events: [{ ...first, sequence: 11, transition: "ENTER" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitions.upload(session, {
        events: [event(9, geofence.id, "ENTER")],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const state = await db.query<{ state: string; armed: boolean }>(
      `select state,armed from device_geofence_states where todo_id=$1 and device_id=$2 and geofence_id=$3`,
      [todo.id, session.deviceId, geofence.id],
    );
    expect(state.rows[0]).toMatchObject({ state: "outside", armed: true });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from transition_events where device_id=$1",
          [session.deviceId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  test("retains idempotency and sequence authority after transition audit purge", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Retention",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const session = await seedDeviceSession(db, account, "android");
    const accepted = event(30, geofence.id, "EXIT");
    await transitions.upload(session, { events: [accepted] });
    await db.query("delete from transition_events where device_id=$1", [
      session.deviceId,
    ]);
    expect(
      (await transitions.upload(session, { events: [accepted] })).acks[0]
        ?.status,
    ).toBe("DUPLICATE");
    await expect(
      transitions.upload(session, {
        events: [event(29, geofence.id, "EXIT")],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitions.upload(session, {
        events: [{ ...accepted, sequence: 31, transition: "ENTER" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("does not evaluate inactive-period queued events after reactivation", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Activation",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Activation boundary",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const inactive = await todos.setActive(
      account.id,
      todo.id,
      false,
      todo.version,
    );
    const capturedAt = Date.now();
    await delay(5);
    await todos.setActive(account.id, todo.id, true, inactive.version);
    const result = await transitions.upload(
      await seedDeviceSession(db, account, "ios"),
      {
        events: [
          timedEvent(1, geofence.id, "EXIT", capturedAt),
          timedEvent(2, geofence.id, "ENTER", capturedAt + 1),
        ],
      },
    );
    expect(result.acks.map((ack) => ack.disposition)).toEqual([
      "BEFORE_ACTIVATION",
      "BEFORE_ACTIVATION",
    ]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  test("does not evaluate queued events against edited monitoring authority", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Edit",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Before edit",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const capturedAt = Date.now();
    await delay(5);
    await todos.update(account, todo.id, {
      content: "After edit",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
      version: todo.version,
    });
    const result = await transitions.upload(
      await seedDeviceSession(db, account, "android"),
      {
        events: [
          timedEvent(1, geofence.id, "EXIT", capturedAt),
          timedEvent(2, geofence.id, "ENTER", capturedAt + 1),
        ],
      },
    );
    expect(
      result.acks.every((ack) => ack.disposition === "BEFORE_ACTIVATION"),
    ).toBe(true);
  });

  test("invalidates queued events when a linked geofence definition changes", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Old coordinates",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    await todos.create(account, {
      content: "Geofence edit boundary",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const capturedAt = Date.now();
    await delay(5);
    await geofences.update(account.id, geofence.id, {
      name: "New coordinates",
      address: "Busan",
      latitude: 35.1796,
      longitude: 129.0756,
      radiusMeters: 300,
      version: geofence.version,
    });
    const result = await transitions.upload(
      await seedDeviceSession(db, account, "ios"),
      {
        events: [
          timedEvent(1, geofence.id, "EXIT", capturedAt),
          timedEvent(2, geofence.id, "ENTER", capturedAt + 1),
        ],
      },
    );
    expect(
      result.acks.every((ack) => ack.disposition === "BEFORE_ACTIVATION"),
    ).toBe(true);
  });

  test("serializes lifecycle cancellation ahead of a waiting ENTER", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Race",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Race authority",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const session = await seedDeviceSession(db, account, "ios");
    await transitions.upload(session, {
      events: [event(1, geofence.id, "EXIT")],
    });
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => (release = resolve));
    const lockedGate = new Promise<void>((resolve) => (locked = resolve));
    const lifecycle = db.transaction(async (query) => {
      await query("select id from todos where id=$1 for update", [todo.id]);
      await query(
        `update todos set active=false,lifecycle_status='INACTIVE',activation_generation=activation_generation+1 where id=$1`,
        [todo.id],
      );
      locked();
      await releaseGate;
    });
    await lockedGate;
    const enter = transitions.upload(session, {
      events: [event(2, geofence.id, "ENTER")],
    });
    await delay(20);
    release();
    await lifecycle;
    expect((await enter).acks[0]?.disposition).toBe("NO_ACTIVE_TODO");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  test("keeps mixed undated ONCE windows open and supports reactivation", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Once",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const todo = await todos.create(account, {
      content: "Open once",
      recurrence: { type: "ONCE", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
      scheduleWindows: [
        { startTime: "00:00", endTime: "24:00" },
        { date: tomorrow, startTime: "00:00", endTime: "24:00" },
      ],
    });
    const session = await seedDeviceSession(db, account, "android");
    await transitions.upload(session, {
      events: [event(1, geofence.id, "EXIT"), event(2, geofence.id, "ENTER")],
    });
    const triggered = await todos.get(account.id, todo.id);
    expect(triggered.lifecycleStatus).toBe("TRIGGERED");
    await expect(
      todos.setActive(account.id, todo.id, false, triggered.version),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      todos.setActive(account.id, todo.id, true, triggered.version),
    ).rejects.toMatchObject({ status: 409 });
    await todos.reactivate(account, todo.id, triggered.version);
    await transitions.upload(session, {
      events: [event(3, geofence.id, "EXIT"), event(4, geofence.id, "ENTER")],
    });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from trigger_events where todo_id=$1",
          [todo.id],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  test("rejects activation when a terminal location TODO lost its geofence", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Disposable",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Needs geofence",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const completed = await todos.complete(account.id, todo.id, todo.version);
    await geofences.remove(account.id, geofence.id, geofence.version);
    await expect(
      todos.reactivate(account, todo.id, completed.version),
    ).rejects.toMatchObject({ status: 409 });
    expect((await todos.get(account.id, todo.id)).lifecycleStatus).toBe(
      "COMPLETED",
    );
  });

  test("serializes geofence deletion against location TODO reactivation", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Concurrent",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Concurrent activation",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_IMMEDIATE" },
      geofenceIds: [geofence.id],
    });
    const completed = await todos.complete(account.id, todo.id, todo.version);
    const results = await Promise.allSettled([
      todos.reactivate(account, todo.id, completed.version),
      geofences.remove(account.id, geofence.id, geofence.version),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const graph = await db.query<{ count: number }>(
      `select count(*)::int count from todos t join todo_geofences tg on tg.todo_id=t.id
       join saved_geofences g on g.id=tg.geofence_id
       where t.id=$1 and t.active and t.deleted_at is null and g.deleted_at is not null`,
      [todo.id],
    );
    expect(graph.rows[0]?.count).toBe(0);
  });

  test("revives a cancelled delayed job after explicit terminal reactivation", async () => {
    const account = await seedAccount(db, "user");
    const geofence = await geofences.create(account, {
      name: "Delayed",
      address: "Seoul",
      latitude: 37.5,
      longitude: 127,
      radiusMeters: 200,
    });
    const todo = await todos.create(account, {
      content: "Delayed reactivation",
      recurrence: { type: "DAILY", startDate: "2020-01-01" },
      triggerCondition: { type: "ENTRY_DELAYED", delayMinutes: 10 },
      geofenceIds: [geofence.id],
    });
    const session = await seedDeviceSession(db, account, "android");
    await transitions.upload(session, {
      events: [event(1, geofence.id, "EXIT"), event(2, geofence.id, "ENTER")],
    });
    const completed = await todos.complete(account.id, todo.id, todo.version);
    await todos.reactivate(account, todo.id, completed.version);
    const result = await transitions.upload(session, {
      events: [event(3, geofence.id, "EXIT"), event(4, geofence.id, "ENTER")],
    });
    expect(result.acks[1]?.disposition).toBe("DELAYED_SCHEDULED");
    expect(
      (
        await db.query<{ status: string }>(
          `select j.status from due_jobs j join todo_occurrences o on o.id=j.occurrence_id
           where o.todo_id=$1 and j.kind='DELAYED'`,
          [todo.id],
        )
      ).rows[0]?.status,
    ).toBe("PENDING");
  });

  test("rejects past TIME ONCE edits and unschedulable terminal reactivation", async () => {
    const account = await seedAccount(db, "user");
    const daily = await todos.create(account, timeTodoInput("Editable"));
    await expect(
      todos.update(account, daily.id, {
        content: "Past once",
        recurrence: { type: "ONCE", startDate: "2020-01-01" },
        localTime: "09:00",
        version: daily.version,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const terminal = await db.query<{ id: string }>(
      `insert into todos(account_id,content,recurrence_type,recurrence_start_date,local_time,
       active,lifecycle_status,last_triggered_at)
       values($1,'Past triggered','ONCE','2020-01-01','09:00',false,'TRIGGERED',now()) returning id`,
      [account.id],
    );
    await expect(
      todos.reactivate(account, terminal.rows[0]!.id, 1),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await todos.get(account.id, terminal.rows[0]!.id)).lifecycleStatus,
    ).toBe("TRIGGERED");
  });

  test("claims login callback once and binds web callback to its browser nonce", async () => {
    const account = await seedAccount(db, "user");
    const native = await sessions.start({
      clientKind: "native",
      installationId: randomUUID(),
      platform: "ios",
      appVersion: "1.0",
    });
    const state = new URL(native.authorizeUrl).searchParams.get("state")!;
    global.fetch = jest.fn(async () =>
      response(200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      }),
    ) as any;
    verifyAccessToken.mockResolvedValue(account);
    const results = await Promise.all([
      sessions.callback({ code: "code", state }),
      sessions.callback({ code: "code", state }),
    ]);
    expect(results.filter((result) => result.issue)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode)).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from app_sessions where account_id=$1",
          [account.id],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const web = await sessions.start({ clientKind: "web" });
    const webState = new URL(web.authorizeUrl).searchParams.get("state")!;
    await expect(
      sessions.callback({ code: "code", state: webState }),
    ).resolves.toMatchObject({ errorCode: "LOGIN_BROWSER_MISMATCH" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("reconciles fresh-login downgrades while preserving application history", async () => {
    global.fetch = jest.fn(async () =>
      response(200, {
        access_token: "fresh-visitor-access",
        refresh_token: "fresh-visitor-refresh",
        expires_in: 3600,
      }),
    ) as any;
    for (const [existingStatus, expectedStatus] of [
      ["approved", null],
      ["pending", "pending"],
      ["rejected", "rejected"],
    ] as const) {
      const account = await seedAccount(db, "user");
      await db.query("update accounts set upgrade_status=$2 where id=$1", [
        account.id,
        existingStatus,
      ]);
      verifyAccessToken.mockResolvedValue({
        ...account,
        permission: "visitor",
      });
      const login = await sessions.start({
        clientKind: "native",
        installationId: randomUUID(),
        platform: "ios",
        appVersion: "1.0",
      });
      const state = new URL(login.authorizeUrl).searchParams.get("state")!;
      await expect(
        sessions.callback({ code: "fresh-login-code", state }),
      ).resolves.toMatchObject({
        issue: { session: { account: { permission: "visitor" } } },
      });
      expect(
        (
          await db.query<{ permission: string; upgrade_status: string | null }>(
            "select permission,upgrade_status from accounts where id=$1",
            [account.id],
          )
        ).rows[0],
      ).toEqual({ permission: "visitor", upgrade_status: expectedStatus });
    }
  });

  test("purges rejected refresh families and reconciles refreshed permission", async () => {
    const visitor = await seedAccount(db, "visitor");
    const raw = "refreshable-session";
    const sessionId = await seedAppSession(db, cipher, visitor.id, raw, "web");
    const user = { ...visitor, permission: "user" as const };
    verifyAccessToken.mockResolvedValue(user);
    global.fetch = jest.fn(async () =>
      response(200, {
        access_token: "approved-access",
        refresh_token: "approved-refresh",
        expires_in: 3600,
      }),
    ) as any;
    const refreshed = await Promise.all([
      sessions.authenticate(raw, "header"),
      sessions.authenticate(raw, "header"),
    ]);
    expect(refreshed.map((value) => value.account.permission)).toEqual([
      "user",
      "user",
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query<{ upgrade_status: string; idle_expires_at: Date }>(
          `select a.upgrade_status,s.idle_expires_at from accounts a join app_sessions s on s.account_id=a.id where s.id=$1`,
          [sessionId],
        )
      ).rows[0],
    ).toMatchObject({ upgrade_status: "approved" });

    await db.query(
      "update app_sessions set access_token_expires_at=now()-interval '1 minute' where id=$1",
      [sessionId],
    );
    verifyAccessToken.mockResolvedValue(visitor);
    global.fetch = jest.fn(async () =>
      response(200, {
        access_token: "downgraded-access",
        refresh_token: "downgraded-refresh",
        expires_in: 3600,
      }),
    ) as any;
    await expect(sessions.authenticate(raw, "header")).resolves.toMatchObject({
      account: { permission: "visitor" },
    });
    expect(
      (
        await db.query<{ upgrade_status: string | null }>(
          "select upgrade_status from accounts where id=$1",
          [visitor.id],
        )
      ).rows[0]?.upgrade_status,
    ).toBeNull();

    const rejectedRaw = "rejected-session";
    const rejectedId = await seedAppSession(
      db,
      cipher,
      visitor.id,
      rejectedRaw,
      "web",
    );
    global.fetch = jest.fn(async () => response(401, {})) as any;
    await expect(
      sessions.authenticate(rejectedRaw, "header"),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from app_sessions where id=$1",
          [rejectedId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await expect(
      sessions.authenticate(rejectedRaw, "header"),
    ).rejects.toMatchObject({ status: 401 });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const unavailableRaw = "unavailable-session";
    const unavailableId = await seedAppSession(
      db,
      cipher,
      visitor.id,
      unavailableRaw,
      "web",
    );
    global.fetch = jest
      .fn()
      .mockRejectedValue(new DOMException("timed out", "AbortError")) as any;
    await expect(
      sessions.authenticate(unavailableRaw, "header"),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from app_sessions where id=$1",
          [unavailableId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  test("persists permanent permission application rejection", async () => {
    const visitor = await seedAccount(db, "visitor");
    global.fetch = jest.fn(async () => response(403, {})) as any;
    await expect(
      sessions.requestUpgrade(serviceSession(visitor), "Please approve"),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await db.query<{ upgrade_status: string }>(
          "select upgrade_status from accounts where id=$1",
          [visitor.id],
        )
      ).rows[0]?.upgrade_status,
    ).toBe("rejected");
  });

  test("binds registration to immutable session and installation platforms", async () => {
    const account = await seedAccount(db, "user");
    const raw = "desktop-session";
    const sessionId = await seedAppSession(
      db,
      cipher,
      account.id,
      raw,
      "macos",
    );
    const desktop = {
      ...serviceSession(account),
      id: sessionId,
      platform: "macos" as const,
    };
    await expect(
      devices.register(desktop, {
        installationId: randomUUID(),
        platform: "ios",
        appVersion: "1.0",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      devices.register(
        { ...desktop, platform: "ios" },
        {
          installationId: randomUUID(),
          platform: "ios",
          appVersion: "1.0",
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("atomically rotates a push token across accounts and reports persisted state", async () => {
    const firstAccount = await seedAccount(db, "user");
    const secondAccount = await seedAccount(db, "user");
    const firstId = await seedAppSession(
      db,
      cipher,
      firstAccount.id,
      "first-mobile",
      "ios",
    );
    const secondId = await seedAppSession(
      db,
      cipher,
      secondAccount.id,
      "second-mobile",
      "ios",
    );
    const firstSession = {
      ...serviceSession(firstAccount),
      id: firstId,
      platform: "ios" as const,
    };
    const secondSession = {
      ...serviceSession(secondAccount),
      id: secondId,
      platform: "ios" as const,
    };
    const first = await devices.register(firstSession, {
      installationId: "first-installation",
      platform: "ios",
      appVersion: "1.0",
      pushToken: "shared-token",
    });
    const persisted = await devices.register(firstSession, {
      installationId: "first-installation",
      platform: "ios",
      appVersion: "1.1",
    });
    expect(persisted.pushTokenRegistered).toBe(true);
    const second = await devices.register(secondSession, {
      installationId: "second-installation",
      platform: "ios",
      appVersion: "1.0",
      pushToken: "shared-token",
    });
    const rows = await db.query<{ id: string; push_token: string | null }>(
      `select id,push_token from devices where id=any($1::uuid[]) order by id`,
      [[first.id, second.id]],
    );
    expect(rows.rows.find((row) => row.id === first.id)?.push_token).toBeNull();
    expect(rows.rows.find((row) => row.id === second.id)?.push_token).toBe(
      "shared-token",
    );
  });

  test("serializes simultaneous cross-account push token registration", async () => {
    const firstAccount = await seedAccount(db, "user");
    const secondAccount = await seedAccount(db, "user");
    const firstId = await seedAppSession(
      db,
      cipher,
      firstAccount.id,
      "first-race-mobile",
      "ios",
    );
    const secondId = await seedAppSession(
      db,
      cipher,
      secondAccount.id,
      "second-race-mobile",
      "ios",
    );
    const registrations = await Promise.all([
      devices.register(
        {
          ...serviceSession(firstAccount),
          id: firstId,
          platform: "ios",
        },
        {
          installationId: "first-race-installation",
          platform: "ios",
          appVersion: "1.0",
          pushToken: "racing-token",
        },
      ),
      devices.register(
        {
          ...serviceSession(secondAccount),
          id: secondId,
          platform: "ios",
        },
        {
          installationId: "second-race-installation",
          platform: "ios",
          appVersion: "1.0",
          pushToken: "racing-token",
        },
      ),
    ]);
    expect(registrations).toHaveLength(2);
    const owners = await db.query<{ count: number }>(
      "select count(*)::int count from devices where push_token='racing-token'",
    );
    expect(owners.rows[0]?.count).toBe(1);
  });

  test("counts every TIME TODO mutation and enforces the database limit", async () => {
    const account = await seedAccount(db, "visitor");
    const created = await todos.create(account, timeTodoInput("Rate"));
    await expect(
      todos.reactivate(account, created.id, created.version),
    ).rejects.toMatchObject({ status: 409 });
    const inactive = await todos.setActive(
      account.id,
      created.id,
      false,
      created.version,
    );
    await expect(
      todos.reactivate(account, created.id, inactive.version),
    ).rejects.toMatchObject({ status: 409 });
    const active = await todos.setActive(
      account.id,
      created.id,
      true,
      inactive.version,
    );
    const completed = await todos.complete(
      account.id,
      created.id,
      active.version,
    );
    await expect(
      todos.setActive(account.id, created.id, false, completed.version),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      todos.setActive(account.id, created.id, true, completed.version),
    ).rejects.toMatchObject({ status: 409 });
    const reactivated = await todos.reactivate(
      account,
      created.id,
      completed.version,
    );
    await todos.remove(account.id, created.id, reactivated.version);
    const deleted = (await todos.list(account.id, true))[0]!;
    await todos.restore(account, created.id, deleted.version);
    expect(
      (
        await db.query<{ count: number }>(
          `select count from rate_limit_counters where scope='time_todo_mutation' and subject=$1`,
          [account.id],
        )
      ).rows[0]?.count,
    ).toBe(7);

    const limited = await seedAccount(db, "visitor");
    const originalLimit = config.value.timeTodoMutationsPerHour;
    config.value.timeTodoMutationsPerHour = 2;
    try {
      await todos.create(limited, timeTodoInput("One"));
      await todos.create(limited, timeTodoInput("Two"));
      await expect(
        todos.create(limited, timeTodoInput("Three")),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      config.value.timeTodoMutationsPerHour = originalLimit;
    }
  });

  test("keeps elapsed one-time TODOs inactive until their schedule is edited", async () => {
    const account = await seedAccount(db, "user");
    const result = await db.query<{ id: string }>(
      `insert into todos(account_id,content,recurrence_type,recurrence_start_date,local_time,active,lifecycle_status)
       values($1,'Elapsed once','ONCE','2020-01-01','00:00',false,'INACTIVE') returning id`,
      [account.id],
    );
    await expect(
      todos.setActive(account.id, result.rows[0]!.id, true, 1),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        error: { code: "ACTIVATION_REQUIRES_FUTURE_SCHEDULE" },
      },
    });
    const persisted = await todos.get(account.id, result.rows[0]!.id);
    expect(persisted.active).toBe(false);
    expect(persisted.lifecycleStatus).toBe("INACTIVE");
    expect(persisted.version).toBe(1);
  });

  test("shares Kakao search limits across service instances", async () => {
    const account = await seedAccount(db, "user");
    const first = new KakaoService(config, db);
    const second = new KakaoService(config, db);
    const attempts = await Promise.allSettled(
      Array.from({ length: 61 }, (_, index) =>
        (index % 2 ? (first as any) : (second as any)).rateLimit(account.id),
      ),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(60);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("periodically reclaims a stale outbox claim after worker restart", async () => {
    const account = await seedAccount(db, "user");
    const device = await db.query<{ id: string }>(
      `insert into devices(account_id,installation_id,platform,app_version,push_token)
       values($1,$2,'ios','1.0','push-token') returning id`,
      [account.id, randomUUID()],
    );
    await seedNotification(db, triggers, account.id);
    const outbox = await db.query<{ id: string }>(
      "select id from notification_outbox where device_id=$1",
      [device.rows[0]!.id],
    );
    await db.query(
      `update notification_outbox set status='SENDING',locked_at=now()-interval '6 minutes' where id=$1`,
      [outbox.rows[0]!.id],
    );
    const send = jest.fn(async () => ({ ok: true, terminal: false }));
    const worker = new OutboxWorkerService(
      config,
      db,
      { send } as any,
      { deliver: jest.fn() } as any,
    );
    expect(await worker.runOnce()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from notification_outbox where id=$1",
          [outbox.rows[0]!.id],
        )
      ).rows[0]?.status,
    ).toBe("SENT");
  });

  test("retention purges expired web refresh secrets but keeps active sessions", async () => {
    const account = await seedAccount(db, "user");
    const expired = await seedAppSession(
      db,
      cipher,
      account.id,
      "expired-retention",
      "web",
    );
    const active = await seedAppSession(
      db,
      cipher,
      account.id,
      "active-retention",
      "web",
    );
    await db.query(
      `update app_sessions set access_token_expires_at=now()+interval '1 hour',
       idle_expires_at=now()+interval '1 day' where id=$1`,
      [active],
    );
    await db.query(
      `update app_sessions set idle_expires_at=now()-interval '1 minute' where id=$1`,
      [expired],
    );
    await new RetentionService(config, db).run();
    const remaining = await db.query<{ id: string }>(
      "select id from app_sessions where account_id=$1",
      [account.id],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([active]);
  });
});

async function seedAccount(
  db: DatabaseService,
  permission: AuthAccount["permission"],
): Promise<AuthAccount> {
  const account: AuthAccount = {
    id: randomUUID(),
    displayName: "Tester",
    email: "tester@example.com",
    permission,
  };
  await db.query(
    "insert into accounts(id,email,display_name,permission) values($1,$2,$3,$4)",
    [account.id, account.email, account.displayName, account.permission],
  );
  return account;
}

async function seedDeviceSession(
  db: DatabaseService,
  account: AuthAccount,
  platform: "ios" | "android" | "macos" | "windows" | "web",
): Promise<ServiceSession> {
  const result = await db.query<{ id: string }>(
    `insert into devices(account_id,installation_id,platform,app_version) values($1,$2,$3,'1.0') returning id`,
    [account.id, randomUUID(), platform],
  );
  const now = Date.now();
  return {
    id: randomUUID(),
    account,
    deviceId: result.rows[0]!.id,
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: new Date(now + 60_000),
    idleExpiresAt: new Date(now + 60_000),
    absoluteExpiresAt: new Date(now + 60_000),
    source: "header",
    platform,
  };
}

async function seedAppSession(
  db: DatabaseService,
  cipher: TokenCipher,
  accountId: string,
  rawToken: string,
  platform: "ios" | "android" | "macos" | "windows" | "web",
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into app_sessions
     (id,account_id,token_hash,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,
      idle_expires_at,absolute_expires_at,client_platform)
     values($1,$2,$3,$4,$5,now()-interval '1 minute',now()+interval '1 day',now()+interval '30 days',$6)`,
    [
      id,
      accountId,
      cipher.hash(rawToken),
      cipher.encrypt("expired-access"),
      cipher.encrypt("refresh-token"),
      platform,
    ],
  );
  return id;
}

function serviceSession(account: AuthAccount): ServiceSession {
  const now = Date.now();
  return {
    id: randomUUID(),
    account,
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: new Date(now + 3_600_000),
    idleExpiresAt: new Date(now + 86_400_000),
    absoluteExpiresAt: new Date(now + 86_400_000),
    source: "header",
    platform: "web",
  };
}

function response(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timeTodoInput(content: string) {
  return {
    content,
    recurrence: { type: "DAILY" as const, startDate: "2020-01-01" },
    localTime: "23:59",
  };
}

function event(
  sequence: number,
  geofenceId: string,
  transition: "ENTER" | "EXIT",
) {
  return {
    id: randomUUID(),
    sequence,
    geofenceId,
    transition,
    observedAt: new Date(Date.now() + sequence * 10).toISOString(),
    accuracyMeters: 10,
  };
}

function timedEvent(
  sequence: number,
  geofenceId: string,
  transition: "ENTER" | "EXIT",
  observedAt: number,
) {
  return {
    id: randomUUID(),
    sequence,
    geofenceId,
    transition,
    observedAt: new Date(observedAt).toISOString(),
    accuracyMeters: 10,
  };
}

async function seedQuotaRows(
  db: DatabaseService,
  accountId: string,
  locationCount: number,
  geofenceCount: number,
): Promise<void> {
  const classificationGeofence = await db.query<{ id: string }>(
    `insert into saved_geofences(account_id,name,address,latitude,longitude,radius_meters,deleted_at)
     values($1,'Classification only','Seoul',37.5,127,100,now()) returning id`,
    [accountId],
  );
  for (let index = 0; index < locationCount; index += 1) {
    const todo = await db.query<{ id: string }>(
      `insert into todos(account_id,content,recurrence_type,recurrence_start_date,trigger_type,active)
       values($1,$2,'DAILY','2020-01-01','ENTRY_IMMEDIATE',$3) returning id`,
      [accountId, `Location ${index}`, index % 2 === 0],
    );
    await db.query(
      `insert into todo_geofences(todo_id,geofence_id) values($1,$2)`,
      [todo.rows[0]!.id, classificationGeofence.rows[0]!.id],
    );
  }
  const deletedTodo = await db.query<{ id: string }>(
    `insert into todos(account_id,content,recurrence_type,recurrence_start_date,trigger_type,deleted_at)
     values($1,'Deleted location','DAILY','2020-01-01','ENTRY_IMMEDIATE',now()) returning id`,
    [accountId],
  );
  await db.query(
    `insert into todo_geofences(todo_id,geofence_id) values($1,$2)`,
    [deletedTodo.rows[0]!.id, classificationGeofence.rows[0]!.id],
  );
  for (let index = 0; index < geofenceCount; index += 1) {
    await db.query(
      `insert into saved_geofences(account_id,name,address,latitude,longitude,radius_meters)
       values($1,$2,'Seoul',37.5,127,100)`,
      [accountId, `Geofence ${index}`],
    );
  }
}

async function seedNotification(
  db: DatabaseService,
  triggers: TriggerService,
  accountId: string,
): Promise<string> {
  const todoId = randomUUID();
  const occurrenceId = randomUUID();
  await db.query(
    `insert into todos(id,account_id,content,recurrence_type,recurrence_start_date,local_time)
     values($1,$2,'Inbox event','ONCE','2026-07-13','17:30')`,
    [todoId, accountId],
  );
  await db.query(
    `insert into todo_occurrences(id,todo_id,occurrence_key,due_at)
     values($1,$2,'2026-07-13T17:30',now())`,
    [occurrenceId, todoId],
  );
  const result = await db.transaction((query) =>
    triggers.emit(query, {
      occurrenceId,
      sourceType: "TIME",
      sourceId: randomUUID(),
    }),
  );
  if (!result.eventId) throw new Error("Notification seed did not emit");
  return result.eventId;
}
