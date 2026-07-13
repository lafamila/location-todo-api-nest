import { Module } from "@nestjs/common";
import { QuotaController } from "./quota.controller";
import { QuotaService } from "./quota.service";

@Module({
  providers: [QuotaService],
  controllers: [QuotaController],
  exports: [QuotaService],
})
export class QuotaModule {}
