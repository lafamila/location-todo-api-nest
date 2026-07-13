import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentAccount, CurrentSession } from "../auth/current";
import { AuthAccount, ServiceSession } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { Platform } from "../contracts/v1";
import { DeviceService } from "./device.service";

@UseGuards(SessionGuard)
@Controller("devices")
export class DeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Get()
  list(@CurrentAccount() account: AuthAccount) {
    return this.devices.list(account.id);
  }

  @Post("register")
  register(
    @CurrentSession() session: ServiceSession,
    @Body()
    body: {
      installationId: string;
      platform: Platform;
      appVersion: string;
      pushToken?: string | null;
    },
  ) {
    return this.devices.register(session, body);
  }

  @Delete(":id")
  revoke(@CurrentAccount() account: AuthAccount, @Param("id") id: string) {
    return this.devices.revoke(account.id, id);
  }
}
