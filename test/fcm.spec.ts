import { fetchWithTimeout } from "../src/common/fetch-timeout";
import { FcmService } from "../src/notifications/fcm.service";

describe("FCM transport timeout", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test("aborts a hung provider request", async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as typeof fetch;
    const pending = fetchWithTimeout("https://fcm.example", {}, 100);
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await jest.advanceTimersByTimeAsync(100);
    await rejection;
  });
});

describe("FCM configuration diagnostics", () => {
  test("reports missing credentials without attempting provider delivery", async () => {
    const fcm = new FcmService({ value: {} } as any);

    expect(fcm.status()).toEqual({
      configured: false,
      credentialStatus: "not_configured",
    });
    await expect(fcm.send("token", {})).resolves.toMatchObject({
      ok: false,
      code: "FCM_NOT_CONFIGURED",
    });
  });
});
