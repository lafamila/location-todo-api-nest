import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentAccount } from "../auth/current";
import { AuthAccount } from "../auth/auth.types";
import { SessionGuard } from "../auth/session.guard";
import { TodoInput, TodoService } from "./todo.service";

@UseGuards(SessionGuard)
@Controller("todos")
export class TodoController {
  constructor(private readonly todos: TodoService) {}

  @Get()
  async list(
    @CurrentAccount() account: AuthAccount,
    @Query("deleted") deleted?: string,
  ) {
    return { todos: await this.todos.list(account.id, deleted === "true") };
  }

  @Get(":id")
  get(@CurrentAccount() account: AuthAccount, @Param("id") id: string) {
    return this.todos.get(account.id, id);
  }

  @Post()
  create(@CurrentAccount() account: AuthAccount, @Body() body: TodoInput) {
    return this.todos.create(account, body);
  }

  @Patch(":id")
  update(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body: TodoInput & { version: number },
  ) {
    return this.todos.update(account, id, body);
  }

  @Post(":id/active")
  active(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { active?: boolean; version?: number },
  ) {
    return this.todos.setActive(
      account.id,
      id,
      body?.active as boolean,
      body?.version as number,
    );
  }

  @Post(":id/complete")
  complete(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.todos.complete(account.id, id, body?.version as number);
  }

  @Post(":id/reactivate")
  reactivate(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.todos.reactivate(account, id, body?.version as number);
  }

  @Delete(":id")
  remove(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.todos.remove(account.id, id, body?.version as number);
  }

  @Post(":id/restore")
  restore(
    @CurrentAccount() account: AuthAccount,
    @Param("id") id: string,
    @Body() body?: { version?: number },
  ) {
    return this.todos.restore(account, id, body?.version as number);
  }
}
