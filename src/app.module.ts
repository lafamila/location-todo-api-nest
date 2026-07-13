import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { DeviceModule } from "./devices/device.module";
import { GeofenceModule } from "./geofences/geofence.module";
import { HealthController } from "./health.controller";
import { KakaoModule } from "./kakao/kakao.module";
import { NotificationModule } from "./notifications/notification.module";
import { QuotaModule } from "./quota/quota.module";
import { RetentionModule } from "./retention/retention.module";
import { TodoModule } from "./todos/todo.module";
import { TransitionModule } from "./transitions/transition.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    QuotaModule,
    DeviceModule,
    GeofenceModule,
    TodoModule,
    NotificationModule,
    TransitionModule,
    KakaoModule,
    RetentionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
