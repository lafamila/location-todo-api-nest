import { Injectable } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Namespace, Socket } from "socket.io";
import { SessionService } from "../auth/session.service";
import { RealtimeService } from "./realtime.service";

@Injectable()
@WebSocketGateway({
  namespace: "/realtime",
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Namespace): void {
    this.realtime.attach(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      typeof client.handshake.auth.token === "string"
        ? client.handshake.auth.token
        : undefined;
    try {
      const session = await this.sessions.authenticate(token, "header");
      client.data.locationTodoSessionToken = token;
      client.data.locationTodoAccountId = session.account.id;
      client.data.locationTodoDeviceId = session.deviceId;
      await client.join(`account:${session.account.id}`);
      client.emit("ready", { accountId: session.account.id });
    } catch {
      client.disconnect(true);
    }
  }
}
