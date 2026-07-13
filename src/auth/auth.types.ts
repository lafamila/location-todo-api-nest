import { Permission, Platform } from "../contracts/v1";

export interface AuthAccount {
  id: string;
  displayName: string;
  email?: string;
  permission: Permission;
  permissionSchemaVersion?: number;
}

export interface ServiceSession {
  id: string;
  account: AuthAccount;
  deviceId?: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  source: "cookie" | "header";
  platform?: Platform;
}

export interface AuthenticatedRequest {
  locationTodoSession: ServiceSession;
  locationTodoAccount: AuthAccount;
}
