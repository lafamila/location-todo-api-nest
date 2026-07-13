import { EventEmitter } from "node:events";
import { DatabaseService } from "../src/database/database.service";

describe("PostgreSQL notification listener", () => {
  afterEach(() => jest.useRealTimers());

  test("reconnects after connection error and continues receiving", async () => {
    jest.useFakeTimers();
    const first = clientStub();
    const second = clientStub();
    const pool = {
      connect: jest
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    };
    const db = Object.create(DatabaseService.prototype) as DatabaseService;
    (db as any).pool = pool;
    const receive = jest.fn();

    const unsubscribe = await db.listen("location_todo_test", receive);
    expect(first.query).toHaveBeenCalledWith("listen location_todo_test");
    first.emit("error", new Error("connection lost"));
    await jest.advanceTimersByTimeAsync(250);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    second.emit("notification", {
      channel: "location_todo_test",
      payload: "message",
    });
    expect(receive).toHaveBeenCalledWith("message");

    await unsubscribe();
    expect(second.query).toHaveBeenCalledWith("unlisten location_todo_test");
    expect(second.release).toHaveBeenCalledWith(false);
  });
});

function clientStub() {
  const client = new EventEmitter() as EventEmitter & {
    query: jest.Mock;
    release: jest.Mock;
  };
  client.query = jest.fn(async () => undefined);
  client.release = jest.fn();
  return client;
}
