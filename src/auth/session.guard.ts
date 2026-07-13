import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request, Response } from "express";
import { ConfigService } from "../config/config.service";
import { AuthenticatedRequest } from "./auth.types";
import { SessionService } from "./session.service";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & Partial<AuthenticatedRequest>>();
    const header = request.headers[this.config.value.sessionHeaderName] as
      string | undefined;
    const cookies = parseCookies(request.headers.cookie);
    const source = header ? "header" : "cookie";
    const raw = header || cookies[this.config.value.sessionCookieName];
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const csrf =
      source === "cookie" && unsafe
        ? ((request.headers["x-csrf-token"] as string | undefined) ?? null)
        : undefined;
    const session = await this.sessions.authenticate(raw, source, csrf);
    if (source === "cookie" && raw) {
      const response = context.switchToHttp().getResponse<Response>();
      setWebSessionCookies(
        response,
        this.config,
        raw,
        cookies.location_todo_csrf,
        session.absoluteExpiresAt,
      );
    }
    request.locationTodoSession = session;
    request.locationTodoAccount = session.account;
    return true;
  }
}

export function setWebSessionCookies(
  response: Response,
  config: ConfigService,
  token: string,
  csrf: string | undefined,
  absoluteExpiresAt: Date,
): void {
  const secure = config.value.publicOrigin.startsWith("https:");
  const maxAge = Math.max(
    0,
    Math.min(
      config.value.sessionIdleSeconds * 1000,
      absoluteExpiresAt.getTime() - Date.now(),
    ),
  );
  response.cookie(config.value.sessionCookieName, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  if (csrf)
    response.cookie("location_todo_csrf", csrf, {
      httpOnly: false,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge,
    });
}

export function parseCookies(
  value: string | undefined,
): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index < 1
        ? []
        : [
            [
              part.slice(0, index).trim(),
              decodeURIComponent(part.slice(index + 1)),
            ],
          ];
    }),
  );
}
