import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  publicOrigin: string;
  allowedOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  autoMigrate: boolean;
  authApiBaseUrl: string;
  authIssuerUrl: string;
  authJwksUrl?: string;
  authAudience: string;
  authServiceKey: string;
  oidcClientId: string;
  oidcClientSecret?: string;
  oidcRedirectUri: string;
  oidcTransactionTtlSeconds: number;
  sessionCookieName: string;
  sessionHeaderName: string;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  tokenEncryptionKey: Buffer;
  defaultTimezone: string;
  kakaoRestApiKey?: string;
  kakaoJavascriptKey?: string;
  firebaseProjectId?: string;
  firebaseClientEmail?: string;
  firebasePrivateKey?: string;
  workerEnabled: boolean;
  workerPollMs: number;
  retentionIntervalMs: number;
  timeTodoMutationsPerHour: number;
}

loadDotEnv();

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function integer(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function url(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function encryptionKey(): Buffer {
  const raw = process.env.LOCATION_TODO_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production")
      throw new Error("LOCATION_TODO_TOKEN_ENCRYPTION_KEY is required");
    return createHash("sha256")
      .update("location-todo-development-only-key")
      .digest();
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error(
      "LOCATION_TODO_TOKEN_ENCRYPTION_KEY must be a base64 encoded 32-byte key",
    );
  return key;
}

function timezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error("DEFAULT_TIMEZONE must be an IANA timezone");
  }
}

export function loadAppConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || "development";
  const publicOrigin = url("PUBLIC_ORIGIN", "http://localhost:3042");
  const databaseUrl =
    process.env.DATABASE_URL || "postgres://localhost:5432/location_todo";
  if (
    !databaseUrl.startsWith("postgres://") &&
    !databaseUrl.startsWith("postgresql://")
  ) {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  const allowedOrigins = (
    process.env.WEB_ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    publicOrigin
  )
    .split(",")
    .map((value) => new URL(value.trim()).origin);
  const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  );
  const config: AppConfig = {
    nodeEnv,
    host: process.env.HOST || "0.0.0.0",
    port: integer("PORT", 3042, 1),
    publicOrigin,
    allowedOrigins,
    databaseUrl,
    databaseSsl: boolean("DATABASE_SSL", false),
    autoMigrate: boolean("AUTO_MIGRATE", nodeEnv !== "production"),
    authApiBaseUrl: url("AUTH_API_BASE_URL", "http://localhost:3032"),
    authIssuerUrl: url("AUTH_ISSUER_URL", "http://localhost:3032"),
    authJwksUrl: process.env.AUTH_JWKS_URL,
    authAudience: process.env.AUTH_AUDIENCE || "service:location-todo",
    authServiceKey: process.env.AUTH_SERVICE_KEY || "location-todo",
    oidcClientId:
      process.env.LOCATION_TODO_OIDC_CLIENT_ID || "location-todo-api",
    oidcClientSecret: process.env.LOCATION_TODO_OIDC_CLIENT_SECRET,
    oidcRedirectUri:
      process.env.LOCATION_TODO_OIDC_REDIRECT_URI ||
      `${publicOrigin}/api/session/oidc/callback`,
    oidcTransactionTtlSeconds: integer("OIDC_TRANSACTION_TTL_SECONDS", 300, 30),
    sessionCookieName:
      process.env.SESSION_COOKIE_NAME || "location_todo_session",
    sessionHeaderName:
      process.env.SESSION_HEADER_NAME || "x-location-todo-session",
    sessionIdleSeconds: integer("SESSION_IDLE_SECONDS", 2_592_000, 300),
    sessionAbsoluteSeconds: integer(
      "SESSION_ABSOLUTE_SECONDS",
      15_552_000,
      300,
    ),
    tokenEncryptionKey: encryptionKey(),
    defaultTimezone: timezone(process.env.DEFAULT_TIMEZONE || "Asia/Seoul"),
    kakaoRestApiKey: process.env.KAKAO_REST_API_KEY,
    kakaoJavascriptKey: process.env.KAKAO_JAVASCRIPT_KEY,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
    firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    firebasePrivateKey,
    workerEnabled: boolean("WORKER_ENABLED", true),
    workerPollMs: integer("WORKER_POLL_MS", 1000, 100),
    retentionIntervalMs: integer("RETENTION_INTERVAL_MS", 3_600_000, 60_000),
    timeTodoMutationsPerHour: integer("TIME_TODO_MUTATIONS_PER_HOUR", 120, 1),
  };
  assertProductionConfig(config);
  return config;
}

function assertProductionConfig(config: AppConfig): void {
  if (config.nodeEnv !== "production") return;
  const secureUrls: Array<[string, string | undefined]> = [
    ["PUBLIC_ORIGIN", config.publicOrigin],
    ["AUTH_API_BASE_URL", config.authApiBaseUrl],
    ["AUTH_ISSUER_URL", config.authIssuerUrl],
    ["LOCATION_TODO_OIDC_REDIRECT_URI", config.oidcRedirectUri],
    ["AUTH_JWKS_URL", config.authJwksUrl],
  ];
  for (const [name, value] of secureUrls) {
    if (value && new URL(value).protocol !== "https:")
      throw new Error(`${name} must use HTTPS in production`);
  }
  if (
    config.allowedOrigins.some(
      (origin) => new URL(origin).protocol !== "https:",
    )
  )
    throw new Error("WEB_ALLOWED_ORIGINS must use HTTPS in production");
  if (!config.oidcClientSecret?.trim())
    throw new Error(
      "LOCATION_TODO_OIDC_CLIENT_SECRET is required in production",
    );
  const missingFirebase = [
    ["FIREBASE_PROJECT_ID", config.firebaseProjectId],
    ["FIREBASE_CLIENT_EMAIL", config.firebaseClientEmail],
    ["FIREBASE_PRIVATE_KEY", config.firebasePrivateKey],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missingFirebase.length)
    throw new Error(
      `Firebase configuration is required in production: ${missingFirebase.join(", ")}`,
    );
}
