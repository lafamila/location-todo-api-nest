import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentAccount } from "../auth/current";
import { AuthAccount } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { GeofenceInput, GeofenceService } from "./geofence.service";

@UseGuards(SessionGuard)
@Controller("geofences")
export class GeofenceController {
  constructor(private readonly geofences: GeofenceService) {}

  @Get()
  async list(
    @CurrentAccount() account: AuthAccount,
    @Query("deleted") deleted?: string,
  ) {
    return {
      geofences: await this.geofences.list(account.id, deleted === "true"),
    };
  }

  @Get("monitoring-projection")
  async projection(@CurrentAccount() account: AuthAccount) {
    return { geofences: await this.geofences.projection(account.id) };
  }

  @Get(":id")
  get(@CurrentAccount() account: AuthAccount, @Param("id") id: string) {
    return this.geofences.get(account.id, id);
  }

  @Post()
  create(@CurrentAccount() account: AuthAccount, @Body() body: GeofenceInput) {
    return this.geofences.create(account, body);
  }

  @Patch(":id")
  update(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body: GeofenceInput & { version: number },
  ) {
    return this.geofences.update(account.id, id, body);
  }

  @Delete(":id")
  remove(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.geofences.remove(account.id, id, body?.version as number);
  }

  @Post(":id/restore")
  restore(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.geofences.restore(account, id, body?.version as number);
  }
}
