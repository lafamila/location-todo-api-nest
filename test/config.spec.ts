import { loadAppConfig } from "../src/config/app-config";

const keys = [
  "NODE_ENV",
  "PUBLIC_ORIGIN",
  "WEB_ALLOWED_ORIGINS",
  "ALLOWED_ORIGINS",
  "AUTH_API_BASE_URL",
  "AUTH_ISSUER_URL",
  "AUTH_JWKS_URL",
  "LOCATION_TODO_OIDC_REDIRECT_URI",
  "LOCATION_TODO_OIDC_CLIENT_SECRET",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
] as const;

describe("application configuration", () => {
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("prefers canonical WEB_ALLOWED_ORIGINS over its compatibility alias", () => {
    process.env.NODE_ENV = "test";
    process.env.WEB_ALLOWED_ORIGINS = "https://canonical.example";
    process.env.ALLOWED_ORIGINS = "https://legacy.example";
    expect(loadAppConfig().allowedOrigins).toEqual([
      "https://canonical.example",
    ]);
  });

  test("fails production startup for insecure endpoints or missing OIDC secret", () => {
    setSecureProduction();
    delete process.env.LOCATION_TODO_OIDC_CLIENT_SECRET;
    expect(() => loadAppConfig()).toThrow(
      "LOCATION_TODO_OIDC_CLIENT_SECRET is required",
    );

    setSecureProduction();
    process.env.AUTH_API_BASE_URL = "http://auth.example";
    expect(() => loadAppConfig()).toThrow("AUTH_API_BASE_URL must use HTTPS");

    setSecureProduction();
    process.env.AUTH_JWKS_URL = "http://auth.example/jwks";
    expect(() => loadAppConfig()).toThrow("AUTH_JWKS_URL must use HTTPS");
  });

  test("fails production startup when Firebase delivery is not configured", () => {
    setSecureProduction();
    delete process.env.FIREBASE_PRIVATE_KEY;
    expect(() => loadAppConfig()).toThrow(
      "Firebase configuration is required in production: FIREBASE_PRIVATE_KEY",
    );
  });
});

function setSecureProduction(): void {
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_ORIGIN = "https://loc.example";
  process.env.WEB_ALLOWED_ORIGINS = "https://loc.example";
  process.env.AUTH_API_BASE_URL = "https://auth.example";
  process.env.AUTH_ISSUER_URL = "https://auth.example";
  process.env.AUTH_JWKS_URL = "https://auth.example/jwks";
  process.env.LOCATION_TODO_OIDC_REDIRECT_URI =
    "https://loc.example/api/session/oidc/callback";
  process.env.LOCATION_TODO_OIDC_CLIENT_SECRET = "secret";
  process.env.FIREBASE_PROJECT_ID = "firebase-project";
  process.env.FIREBASE_CLIENT_EMAIL = "firebase@example.test";
  process.env.FIREBASE_PRIVATE_KEY = "private-key";
}
