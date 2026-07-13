import { Module } from "@nestjs/common";
import { RetentionController } from "./retention.controller";
import { RetentionService } from "./retention.service";

@Module({
  providers: [RetentionService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
