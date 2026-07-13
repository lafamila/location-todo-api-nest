import { OutboxWorkerService } from "../src/notifications/outbox-worker.service";

describe("outbox worker recovery", () => {
  test("contains startup database recovery failures", async () => {
    const worker = new OutboxWorkerService(
      { value: { workerEnabled: true, workerPollMs: 1000 } } as any,
      {
        query: jest.fn().mockRejectedValue(new Error("database offline")),
      } as any,
      {} as any,
      {} as any,
    );
    await expect((worker as any).recover()).resolves.toBeUndefined();
  });
});
