import { RealtimeService } from "../src/realtime/realtime.service";

describe("realtime session authority", () => {
  const accountId = "8e582c64-0cf1-4c90-9a44-ff91e98f40a4";
  const deviceId = "42510fd1-27a1-4e7c-995a-b83f08fd2748";

  test.each(["logout", "revocation", "idle expiry", "absolute expiry"])(
    "disconnects a socket after %s before delivery",
    async () => {
      const sessions = {
        validateExisting: jest.fn().mockRejectedValue(new Error("expired")),
      };
      const db = databaseStub();
      const socket = socketStub("invalid", accountId, deviceId);
      const service = new RealtimeService(sessions as any, db as any);
      service.attach(namespaceStub([socket]) as any);

      await expect(
        service.emit(accountId, deviceId, { type: "TODO_TRIGGERED" }),
      ).resolves.toBe(0);
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    },
  );

  test("delivers only to the active session bound to the target device", async () => {
    const sessions = {
      validateExisting: jest.fn(async (token: string) => ({
        account: { id: accountId },
        deviceId: token === "target" ? deviceId : "different-device",
      })),
    };
    const target = socketStub("target", accountId, deviceId);
    const other = socketStub("other", accountId, "different-device");
    const service = new RealtimeService(sessions as any, databaseStub() as any);
    service.attach(namespaceStub([target, other]) as any);

    await expect(
      service.emit(accountId, deviceId, { eventId: "event" }),
    ).resolves.toBe(1);
    expect(target.emit).toHaveBeenCalledWith("notification", {
      eventId: "event",
    });
    expect(other.emit).not.toHaveBeenCalled();
    expect(other.disconnect).toHaveBeenCalledWith(true);
  });

  test("contains adapter failures during the periodic sweep", async () => {
    const service = new RealtimeService(
      { validateExisting: jest.fn() } as any,
      databaseStub() as any,
    );
    service.attach({
      fetchSockets: jest.fn().mockRejectedValue(new Error("adapter offline")),
    } as any);
    await expect(service.sweep()).resolves.toBeUndefined();
  });
});

function socketStub(token: string, accountId: string, deviceId: string) {
  return {
    data: {
      locationTodoSessionToken: token,
      locationTodoAccountId: accountId,
      locationTodoDeviceId: deviceId,
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function namespaceStub(sockets: ReturnType<typeof socketStub>[]) {
  return {
    in: jest.fn(() => ({ fetchSockets: jest.fn(async () => sockets) })),
    fetchSockets: jest.fn(async () => sockets),
  };
}

function databaseStub() {
  return {
    listen: jest.fn(),
    notify: jest.fn(),
    query: jest.fn(),
  };
}
