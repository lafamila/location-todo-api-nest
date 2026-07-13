import { fetchWithTimeout } from "../src/common/fetch-timeout";

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
