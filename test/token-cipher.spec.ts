import { TokenCipher } from "../src/auth/token-cipher";
import { ConfigService } from "../src/config/config.service";

describe("TokenCipher", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "test";
  });

  test("encrypts with authenticated random nonces and hashes opaque tokens", () => {
    const cipher = new TokenCipher(new ConfigService());
    const first = cipher.encrypt("refresh-token");
    const second = cipher.encrypt("refresh-token");
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe("refresh-token");
    expect(cipher.hash("session-token")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects tampered ciphertext", () => {
    const cipher = new TokenCipher(new ConfigService());
    const encrypted = cipher.encrypt("access-token");
    expect(() => cipher.decrypt(`${encrypted.slice(0, -2)}aa`)).toThrow();
  });
});
