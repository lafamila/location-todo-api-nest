import { Injectable } from "@nestjs/common";
import { AppConfig, loadAppConfig } from "./app-config";

@Injectable()
export class ConfigService {
  readonly value: AppConfig = loadAppConfig();
}
