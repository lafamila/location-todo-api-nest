import { Injectable } from "@nestjs/common";
import { ServiceSession } from "../auth/auth.types";
import {
  ApiError,
  requireInteger,
  requireNumber,
  requireString,
  requireUuid,
} from "../common/errors";
import { fetchWithTimeout } from "../common/fetch-timeout";
import { ConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class KakaoService {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async search(
    accountId: string,
    type: "address" | "keyword",
    query: string,
    page = 1,
  ): Promise<unknown> {
    await this.rateLimit(accountId);
    const q = requireString(query, "query", 100);
    const safePage = requireInteger(page, "page", 1, 45);
    if (!["address", "keyword"].includes(type))
      throw new ApiError("VALIDATION_ERROR", "search type is invalid");
    if (!this.config.value.kakaoRestApiKey)
      throw new ApiError(
        "KAKAO_NOT_CONFIGURED",
        "Kakao Local API is not configured",
        503,
      );
    const path =
      type === "address"
        ? "/v2/local/search/address.json"
        : "/v2/local/search/keyword.json";
    const url = new URL(path, "https://dapi.kakao.com");
    url.searchParams.set("query", q);
    url.searchParams.set("page", String(safePage));
    url.searchParams.set("size", "15");
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        headers: {
          authorization: `KakaoAK ${this.config.value.kakaoRestApiKey}`,
        },
      });
    } catch {
      throw new ApiError(
        "KAKAO_UNAVAILABLE",
        "Kakao Local API is unavailable",
        502,
      );
    }
    if (!response.ok)
      throw new ApiError(
        "KAKAO_UNAVAILABLE",
        "Kakao Local API is unavailable",
        502,
      );
    return response.json();
  }

  async createHandoff(
    session: ServiceSession,
    input: {
      draft: {
        latitude: number;
        longitude: number;
        radiusMeters: number;
        name: string;
        address: string;
        placeMetadata?: Record<string, unknown> | null;
        version?: number;
        draftNonce: string;
      };
      allowedOrigin?: string;
    },
  ) {
    if (!input || typeof input !== "object")
      throw new ApiError("VALIDATION_ERROR", "Map handoff body is required");
    const allowedOrigin = input.allowedOrigin
      ? new URL(input.allowedOrigin).origin
      : this.config.value.publicOrigin;
    if (!this.config.value.allowedOrigins.includes(allowedOrigin))
      throw new ApiError(
        "ORIGIN_NOT_ALLOWED",
        "Map handoff origin is not allowed",
        403,
      );
    if (!input?.draft)
      throw new ApiError("VALIDATION_ERROR", "draft is required");
    const initial = {
      latitude: requireNumber(input.draft.latitude, "latitude", -90, 90),
      longitude: requireNumber(input.draft.longitude, "longitude", -180, 180),
      radiusMeters: requireInteger(
        input.draft.radiusMeters,
        "radiusMeters",
        100,
        5000,
      ),
      name: requireString(input.draft.name, "name", 100, 0),
      address: requireString(input.draft.address, "address", 300, 0),
      placeMetadata: input.draft.placeMetadata ?? null,
      version: input.draft.version,
      draftNonce: requireString(input.draft.draftNonce, "draftNonce", 128),
    };
    const result = await this.db.query<{ id: string; expires_at: Date }>(
      `insert into map_handoffs(account_id,session_id,allowed_origin,request_payload,expires_at)
       values($1,$2,$3,$4,now()+interval '5 minutes') returning id,expires_at`,
      [session.account.id, session.id, allowedOrigin, JSON.stringify(initial)],
    );
    const row = result.rows[0]!;
    return {
      handoffId: row.id,
      url: `${this.config.value.publicOrigin}/map-picker?handoffId=${row.id}`,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async loadHandoff(id: string, origin: string | undefined) {
    requireUuid(id, "handoffId");
    const result = await this.db.query<{
      request_payload: Record<string, unknown>;
      allowed_origin: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      "select request_payload,allowed_origin,expires_at,consumed_at from map_handoffs where id=$1",
      [id],
    );
    const row = result.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now() || row.consumed_at)
      throw new ApiError("HANDOFF_EXPIRED", "Map handoff is expired", 410);
    this.assertOrigin(row.allowed_origin, origin);
    return {
      handoffId: id,
      initial: row.request_payload,
      kakaoJavascriptKey: this.config.value.kakaoJavascriptKey ?? null,
    };
  }

  async searchHandoff(
    id: string,
    origin: string | undefined,
    type: "address" | "keyword",
    searchQuery: string,
    page = 1,
  ): Promise<unknown> {
    requireUuid(id, "handoffId");
    const result = await this.db.query<{
      account_id: string;
      allowed_origin: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      "select account_id,allowed_origin,expires_at,consumed_at from map_handoffs where id=$1",
      [id],
    );
    const row = result.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now() || row.consumed_at) {
      throw new ApiError("HANDOFF_EXPIRED", "Map handoff is expired", 410);
    }
    this.assertOrigin(row.allowed_origin, origin);
    return this.search(row.account_id, type, searchQuery, page);
  }

  async submitHandoff(
    id: string,
    origin: string | undefined,
    input: {
      latitude: number;
      longitude: number;
      radiusMeters: number;
      name: string;
      address: string;
      placeMetadata?: Record<string, unknown>;
    },
  ) {
    requireUuid(id, "handoffId");
    if (!input || typeof input !== "object")
      throw new ApiError("VALIDATION_ERROR", "Map result body is required");
    const result = await this.db.transaction(async (query) => {
      const existing = await query<{
        allowed_origin: string;
        expires_at: Date;
        consumed_at: Date | null;
        account_id: string;
        request_payload: { draftNonce?: string };
      }>(
        "select allowed_origin,expires_at,consumed_at,account_id,request_payload from map_handoffs where id=$1 for update",
        [id],
      );
      const row = existing.rows[0];
      if (!row || row.expires_at.getTime() <= Date.now() || row.consumed_at)
        throw new ApiError("HANDOFF_EXPIRED", "Map handoff is expired", 410);
      this.assertOrigin(row.allowed_origin, origin);
      const payload = {
        latitude: requireNumber(input.latitude, "latitude", -90, 90),
        longitude: requireNumber(input.longitude, "longitude", -180, 180),
        radiusMeters: requireInteger(
          input.radiusMeters,
          "radiusMeters",
          100,
          5000,
        ),
        name: requireString(input.name, "name", 100),
        address: requireString(input.address, "address", 300),
        placeMetadata: input.placeMetadata ?? null,
      };
      await query(
        "update map_handoffs set result_payload=$2,consumed_at=now() where id=$1",
        [id, JSON.stringify(payload)],
      );
      return {
        type: "LOCATION_TODO_MAP_RESULT" as const,
        handoffId: id,
        accountId: row.account_id,
        draftNonce: row.request_payload.draftNonce,
        ...payload,
      };
    });
    return result;
  }

  async result(session: ServiceSession, id: string) {
    requireUuid(id, "handoffId");
    const response = await this.db.query<{
      result_payload: Record<string, unknown> | null;
      consumed_at: Date | null;
      expires_at: Date;
    }>(
      "select result_payload,consumed_at,expires_at from map_handoffs where id=$1 and account_id=$2 and session_id=$3",
      [id, session.account.id, session.id],
    );
    const row = response.rows[0];
    if (!row)
      throw new ApiError("HANDOFF_NOT_FOUND", "Map handoff not found", 404);
    return {
      handoffId: id,
      status: row.result_payload
        ? "completed"
        : row.expires_at.getTime() <= Date.now()
          ? "expired"
          : "pending",
      result: row.result_payload,
    };
  }

  private async rateLimit(key: string): Promise<void> {
    const result = await this.db.query(
      `insert into rate_limit_counters(scope,subject,window_start,count)
       values('kakao_search',$1,date_trunc('minute',now()),1)
       on conflict(scope,subject,window_start) do update
       set count=rate_limit_counters.count+1 where rate_limit_counters.count<60
       returning count`,
      [key],
    );
    if (!result.rowCount)
      throw new ApiError(
        "RATE_LIMITED",
        "Kakao search rate limit exceeded",
        429,
      );
  }

  private assertOrigin(allowed: string, origin: string | undefined): void {
    const actual = origin
      ? new URL(origin).origin
      : this.config.value.publicOrigin;
    if (actual !== allowed)
      throw new ApiError(
        "ORIGIN_NOT_ALLOWED",
        "Map handoff origin is not allowed",
        403,
      );
  }
}
