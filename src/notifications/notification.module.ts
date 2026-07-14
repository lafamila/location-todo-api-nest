import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { DueWorkerService } from "./due-worker.service";
import { FcmService } from "./fcm.service";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { OutboxWorkerService } from "./outbox-worker.service";
import { TriggerService } from "./trigger.service";

@Module({
  imports: [RealtimeModule],
  providers: [
    TriggerService,
    NotificationService,
    FcmService,
    DueWorkerService,
    OutboxWorkerService,
  ],
  controllers: [NotificationController],
  exports: [TriggerService, DueWorkerService, OutboxWorkerService, FcmService],
})
export class NotificationModule {}
