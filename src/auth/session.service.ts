import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError, requireString, requireUuid } from "../common/errors";
import { fetchWithTimeout } from "../common/fetch-timeout";
import { ConfigService } from "../config/config.service";
import { Platform, SessionStartRequest } from "../contracts/v1";
import { DatabaseService, Query } from "../database/database.service";
import { AuthService } from "./auth.service";
import { AuthAccount, ServiceSession } from "./auth.types";
import { TokenCipher } from "./token-cipher";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface SessionRow {
  id: string;
  device_id: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  account_id: string;
  display_name: string;
  email: string | null;
  permission: "visitor" | "user" | "superadmin";
  permission_schema_version: number | null;
  platform: Platform | null;
  device_active: boolean | null;
}

export interface SessionIssue {
  rawToken: string;
  csrfToken: string;
  session: ServiceSession;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly cipher: TokenCipher,
  ) {}

  async start(input: SessionStartRequest): Promise<{
    authorizeUrl: string;
    loginTransactionId: string;
    expiresAt: string;
    browserNonce?: string;
  }> {
    if (!input || !["web", "native"].includes(input.clientKind)) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "clientKind must be web or native",
      );
    }
    const returnUri = this.validateReturnUri(input.returnUri, input.clientKind);
    const installationId =
      input.clientKind === "native"
        ? requireString(input.installationId, "installationId", 128)
        : input.installationId;
    const platform =
      input.platform || (input.clientKind === "web" ? "web" : undefined);
    if (
      !platform ||
      !["ios", "android", "macos", "windows", "web"].includes(platform)
    ) {
      throw new ApiError("VALIDATION_ERROR", "platform is invalid");
    }
    const appVersion = requireString(
      input.appVersion || "web",
      "appVersion",
      40,
    );
    const id = randomUUID();
    const state = randomToken(32);
    const browserNonce =
      input.clientKind === "web" ? randomToken(32) : undefined;
    const verifier = randomToken(48);
    const expiresAt = new Date(
      Date.now() + this.config.value.oidcTransactionTtlSeconds * 1000,
    );
    await this.db.query(
      `insert into login_transactions
       (id, state_hash, browser_nonce_hash, verifier_encrypted, return_uri, client_kind, installation_id, platform, app_version, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        this.cipher.hash(state),
        browserNonce ? this.cipher.hash(browserNonce) : null,
        this.cipher.encrypt(verifier),
        returnUri,
        input.clientKind,
        installationId ?? null,
        platform,
        appVersion,
        expiresAt,
      ],
    );
    const url = new URL("/oauth/authorize", this.config.value.authApiBaseUrl);
    url.searchParams.set("client_id", this.config.value.oidcClientId);
    url.searchParams.set("redirect_uri", this.config.value.oidcRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email service.permission");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", this.cipher.hash(verifier));
    // PKCE requires base64url(SHA-256), not its hex storage representation.
    url.searchParams.set(
      "code_challenge",
      Buffer.from(this.cipher.hash(verifier), "hex").toString("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    return {
      authorizeUrl: url.toString(),
      loginTransactionId: id,
      expiresAt: expiresAt.toISOString(),
      browserNonce,
    };
  }

  async callback(input: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
    browserNonce?: string;
  }): Promise<{
    transactionId?: string;
    returnUri?: string;
    issue?: SessionIssue;
    clientKind?: "web" | "native";
    errorCode?: string;
    error?: string;
  }> {
    if (!input.state)
      return { errorCode: "INVALID_STATE", error: "Invalid login state" };
    const result = await this.db.query<{
      id: string;
      verifier_encrypted: string;
      return_uri: string | null;
      client_kind: "web" | "native";
      installation_id: string | null;
      platform: Platform;
      app_version: string;
      browser_nonce_hash: string | null;
      status: string;
      expires_at: Date;
    }>(
      `select id, verifier_encrypted, return_uri, client_kind, installation_id, platform, app_version, browser_nonce_hash, status, expires_at
       from login_transactions where state_hash = $1`,
      [this.cipher.hash(input.state)],
    );
    const transaction = result.rows[0];
    if (
      !transaction ||
      transaction.status !== "pending" ||
      transaction.expires_at.getTime() <= Date.now()
    ) {
      return {
        errorCode: "INVALID_STATE",
        error: "Invalid or expired login state",
      };
    }
    if (
      transaction.client_kind === "web" &&
      (!input.browserNonce ||
        !transaction.browser_nonce_hash ||
        this.cipher.hash(input.browserNonce) !== transaction.browser_nonce_hash)
    ) {
      return {
        transactionId: transaction.id,
        clientKind: transaction.client_kind,
        errorCode: "LOGIN_BROWSER_MISMATCH",
        error: "Login callback does not belong to this browser",
      };
    }
    const claimed = await this.db.query(
      `update login_transactions set status='processing',updated_at=now()
       where id=$1 and status='pending' returning id`,
      [transaction.id],
    );
    if (!claimed.rowCount)
      return {
        transactionId: transaction.id,
        clientKind: transaction.client_kind,
        errorCode: "LOGIN_ALREADY_PROCESSED",
        error: "Login callback was already processed",
      };
    if (input.error || !input.code) {
      const code = input.error
        ? normalizeOidcErrorCode(input.error)
        : "authorization_code_missing";
      const message =
        input.errorDescription || input.error || "Authorization code missing";
      await this.failTransaction(transaction.id, code, message);
      return {
        transactionId: transaction.id,
        clientKind: transaction.client_kind,
        returnUri: this.resultReturnUri(
          transaction.return_uri,
          transaction.id,
          "error",
          code,
        ),
        errorCode: code,
        error: message,
      };
    }
    try {
      const token = await this.requestToken({
        grant_type: "authorization_code",
        client_id: this.config.value.oidcClientId,
        client_secret: this.requireClientSecret(),
        redirect_uri: this.config.value.oidcRedirectUri,
        code: input.code,
        code_verifier: this.cipher.decrypt(transaction.verifier_encrypted),
      });
      const account = await this.auth.verifyAccessToken(
        this.requiredToken(token.access_token, "access_token"),
      );
      const issue = await this.createSession(
        account,
        token,
        transaction.installation_id,
        transaction.platform,
        transaction.app_version,
        transaction.client_kind,
      );
      const completed = await this.db.query(
        `update login_transactions set status='completed', session_id=$2,
         one_time_session_encrypted=$3, updated_at=now() where id=$1 and status='processing'`,
        [
          transaction.id,
          issue.session.id,
          transaction.client_kind === "native"
            ? this.cipher.encrypt(issue.rawToken)
            : null,
        ],
      );
      if (!completed.rowCount) {
        await this.db.query("delete from app_sessions where id=$1", [
          issue.session.id,
        ]);
        throw new Error("Login transaction finalization lost ownership");
      }
      return {
        transactionId: transaction.id,
        clientKind: transaction.client_kind,
        returnUri: this.resultReturnUri(
          transaction.return_uri,
          transaction.id,
          "success",
        ),
        issue,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      await this.failTransaction(transaction.id, "LOGIN_FAILED", message);
      return {
        transactionId: transaction.id,
        clientKind: transaction.client_kind,
        returnUri: this.resultReturnUri(
          transaction.return_uri,
          transaction.id,
          "error",
          "LOGIN_FAILED",
        ),
        errorCode: "LOGIN_FAILED",
        error: message,
      };
    }
  }

  async completeNative(
    transactionId: string,
    installationId: string,
  ): Promise<SessionIssue> {
    requireUuid(transactionId, "loginTransactionId");
    requireString(installationId, "installationId", 128);
    return this.db.transaction(async (query) => {
      const result = await query<{
        status: string;
        installation_id: string | null;
        one_time_session_encrypted: string | null;
        session_id: string | null;
        expires_at: Date;
      }>(
        `select status, installation_id, one_time_session_encrypted, session_id, expires_at from login_transactions where id=$1 for update`,
        [transactionId],
      );
      const transaction = result.rows[0];
      if (
        !transaction ||
        transaction.status !== "completed" ||
        transaction.installation_id !== installationId ||
        !transaction.one_time_session_encrypted ||
        !transaction.session_id ||
        transaction.expires_at.getTime() <= Date.now()
      ) {
        throw new ApiError(
          "LOGIN_TRANSACTION_INVALID",
          "Login transaction is invalid, expired, or already consumed",
          401,
        );
      }
      const rawToken = this.cipher.decrypt(
        transaction.one_time_session_encrypted,
      );
      const session = await this.findSessionByHash(
        this.cipher.hash(rawToken),
        "header",
        query,
      );
      await query(
        `update login_transactions set status='consumed', one_time_session_encrypted=null, consumed_at=now(), updated_at=now() where id=$1`,
        [transactionId],
      );
      return { rawToken, csrfToken: "", session };
    });
  }

  async authenticate(
    rawToken: string | undefined,
    source: "cookie" | "header",
    csrf?: string | null,
  ): Promise<ServiceSession> {
    if (!rawToken)
      throw new ApiError(
        "AUTH_REQUIRED",
        "Location Todo session is required",
        401,
      );
    const session = await this.findSessionByHash(
      this.cipher.hash(rawToken),
      source,
    );
    if (source === "cookie" && csrf !== undefined) {
      const result = await this.db.query<{ csrf_hash: string | null }>(
        "select csrf_hash from app_sessions where id=$1",
        [session.id],
      );
      if (
        !csrf ||
        !result.rows[0]?.csrf_hash ||
        this.cipher.hash(csrf) !== result.rows[0].csrf_hash
      ) {
        throw new ApiError(
          "CSRF_INVALID",
          "CSRF token is missing or invalid",
          403,
        );
      }
    }
    if (session.accessTokenExpiresAt.getTime() - Date.now() < 60_000)
      return this.refreshLocked(session.id, source);
    const newIdle = new Date(
      Math.min(
        Date.now() + this.config.value.sessionIdleSeconds * 1000,
        session.absoluteExpiresAt.getTime(),
      ),
    );
    await this.db.query(
      `update app_sessions set last_seen_at=now(), idle_expires_at=$2 where id=$1`,
      [session.id, newIdle],
    );
    if (session.deviceId)
      await this.db.query(`update devices set last_seen_at=now() where id=$1`, [
        session.deviceId,
      ]);
    return { ...session, idleExpiresAt: newIdle };
  }

  async validateExisting(
    rawToken: string | undefined,
  ): Promise<ServiceSession> {
    if (!rawToken)
      throw new ApiError(
        "AUTH_REQUIRED",
        "Location Todo session is required",
        401,
      );
    return this.findSessionByHash(this.cipher.hash(rawToken), "header");
  }

  async logout(session: ServiceSession | undefined): Promise<void> {
    if (!session) return;
    await this.db.transaction(async (query) => {
      await query("update app_sessions set revoked_at=now() where id=$1", [
        session.id,
      ]);
      if (session.deviceId) {
        await query(
          "update devices set active=false, push_token=null, push_token_updated_at=null where id=$1",
          [session.deviceId],
        );
        await query("delete from app_sessions where device_id=$1", [
          session.deviceId,
        ]);
      } else {
        await query("delete from app_sessions where id=$1", [session.id]);
      }
    });
    await fetchWithTimeout(`${this.config.value.authApiBaseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: session.refreshToken }),
    }).catch(() => undefined);
  }

  async requestUpgrade(
    session: ServiceSession,
    message: string,
  ): Promise<{ status: "pending" }> {
    const validatedMessage = requireString(message, "message", 500);
    if (session.account.permission !== "visitor")
      throw new ApiError(
        "UPGRADE_NOT_AVAILABLE",
        "Permission upgrade is not available",
        409,
      );
    const response = await fetchWithTimeout(
      `${this.config.value.authApiBaseUrl}/api/service-applications`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceKey: this.config.value.authServiceKey,
          message: validatedMessage,
        }),
      },
    ).catch(() => undefined);
    if (!response)
      throw new ServiceUnavailableException({
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Authentication service is unavailable",
        },
      });
    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        await this.db.query(
          `update accounts set upgrade_status='rejected', updated_at=now() where id=$1`,
          [session.account.id],
        );
        throw new ApiError(
          "UPGRADE_REJECTED",
          "Upgrade request was rejected",
          response.status,
        );
      }
      throw new ServiceUnavailableException({
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Authentication service is unavailable",
        },
      });
    }
    await this.db.query(
      `update accounts set upgrade_status='pending', updated_at=now() where id=$1`,
      [session.account.id],
    );
    return { status: "pending" };
  }

  private async createSession(
    account: AuthAccount,
    token: TokenResponse,
    installationId: string | null,
    platform: Platform,
    appVersion: string,
    clientKind: "web" | "native",
  ): Promise<SessionIssue> {
    const accessToken = this.requiredToken(token.access_token, "access_token");
    const refreshToken = this.requiredToken(
      token.refresh_token,
      "refresh_token",
    );
    if (!Number.isInteger(token.expires_in) || (token.expires_in ?? 0) <= 0)
      throw new Error("Token response expires_in is invalid");
    const rawToken = randomToken(48);
    const csrfToken = randomToken(32);
    const now = Date.now();
    const accessExpires = new Date(now + (token.expires_in as number) * 1000);
    const idleExpires = new Date(
      now + this.config.value.sessionIdleSeconds * 1000,
    );
    const absoluteExpires = new Date(
      now + this.config.value.sessionAbsoluteSeconds * 1000,
    );
    const sessionId = randomUUID();
    const deviceId = await this.db.transaction(async (query) => {
      await query(
        `insert into accounts(id,email,display_name,permission,permission_schema_version)
         values($1,$2,$3,$4,$5)
         on conflict(id) do update set email=excluded.email, display_name=excluded.display_name,
         permission=excluded.permission, permission_schema_version=excluded.permission_schema_version,
         upgrade_status=case when excluded.permission in ('user','superadmin') then 'approved'
           when accounts.upgrade_status='approved' then null else accounts.upgrade_status end, updated_at=now()`,
        [
          account.id,
          account.email ?? null,
          account.displayName,
          account.permission,
          account.permissionSchemaVersion ?? null,
        ],
      );
      let id: string | null = null;
      if (installationId) {
        const result = await query<{ id: string }>(
          `insert into devices(account_id,installation_id,platform,app_version,active,last_seen_at)
           values($1,$2,$3,$4,true,now())
           on conflict(account_id,installation_id) do update set app_version=excluded.app_version, active=true, last_seen_at=now()
           where devices.platform=excluded.platform
           returning id`,
          [account.id, installationId, platform, appVersion],
        );
        id = result.rows[0]?.id ?? null;
        if (!id)
          throw new ApiError(
            "DEVICE_PLATFORM_IMMUTABLE",
            "An installation cannot change platform",
            409,
          );
      }
      await query(
        `insert into app_sessions(id,account_id,device_id,token_hash,csrf_hash,access_token_encrypted,refresh_token_encrypted,
         access_token_expires_at,idle_expires_at,absolute_expires_at,client_platform)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          sessionId,
          account.id,
          id,
          this.cipher.hash(rawToken),
          clientKind === "web" ? this.cipher.hash(csrfToken) : null,
          this.cipher.encrypt(accessToken),
          this.cipher.encrypt(refreshToken),
          accessExpires,
          idleExpires,
          absoluteExpires,
          platform,
        ],
      );
      return id;
    });
    return {
      rawToken,
      csrfToken,
      session: {
        id: sessionId,
        account,
        deviceId: deviceId ?? undefined,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: accessExpires,
        idleExpiresAt: idleExpires,
        absoluteExpiresAt: absoluteExpires,
        source: clientKind === "web" ? "cookie" : "header",
        platform,
      },
    };
  }

  private async refreshLocked(
    sessionId: string,
    source: "cookie" | "header",
  ): Promise<ServiceSession> {
    const outcome = await this.db.transaction(async (query) => {
      const result = await query<SessionRow>(
        this.sessionSelect("s.id = $1") + " for update of s",
        [sessionId],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError("SESSION_EXPIRED", "Session expired", 401);
      if (row.access_token_expires_at.getTime() - Date.now() >= 60_000) {
        const fresh = await query<SessionRow>(this.sessionSelect("s.id = $1"), [
          sessionId,
        ]);
        return { session: this.rowToSession(fresh.rows[0]!, source) };
      }
      const current = this.rowToSession(row, source);
      const response = await fetchWithTimeout(
        `${this.config.value.authApiBaseUrl}/oauth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: this.config.value.oidcClientId,
            client_secret: this.requireClientSecret(),
            refresh_token: current.refreshToken,
          }),
        },
      ).catch(() => undefined);
      if (!response || response.status >= 500) {
        if (current.accessTokenExpiresAt.getTime() > Date.now())
          return { session: current };
        throw new ApiError(
          "AUTH_UNAVAILABLE",
          "Authentication service is temporarily unavailable",
          503,
        );
      }
      if ([400, 401, 403].includes(response.status)) {
        await query("delete from app_sessions where id=$1", [sessionId]);
        return { rejected: true as const };
      }
      if (!response.ok)
        throw new ApiError(
          "AUTH_UNAVAILABLE",
          "Authentication service is temporarily unavailable",
          503,
        );
      const token = (await response.json()) as TokenResponse;
      const account = await this.auth.verifyAccessToken(
        this.requiredToken(token.access_token, "access_token"),
      );
      const refreshToken = this.requiredToken(
        token.refresh_token,
        "refresh_token",
      );
      const accessExpires = new Date(
        Date.now() + Number(token.expires_in) * 1000,
      );
      await query(
        `update app_sessions set access_token_encrypted=$2,refresh_token_encrypted=$3,access_token_expires_at=$4,
         last_seen_at=now(),idle_expires_at=$5 where id=$1`,
        [
          sessionId,
          this.cipher.encrypt(token.access_token as string),
          this.cipher.encrypt(refreshToken),
          accessExpires,
          new Date(
            Math.min(
              Date.now() + this.config.value.sessionIdleSeconds * 1000,
              current.absoluteExpiresAt.getTime(),
            ),
          ),
        ],
      );
      await query(
        `update accounts set permission=$2, permission_schema_version=$3,
         upgrade_status=case when $2 in ('user','superadmin') then 'approved'
           when upgrade_status='approved' then null else upgrade_status end,
         updated_at=now() where id=$1`,
        [
          account.id,
          account.permission,
          account.permissionSchemaVersion ?? null,
        ],
      );
      return {
        session: {
          ...current,
          account,
          accessToken: token.access_token as string,
          refreshToken,
          accessTokenExpiresAt: accessExpires,
          idleExpiresAt: new Date(
            Math.min(
              Date.now() + this.config.value.sessionIdleSeconds * 1000,
              current.absoluteExpiresAt.getTime(),
            ),
          ),
        },
      };
    });
    if ("rejected" in outcome)
      throw new ApiError(
        "SESSION_REJECTED",
        "Session refresh was rejected",
        401,
      );
    return outcome.session;
  }

  private async findSessionByHash(
    hash: string,
    source: "cookie" | "header",
    query: Query = this.db.query.bind(this.db),
  ): Promise<ServiceSession> {
    const result = await query<SessionRow>(
      this.sessionSelect("s.token_hash = $1"),
      [hash],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.idle_expires_at.getTime() <= Date.now() ||
      row.absolute_expires_at.getTime() <= Date.now() ||
      (row.device_id !== null && row.device_active !== true)
    ) {
      if (row) await query("delete from app_sessions where id=$1", [row.id]);
      throw new ApiError("SESSION_EXPIRED", "Session expired", 401);
    }
    return this.rowToSession(row, source);
  }

  private sessionSelect(where: string): string {
    return `select s.id,s.device_id,s.access_token_encrypted,s.refresh_token_encrypted,s.access_token_expires_at,
      s.idle_expires_at,s.absolute_expires_at,s.revoked_at,a.id account_id,a.display_name,a.email,a.permission,
      a.permission_schema_version,s.client_platform platform,d.active device_active from app_sessions s join accounts a on a.id=s.account_id
      left join devices d on d.id=s.device_id where ${where}`;
  }

  private rowToSession(
    row: SessionRow,
    source: "cookie" | "header",
  ): ServiceSession {
    return {
      id: row.id,
      deviceId: row.device_id ?? undefined,
      account: {
        id: row.account_id,
        displayName: row.display_name,
        email: row.email ?? undefined,
        permission: row.permission,
        permissionSchemaVersion: row.permission_schema_version ?? undefined,
      },
      accessToken: this.cipher.decrypt(row.access_token_encrypted),
      refreshToken: this.cipher.decrypt(row.refresh_token_encrypted),
      accessTokenExpiresAt: row.access_token_expires_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      source,
      platform: row.platform ?? undefined,
    };
  }

  private async requestToken(
    body: Record<string, string>,
  ): Promise<TokenResponse> {
    const response = await fetchWithTimeout(
      `${this.config.value.authApiBaseUrl}/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`Token exchange failed (${response.status})`);
    return (await response.json()) as TokenResponse;
  }

  private validateReturnUri(
    value: string | undefined,
    kind: "web" | "native",
  ): string | null {
    if (kind === "native") {
      if (!value) return "loc://auth/complete";
      const parsed = new URL(value);
      if (
        parsed.protocol !== "loc:" ||
        parsed.hostname !== "auth" ||
        parsed.pathname !== "/complete" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new ApiError(
          "RETURN_URI_INVALID",
          "Native returnUri must be loc://auth/complete",
        );
      }
      return "loc://auth/complete";
    }
    if (!value) return `${this.config.value.publicOrigin}/`;
    const parsed = new URL(value);
    if (!this.config.value.allowedOrigins.includes(parsed.origin))
      throw new ApiError(
        "RETURN_URI_INVALID",
        "Web returnUri origin is not allowed",
      );
    return parsed.toString();
  }

  private resultReturnUri(
    base: string | null,
    transactionId: string,
    result: string,
    error?: string,
  ): string | undefined {
    if (!base) return undefined;
    const url = new URL(base);
    url.searchParams.set("transaction", transactionId);
    url.searchParams.set("result", result);
    if (error) url.searchParams.set("error", error);
    return url.toString();
  }

  private async failTransaction(
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.db.query(
      `update login_transactions set status='failed',error_code=$2,error_message=$3,updated_at=now()
       where id=$1 and status='processing'`,
      [id, code, message.slice(0, 500)],
    );
  }

  private requireClientSecret(): string {
    if (!this.config.value.oidcClientSecret)
      throw new Error("OIDC client secret is not configured");
    return this.config.value.oidcClientSecret;
  }

  private requiredToken(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Token response ${name} is missing`);
    return value;
  }
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeOidcErrorCode(value: string): string {
  const normalized = value.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(normalized)
    ? normalized
    : "authorization_error";
}
