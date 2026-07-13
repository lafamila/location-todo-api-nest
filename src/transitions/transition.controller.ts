import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentSession } from "../auth/current";
import { ServiceSession } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { TransitionEventDto } from "../contracts/v1";
import { TransitionService } from "./transition.service";

@UseGuards(SessionGuard)
@Controller("transitions")
export class TransitionController {
  constructor(private readonly transitions: TransitionService) {}

  @Post("batch")
  upload(
    @CurrentSession() session: ServiceSession,
    @Body() body: { events: TransitionEventDto[] },
  ) {
    return this.transitions.upload(session, body);
  }
}
