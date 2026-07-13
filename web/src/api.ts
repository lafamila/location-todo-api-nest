export interface Account {
  id: string;
  displayName: string;
  email?: string;
  permission: "visitor" | "user" | "superadmin";
}

export interface Quota {
  permission: Account["permission"];
  locationTodos: { used: number; limit: number | null };
  savedGeofences: { used: number; limit: number };
  timeTodos: { used: number; limit: null };
  upgradeStatus: string | null;
}

export interface Geofence {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  placeMetadata?: Record<string, unknown> | null;
  version: number;
  deletedAt?: string | null;
}

export interface Todo {
  id: string;
  content: string;
  kind: "LOCATION" | "TIME";
  timezone: string;
  recurrence: {
    type: string;
    startDate: string;
    weekdays?: number[];
    monthDays?: number[];
  };
  localTime?: string | null;
  triggerCondition?: {
    type: string;
    delayMinutes?: number;
    dwellMinutes?: number;
  } | null;
  scheduleWindows: Array<{
    date?: string | null;
    startTime: string;
    endTime: string;
  }>;
  geofenceIds: string[];
  active: boolean;
  lifecycleStatus: string;
  nextOccurrenceAt?: string | null;
  version: number;
  deletedAt?: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function csrf(): string | undefined {
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith("location_todo_csrf="))
    ?.split("=")[1];
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = csrf();
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-csrf-token": decodeURIComponent(token) } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
  };
  if (!response.ok) {
    throw new ApiError(
      body.error?.code || "REQUEST_FAILED",
      body.error?.message || "Request failed",
      body.error?.details,
    );
  }
  return body as T;
}

export function actionMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.";
  const messages: Record<string, string> = {
    QUOTA_EXCEEDED:
      "현재 권한의 저장 한도에 도달했습니다. 권한 요청 또는 기존 항목 정리가 필요합니다.",
    VERSION_CONFLICT:
      "다른 기기에서 변경되었습니다. 목록을 새로고침한 뒤 다시 시도하세요.",
    GEOFENCE_IN_USE: "사용 중인 TODO에서 이 위치를 먼저 제거하세요.",
    AUTH_REQUIRED: "세션이 만료되었습니다. 다시 로그인하세요.",
    CSRF_INVALID: "보안 토큰이 만료되었습니다. 페이지를 새로고침하세요.",
    KAKAO_NOT_CONFIGURED: "지도 검색이 아직 구성되지 않았습니다.",
  };
  return messages[error.code] || error.message;
}
