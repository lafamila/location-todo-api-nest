export type Permission = "visitor" | "user" | "superadmin";
export type Platform = "ios" | "android" | "macos" | "windows" | "web";
export type TodoKind = "LOCATION" | "TIME";
export type RecurrenceType = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
export type TodoLifecycle = "ACTIVE" | "INACTIVE" | "TRIGGERED" | "COMPLETED";

export interface RecurrenceRuleDto {
  type: RecurrenceType;
  startDate: string;
  weekdays?: number[];
  monthDays?: number[];
}

export interface ScheduleWindowDto {
  date?: string | null;
  startTime: string;
  endTime: string;
}

export type TriggerConditionDto =
  | { type: "ENTRY_IMMEDIATE" }
  | { type: "ENTRY_DELAYED"; delayMinutes: number }
  | { type: "DWELL"; dwellMinutes: number };

export interface SavedGeofenceDto {
  id: string;
  name: string;
  address: string;
  placeMetadata?: Record<string, unknown> | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  version: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoDto {
  id: string;
  content: string;
  kind: TodoKind;
  timezone: string;
  recurrence: RecurrenceRuleDto;
  localTime?: string | null;
  triggerCondition?: TriggerConditionDto | null;
  scheduleWindows: ScheduleWindowDto[];
  geofenceIds: string[];
  active: boolean;
  lifecycleStatus: TodoLifecycle;
  version: number;
  nextOccurrenceAt?: string | null;
  lastTriggeredAt?: string | null;
  completedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStartRequest {
  clientKind: "web" | "native";
  returnUri?: string;
  installationId?: string;
  platform?: Platform;
  appVersion?: string;
}

export interface SessionStartResponse {
  authorizeUrl: string;
  loginTransactionId: string;
  expiresAt: string;
}

export interface NativeSessionCompleteResponse {
  sessionToken: string;
  expiresAt: string;
  account: {
    id: string;
    displayName: string;
    email?: string;
    permission: Permission;
  };
}

export interface TransitionEventDto {
  id: string;
  sequence: number;
  geofenceId: string;
  transition: "ENTER" | "EXIT";
  observedAt: string;
  accuracyMeters?: number;
}

export interface TransitionAckDto {
  id: string;
  sequence: number;
  status: "ACCEPTED" | "DUPLICATE" | "IGNORED";
  disposition: string;
}

export interface NotificationEnvelopeDto {
  eventId: string;
  cursor: number;
  type: "TODO_TRIGGERED";
  todoId: string;
  occurrenceKey: string;
  content: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface QuotaDto {
  permission: Permission;
  locationTodos: { used: number; limit: number | null };
  savedGeofences: { used: number; limit: number };
  timeTodos: { used: number; limit: null };
  upgradeStatus: "available" | "pending" | "approved" | "rejected" | null;
}
