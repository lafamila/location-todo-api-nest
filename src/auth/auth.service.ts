import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { ApiError } from "../common/errors";
import { ConfigService } from "../config/config.service";
import { Permission } from "../contracts/v1";
import { AuthAccount } from "./auth.types";

const SERVICE_CLAIM = "https://lafamila.xyz/claims/service";

@Injectable()
export class AuthService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService) {
    const uri =
      config.value.authJwksUrl || `${config.value.authIssuerUrl}/oauth/jwks`;
    this.jwks = createRemoteJWKSet(new URL(uri));
  }

  async verifyAccessToken(token: string): Promise<AuthAccount> {
    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(token, this.jwks, {
          issuer: this.config.value.authIssuerUrl,
          audience: this.config.value.authAudience,
          algorithms: ["RS256"],
        })
      ).payload;
    } catch {
      throw new ApiError(
        "AUTH_TOKEN_INVALID",
        "Authentication token is invalid",
        401,
      );
    }
    const service = payload[SERVICE_CLAIM] as
      | { key?: string; permission?: string; permissionSchemaVersion?: number }
      | undefined;
    if (service?.key !== this.config.value.authServiceKey) {
      throw new ApiError(
        "AUTH_AUDIENCE_INVALID",
        "Token is not valid for Location Todo",
        403,
      );
    }
    const permission: Permission =
      service.permission === "superadmin"
        ? "superadmin"
        : service.permission === "user"
          ? "user"
          : "visitor";
    if (typeof payload.sub !== "string")
      throw new ApiError("AUTH_TOKEN_INVALID", "Token subject is missing", 401);
    return {
      id: payload.sub,
      displayName:
        stringClaim(payload, ["name", "display_name"]) || "Location Todo user",
      email: stringClaim(payload, ["email"]) || undefined,
      permission,
      permissionSchemaVersion: service.permissionSchemaVersion,
    };
  }
}

function stringClaim(payload: JWTPayload, keys: string[]): string | undefined {
  for (const key of keys)
    if (typeof payload[key] === "string") return payload[key] as string;
  return undefined;
}
