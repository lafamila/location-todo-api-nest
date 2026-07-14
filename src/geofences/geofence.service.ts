import { Injectable } from "@nestjs/common";
import { AuthAccount } from "../auth/auth.types";
import {
  ApiError,
  requireInteger,
  requireNumber,
  requireString,
  requireUuid,
} from "../common/errors";
import { lockMonitoringGraph } from "../common/monitoring-lock";
import { SavedGeofenceDto } from "../contracts/v1";
import { DatabaseService } from "../database/database.service";
import { QuotaService } from "../quota/quota.service";

interface GeofenceRow {
  id: string;
  name: string;
  address: string;
  place_metadata: Record<string, unknown> | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GeofenceInput {
  name: string;
  address: string;
  placeMetadata?: Record<string, unknown> | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

@Injectable()
export class GeofenceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly quota: QuotaService,
  ) {}

  async list(accountId: string, deleted = false): Promise<SavedGeofenceDto[]> {
    const result = await this.db.query<GeofenceRow>(
      `select * from saved_geofences where account_id=$1 and ${deleted ? "deleted_at is not null" : "deleted_at is null"} order by updated_at desc`,
      [accountId],
    );
    return result.rows.map(toDto);
  }

  async get(accountId: string, id: string): Promise<SavedGeofenceDto> {
    requireUuid(id, "geofenceId");
    const result = await this.db.query<GeofenceRow>(
      "select * from saved_geofences where id=$1 and account_id=$2",
      [id, accountId],
    );
    if (!result.rows[0])
      throw new ApiError("GEOFENCE_NOT_FOUND", "Saved geofence not found", 404);
    return toDto(result.rows[0]);
  }

  async create(
    account: AuthAccount,
    input: GeofenceInput,
  ): Promise<SavedGeofenceDto> {
    const value = validateInput(input);
    return this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      await this.quota.assertAvailable(account, "savedGeofence", query);
      const result = await query<GeofenceRow>(
        `insert into saved_geofences(account_id,name,address,place_metadata,latitude,longitude,radius_meters)
         values($1,$2,$3,$4,$5,$6,$7) returning *`,
        [
          account.id,
          value.name,
          value.address,
          value.placeMetadata,
          value.latitude,
          value.longitude,
          value.radiusMeters,
        ],
      );
      return toDto(result.rows[0]!);
    });
  }

  async update(
    accountId: string,
    id: string,
    input: GeofenceInput & { version: number },
  ): Promise<SavedGeofenceDto> {
    requireUuid(id, "geofenceId");
    const value = validateInput(input);
    const version = requireInteger(input.version, "version", 1, 2_147_483_647);
    return this.db.transaction(async (query) => {
      await lockMonitoringGraph(accountId, query);
      const owned = await query<GeofenceRow>(
        `select * from saved_geofences where id=$1 and account_id=$2 for update`,
        [id, accountId],
      );
      const current = owned.rows[0];
      if (!current)
        throw new ApiError(
          "GEOFENCE_NOT_FOUND",
          "Saved geofence not found",
          404,
        );
      if (current.deleted_at || current.version !== version)
        throw new ApiError("VERSION_CONFLICT", "Geofence version changed", 409);
      const linked = await query<{ id: string }>(
        `select t.id from todos t join todo_geofences tg on tg.todo_id=t.id
         where tg.geofence_id=$1 and t.account_id=$2
         and t.active and t.deleted_at is null for update of t`,
        [id, accountId],
      );
      const todoIds = linked.rows.map((row) => row.id);
      const result = await query<GeofenceRow>(
        `update saved_geofences set name=$3,address=$4,place_metadata=$5,latitude=$6,longitude=$7,radius_meters=$8,
         version=version+1,updated_at=now() where id=$1 and account_id=$2 returning *`,
        [
          id,
          accountId,
          value.name,
          value.address,
          value.placeMetadata,
          value.latitude,
          value.longitude,
          value.radiusMeters,
        ],
      );
      if (todoIds.length) {
        await query(
          `update todos set activation_generation=activation_generation+1,activated_at=now(),updated_at=now()
           where id=any($1::uuid[])`,
          [todoIds],
        );
        const occurrences = await query<{ id: string }>(
          `select id from todo_occurrences where todo_id=any($1::uuid[]) and status='PENDING' for update`,
          [todoIds],
        );
        const occurrenceIds = occurrences.rows.map((row) => row.id);
        if (occurrenceIds.length) {
          await query(
            `update due_jobs set status='CANCELLED' where occurrence_id=any($1::uuid[])
             and status in ('PENDING','RUNNING')`,
            [occurrenceIds],
          );
          await query(
            `update todo_occurrences set status='CANCELLED' where id=any($1::uuid[])`,
            [occurrenceIds],
          );
        }
        await query(
          `delete from device_geofence_states where todo_id=any($1::uuid[])`,
          [todoIds],
        );
      }
      return toDto(result.rows[0]!);
    });
  }

  async remove(
    accountId: string,
    id: string,
    version: number,
  ): Promise<{ ok: true }> {
    requireUuid(id, "geofenceId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(accountId, query);
      const owned = await query<{ version: number; deleted_at: Date | null }>(
        `select version,deleted_at from saved_geofences where id=$1 and account_id=$2 for update`,
        [id, accountId],
      );
      const row = owned.rows[0];
      if (!row)
        throw new ApiError(
          "GEOFENCE_NOT_FOUND",
          "Saved geofence not found",
          404,
        );
      if (row.deleted_at || row.version !== version)
        throw new ApiError("VERSION_CONFLICT", "Geofence version changed", 409);
      const relation = await query<{ count: number }>(
        `select count(*)::int count from todo_geofences tg join todos t on t.id=tg.todo_id
         where tg.geofence_id=$1 and t.account_id=$2 and t.deleted_at is null and t.lifecycle_status not in ('COMPLETED')`,
        [id, accountId],
      );
      if ((relation.rows[0]?.count ?? 0) > 0) {
        throw new ApiError(
          "GEOFENCE_IN_USE",
          "Remove this geofence from active or uncompleted TODOs before deleting it",
          409,
        );
      }
      const result = await query(
        `update saved_geofences set deleted_at=now(),version=version+1,updated_at=now()
         where id=$1 and account_id=$2 and deleted_at is null and version=$3`,
        [id, accountId, version],
      );
      if (!result.rowCount) throw new Error("Locked geofence update failed");
    });
    return { ok: true };
  }

  async restore(
    account: AuthAccount,
    id: string,
    version: number,
  ): Promise<SavedGeofenceDto> {
    requireUuid(id, "geofenceId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    return this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      const owned = await query<{ version: number; deleted_at: Date | null }>(
        `select version,deleted_at from saved_geofences where id=$1 and account_id=$2 for update`,
        [id, account.id],
      );
      const row = owned.rows[0];
      if (!row)
        throw new ApiError(
          "GEOFENCE_NOT_FOUND",
          "Saved geofence not found",
          404,
        );
      if (!row.deleted_at || row.version !== version)
        throw new ApiError(
          "VERSION_CONFLICT",
          "Geofence cannot be restored with this version",
          409,
        );
      await this.quota.assertAvailable(account, "savedGeofence", query);
      const result = await query<GeofenceRow>(
        `update saved_geofences set deleted_at=null,version=version+1,updated_at=now()
         where id=$1 and account_id=$2 and deleted_at is not null and version=$3 returning *`,
        [id, account.id, version],
      );
      if (!result.rows[0]) throw new Error("Locked geofence restore failed");
      return toDto(result.rows[0]);
    });
  }

  async projection(accountId: string): Promise<SavedGeofenceDto[]> {
    const result = await this.db.query<GeofenceRow>(
      `select distinct g.* from saved_geofences g join todo_geofences tg on tg.geofence_id=g.id join todos t on t.id=tg.todo_id
       where g.account_id=$1 and g.deleted_at is null and t.deleted_at is null and t.active
       and t.lifecycle_status in ('ACTIVE','TRIGGERED') order by g.updated_at desc`,
      [accountId],
    );
    return result.rows.map(toDto);
  }
}

function validateInput(input: GeofenceInput): GeofenceInput {
  if (!input || typeof input !== "object")
    throw new ApiError("VALIDATION_ERROR", "Geofence body is required");
  const placeMetadata = input.placeMetadata ?? null;
  if (
    placeMetadata !== null &&
    (typeof placeMetadata !== "object" || Array.isArray(placeMetadata))
  ) {
    throw new ApiError("VALIDATION_ERROR", "placeMetadata must be an object");
  }
  return {
    name: requireString(input.name, "name", 100),
    address: requireString(input.address, "address", 300),
    placeMetadata,
    latitude: requireNumber(input.latitude, "latitude", -90, 90),
    longitude: requireNumber(input.longitude, "longitude", -180, 180),
    radiusMeters: requireInteger(input.radiusMeters, "radiusMeters", 100, 5000),
  };
}

function toDto(row: GeofenceRow): SavedGeofenceDto {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    placeMetadata: row.place_metadata,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radius_meters,
    version: row.version,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
