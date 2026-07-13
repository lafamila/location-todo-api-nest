import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { ConfigService } from "../config/config.service";
import { SessionStartRequest } from "../contracts/v1";
import { CurrentAccount, CurrentSession } from "./current";
import { AuthAccount, ServiceSession } from "./auth.types";
import {
  parseCookies,
  SessionGuard,
  setWebSessionCookies,
} from "./session.guard";
import { SessionService } from "./session.service";

@Controller("session")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Post("oidc/start")
  async start(
    @Body() body: SessionStartRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.sessions.start(body);
    if (result.browserNonce) {
      response.cookie("location_todo_oidc", result.browserNonce, {
        httpOnly: true,
        secure: this.config.value.publicOrigin.startsWith("https:"),
        sameSite: "lax",
        path: "/api/session/oidc/callback",
        maxAge: this.config.value.oidcTransactionTtlSeconds * 1000,
      });
    }
    return {
      authorizeUrl: result.authorizeUrl,
      loginTransactionId: result.loginTransactionId,
      expiresAt: result.expiresAt,
    };
  }

  @Get("oidc/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.sessions.callback({
      code,
      state,
      error,
      errorDescription,
      browserNonce: parseCookies(request.headers.cookie).location_todo_oidc,
    });
    response.clearCookie("location_todo_oidc", {
      path: "/api/session/oidc/callback",
    });
    if (result.issue && result.clientKind === "web")
      setWebSessionCookies(
        response,
        this.config,
        result.issue.rawToken,
        result.issue.csrfToken,
        result.issue.session.absoluteExpiresAt,
      );
    if (result.returnUri) {
      if (result.returnUri.startsWith("loc:")) {
        const nonce = randomBytes(18).toString("base64");
        response
          .set({
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
            "Referrer-Policy": "no-referrer",
          })
          .type("html")
          .send(callbackPage(result.returnUri, !result.errorCode, nonce));
      } else {
        response.redirect(result.returnUri);
      }
      return;
    }
    response.status(result.errorCode ? 400 : 200).json({
      loginTransactionId: result.transactionId,
      error: result.errorCode
        ? { code: result.errorCode, message: result.error }
        : undefined,
    });
  }

  @Post("oidc/complete")
  async complete(
    @Body() body?: { loginTransactionId?: string; installationId?: string },
  ) {
    const issue = await this.sessions.completeNative(
      body?.loginTransactionId as string,
      body?.installationId as string,
    );
    return {
      sessionToken: issue.rawToken,
      expiresAt: issue.session.absoluteExpiresAt.toISOString(),
      account: {
        id: issue.session.account.id,
        displayName: issue.session.account.displayName,
        email: issue.session.account.email,
        permission: issue.session.account.permission,
      },
    };
  }

  @UseGuards(SessionGuard)
  @Get("me")
  me(
    @CurrentAccount() account: AuthAccount,
    @CurrentSession() session: ServiceSession,
  ) {
    return {
      account,
      deviceId: session.deviceId,
      expiresAt: session.absoluteExpiresAt.toISOString(),
    };
  }

  @UseGuards(SessionGuard)
  @Post("permission-request")
  requestPermission(
    @CurrentSession() session: ServiceSession,
    @Body() body?: { message?: string },
  ) {
    return this.sessions.requestUpgrade(session, body?.message as string);
  }

  @UseGuards(SessionGuard)
  @Post("logout")
  async logout(
    @CurrentSession() session: ServiceSession,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.logout(session);
    response.clearCookie(this.config.value.sessionCookieName, { path: "/" });
    response.clearCookie("location_todo_csrf", { path: "/" });
    return { ok: true };
  }
}

export function callbackPage(
  uri: string,
  success: boolean,
  nonce: string,
): string {
  const escaped = uri
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  const scriptUri = JSON.stringify(uri)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Location Todo login</title></head><body><main><h1>${success ? "로그인 완료" : "로그인 실패"}</h1><p>Location Todo 앱으로 돌아갑니다.</p><a href="${escaped}">앱으로 돌아가기</a></main><script nonce="${nonce}">location.replace(${scriptUri})</script></body></html>`;
}
