import { KakaoService } from "../src/kakao/kakao.service";

describe("Kakao transport failures", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("maps a provider timeout to the public unavailable contract", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    const service = new KakaoService(
      {
        value: {
          kakaoRestApiKey: "test-key",
        },
      } as any,
      {
        query: jest
          .fn()
          .mockResolvedValue({ rowCount: 1, rows: [{ count: 1 }] }),
      } as any,
    );

    await expect(
      service.search("account", "keyword", "office"),
    ).rejects.toMatchObject({
      status: 502,
      response: { error: { code: "KAKAO_UNAVAILABLE" } },
    });
  });
});
