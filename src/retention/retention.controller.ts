import { Controller, Delete, UseGuards } from "@nestjs/common";
import { CurrentAccount } from "../auth/current";
import { AuthAccount } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { RetentionService } from "./retention.service";

@UseGuards(SessionGuard)
@Controller("account")
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Delete()
  deleteAccount(@CurrentAccount() account: AuthAccount) {
    return this.retention.deleteAccount(account.id);
  }
}
