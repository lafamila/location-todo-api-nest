import { Controller, Get, UseGuards } from "@nestjs/common";
import { CurrentAccount } from "../auth/current";
import { AuthAccount } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { QuotaService } from "./quota.service";

@UseGuards(SessionGuard)
@Controller("quota")
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get()
  get(@CurrentAccount() account: AuthAccount) {
    return this.quota.get(account);
  }
}
