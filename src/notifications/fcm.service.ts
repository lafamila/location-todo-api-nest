import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { importPKCS8, SignJWT } from "jose";
import { ConfigService } from "../config/config.service";
import { fetchWithTimeout } from "../common/fetch-timeout";

export interface DeliveryResult {
  ok: boolean;
  terminal: boolean;
  status?: number;
  code?: string;
  error?: string;
}

@Injectable()
export class FcmService implements OnModuleInit {
  private oauth?: { token: string; expiresAt: number };
  private credentialStatus: "not_configured" | "checking" | "valid" | "error" =
    "not_configured";
  private readonly logger = new Logger(FcmService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (!this.configured()) return;
    this.credentialStatus = "checking";
    void this.accessToken()
      .then(() =>
        this.logger.log("Firebase credentials accepted by Google OAuth"),
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Firebase credential check failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  configured(): boolean {
    const value = this.config.value;
    return Boolean(
      value.firebaseProjectId &&
      value.firebaseClientEmail &&
      value.firebasePrivateKey,
    );
  }

  status(): {
    configured: boolean;
    credentialStatus: "not_configured" | "checking" | "valid" | "error";
  } {
    return {
      configured: this.configured(),
      credentialStatus: this.credentialStatus,
    };
  }

  async send(
    pushToken: string,
    payload: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    if (!this.configured())
      return {
        ok: false,
        terminal: false,
        code: "FCM_NOT_CONFIGURED",
        error: "FCM is not configured",
      };
    try {
      const accessToken = await this.accessToken();
      const response = await fetchWithTimeout(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.value.firebaseProjectId!)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: pushToken,
              notification: {
                title: "Location Todo",
                body: String(payload.content || "TODO condition met"),
              },
              data: Object.fromEntries(
                Object.entries(payload).map(([key, value]) => [
                  key,
                  String(value),
                ]),
              ),
            },
          }),
        },
      );
      if (response.ok)
        return { ok: true, terminal: false, status: response.status };
      const text = (await response.text()).slice(0, 1000);
      const terminal =
        response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text);
      return {
        ok: false,
        terminal,
        status: response.status,
        code: terminal ? "INVALID_TOKEN" : "FCM_REJECTED",
        error: text,
      };
    } catch (error) {
      return {
        ok: false,
        terminal: false,
        code: "FCM_UNAVAILABLE",
        error: error instanceof Error ? error.message : "FCM unavailable",
      };
    }
  }

  private async accessToken(): Promise<string> {
    if (this.oauth && this.oauth.expiresAt > Date.now() + 60_000)
      return this.oauth.token;
    try {
      const now = Math.floor(Date.now() / 1000);
      const key = await importPKCS8(
        this.config.value.firebasePrivateKey!,
        "RS256",
      );
      const assertion = await new SignJWT({
        scope: "https://www.googleapis.com/auth/firebase.messaging",
      })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(this.config.value.firebaseClientEmail!)
        .setAudience("https://oauth2.googleapis.com/token")
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(key);
      const response = await fetchWithTimeout(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Firebase OAuth failed (${response.status})`);
      const value = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!value.access_token) throw new Error("Firebase OAuth token missing");
      this.oauth = {
        token: value.access_token,
        expiresAt: Date.now() + (value.expires_in || 3600) * 1000,
      };
      this.credentialStatus = "valid";
      return value.access_token;
    } catch (error) {
      this.credentialStatus = "error";
      throw error;
    }
  }
}
