import { Module } from "@nestjs/common";
import { NotificationModule } from "../notifications/notification.module";
import { TransitionController } from "./transition.controller";
import { TransitionService } from "./transition.service";

@Module({
  imports: [NotificationModule],
  providers: [TransitionService],
  controllers: [TransitionController],
})
export class TransitionModule {}
