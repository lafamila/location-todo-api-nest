import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentAccount } from "../auth/current";
import { AuthAccount } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { NotificationService } from "./notification.service";

@UseGuards(SessionGuard)
@Controller("notifications")
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get("inbox")
  list(
    @CurrentAccount() account: AuthAccount,
    @Query("after") after?: string,
    @Query("limit") limit?: string,
  ) {
    return this.notifications.list(
      account.id,
      Number(after || 0),
      Number(limit || 50),
    );
  }

  @Post("inbox/ack")
  acknowledge(
    @CurrentAccount() account: AuthAccount,
    @Body() body?: { eventIds?: string[] },
  ) {
    return this.notifications.acknowledge(
      account.id,
      body?.eventIds as string[],
    );
  }
}
