import { Global, Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SessionController } from "./session.controller";
import { SessionGuard } from "./session.guard";
import { SessionService } from "./session.service";
import { TokenCipher } from "./token-cipher";

@Global()
@Module({
  providers: [AuthService, SessionService, SessionGuard, TokenCipher],
  controllers: [SessionController],
  exports: [SessionService, SessionGuard, TokenCipher],
})
export class AuthModule {}
