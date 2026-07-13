import { Module } from "@nestjs/common";
import { KakaoController } from "./kakao.controller";
import { KakaoService } from "./kakao.service";

@Module({ providers: [KakaoService], controllers: [KakaoController] })
export class KakaoModule {}
