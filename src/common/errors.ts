import { HttpException, HttpStatus } from "@nestjs/common";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends HttpException {
  constructor(
    code: string,
    message: string,
    status = HttpStatus.BAD_REQUEST,
    details?: Record<string, unknown>,
  ) {
    super(
      {
        error: { code, message, ...(details ? { details } : {}) },
      } satisfies ApiErrorBody,
      status,
    );
    this.message = message;
  }
}

export function requireString(
  value: unknown,
  name: string,
  max: number,
  min = 1,
): string {
  if (typeof value !== "string")
    throw new ApiError("VALIDATION_ERROR", `${name} must be a string`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `${name} length must be ${min}..${max}`,
    );
  }
  return result;
}

export function requireUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new ApiError("VALIDATION_ERROR", `${name} must be a UUID`);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value as number;
}

export function requireNumber(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `${name} must be between ${min} and ${max}`,
    );
  }
  return value;
}
