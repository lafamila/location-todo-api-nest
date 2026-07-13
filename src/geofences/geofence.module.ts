import { Module } from "@nestjs/common";
import { QuotaModule } from "../quota/quota.module";
import { GeofenceController } from "./geofence.controller";
import { GeofenceService } from "./geofence.service";

@Module({
  imports: [QuotaModule],
  providers: [GeofenceService],
  controllers: [GeofenceController],
  exports: [GeofenceService],
})
export class GeofenceModule {}
