import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentAccount, CurrentSession } from "../auth/current";
import { AuthAccount, ServiceSession } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { KakaoService } from "./kakao.service";

@Controller("kakao")
export class KakaoController {
  constructor(private readonly kakao: KakaoService) {}

  @UseGuards(SessionGuard)
  @Get("search")
  search(
    @CurrentAccount() account: AuthAccount,
    @Query("type") type: "address" | "keyword",
    @Query("q") query: string,
    @Query("page") page?: string,
  ) {
    return this.kakao.search(account.id, type, query, Number(page || 1));
  }

  @UseGuards(SessionGuard)
  @Post("map-handoffs")
  create(
    @CurrentSession() session: ServiceSession,
    @Body() body: Parameters<KakaoService["createHandoff"]>[1],
  ) {
    return this.kakao.createHandoff(session, body);
  }

  @Get("map-handoffs/:id")
  load(@Param("id") id: string, @Headers("origin") origin?: string) {
    return this.kakao.loadHandoff(id, origin);
  }

  @Get("map-handoffs/:id/search")
  searchHandoff(
    @Param("id") id: string,
    @Headers("origin") origin: string | undefined,
    @Query("type") type: "address" | "keyword",
    @Query("q") query: string,
    @Query("page") page?: string,
  ) {
    return this.kakao.searchHandoff(id, origin, type, query, Number(page || 1));
  }

  @Post("map-handoffs/:id/result")
  submit(
    @Param("id") id: string,
    @Headers("origin") origin: string | undefined,
    @Body() body: Parameters<KakaoService["submitHandoff"]>[2],
  ) {
    return this.kakao.submitHandoff(id, origin, body);
  }

  @UseGuards(SessionGuard)
  @Get("map-handoffs/:id/result")
  result(@CurrentSession() session: ServiceSession, @Param("id") id: string) {
    return this.kakao.result(session, id);
  }
}
