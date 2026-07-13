import { ApiError } from "../common/errors";
import { RecurrenceRuleDto } from "../contracts/v1";

export interface LocalDateTime {
  date: string;
  time: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new ApiError("VALIDATION_ERROR", "timezone must be an IANA timezone");
  }
}

export function validateLocalDate(value: string, name = "date"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ApiError("VALIDATION_ERROR", `${name} must be YYYY-MM-DD`);
  const parts = parseDate(value);
  if (formatDate(parts) !== value)
    throw new ApiError(
      "VALIDATION_ERROR",
      `${name} is not a valid calendar date`,
    );
  return value;
}

export function validateLocalTime(value: string, allow2400 = false): string {
  if (allow2400 && value === "24:00") return value;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "time must be HH:mm");
  }
  return value;
}

export function normalizeRule(input: RecurrenceRuleDto): RecurrenceRuleDto {
  if (!input || !["ONCE", "DAILY", "WEEKLY", "MONTHLY"].includes(input.type)) {
    throw new ApiError("VALIDATION_ERROR", "recurrence.type is invalid");
  }
  const startDate = validateLocalDate(input.startDate, "recurrence.startDate");
  if (input.type === "WEEKLY") {
    const weekdays = uniqueSorted(input.weekdays, 1, 7, "recurrence.weekdays");
    if (!weekdays.length)
      throw new ApiError(
        "VALIDATION_ERROR",
        "WEEKLY recurrence requires weekdays",
      );
    return { type: input.type, startDate, weekdays };
  }
  if (input.type === "MONTHLY") {
    const monthDays = uniqueSorted(
      input.monthDays,
      1,
      31,
      "recurrence.monthDays",
    );
    if (!monthDays.length)
      throw new ApiError(
        "VALIDATION_ERROR",
        "MONTHLY recurrence requires monthDays",
      );
    return { type: input.type, startDate, monthDays };
  }
  return { type: input.type, startDate };
}

function uniqueSorted(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number[] {
  if (!Array.isArray(value))
    throw new ApiError("VALIDATION_ERROR", `${name} must be an array`);
  if (
    value.some((item) => !Number.isInteger(item) || item < min || item > max)
  ) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `${name} values must be ${min}..${max}`,
    );
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

export function nextOccurrence(
  ruleInput: RecurrenceRuleDto,
  localTime: string,
  timezone: string,
  after: Date,
): { occurrenceKey: string; dueAt: Date; localDate: string } | null {
  const rule = normalizeRule(ruleInput);
  validateLocalTime(localTime);
  validateTimezone(timezone);
  const afterLocal = zonedParts(after, timezone);
  const start = parseDate(rule.startDate);
  let cursor =
    compareDate(start, afterLocal.date) > 0 ? start : afterLocal.date;
  const max = addDays(afterLocal.date, 3700);
  while (compareDate(cursor, max) <= 0) {
    if (matchesRule(cursor, rule)) {
      const date = formatDate(cursor);
      const dueAt = localToInstant({ date, time: localTime }, timezone);
      if (dueAt.getTime() > after.getTime()) {
        return {
          occurrenceKey: `${date}T${localTime}`,
          dueAt,
          localDate: date,
        };
      }
      if (rule.type === "ONCE") return null;
    }
    cursor = addDays(cursor, 1);
  }
  return null;
}

export function occurrenceForObservedDate(
  ruleInput: RecurrenceRuleDto,
  observedAt: Date,
  timezone: string,
  once?: { openEnded: boolean; fixedDates?: string[] },
): { occurrenceKey: string; localDate: string } | null {
  const rule = normalizeRule(ruleInput);
  const date = zonedParts(observedAt, timezone).date;
  if (compareDate(date, parseDate(rule.startDate)) < 0) return null;
  if (rule.type === "ONCE" && once) {
    const localDate = formatDate(date);
    if (!once.openEnded && !(once.fixedDates ?? []).includes(localDate)) {
      return null;
    }
    return { occurrenceKey: "ONCE", localDate };
  }
  if (!matchesRule(date, rule)) return null;
  return { occurrenceKey: formatDate(date), localDate: formatDate(date) };
}

export function localToInstant(input: LocalDateTime, timezone: string): Date {
  validateLocalDate(input.date);
  validateLocalTime(input.time);
  validateTimezone(timezone);
  const desired = localTuple(input.date, input.time);
  const approximate = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  let firstAfterGap: Date | undefined;
  for (
    let offsetMinutes = -24 * 60;
    offsetMinutes <= 24 * 60;
    offsetMinutes += 1
  ) {
    const instant = new Date(approximate + offsetMinutes * 60_000);
    const parts = zonedParts(instant, timezone);
    const comparison = compareTuple(parts, desired);
    if (comparison === 0) return instant;
    if (
      !firstAfterGap &&
      formatDate(parts.date) === input.date &&
      comparison > 0
    ) {
      firstAfterGap = instant;
    }
  }
  if (firstAfterGap) return firstAfterGap;
  throw new ApiError(
    "VALIDATION_ERROR",
    "local date/time cannot be resolved in timezone",
  );
}

export function zonedParts(
  instant: Date,
  timezone: string,
): {
  date: DateParts;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    date: { year: get("year"), month: get("month"), day: get("day") },
    hour: get("hour"),
    minute: get("minute"),
  };
}

export function scheduleEligible(
  observedAt: Date,
  timezone: string,
  windows: Array<{ date?: string | null; startTime: string; endTime: string }>,
): boolean {
  if (!windows.length) return true;
  const parts = zonedParts(observedAt, timezone);
  const date = formatDate(parts.date);
  const minute = parts.hour * 60 + parts.minute;
  return windows.some((window) => {
    if (window.date && window.date !== date) return false;
    const start = timeMinute(window.startTime, false);
    const end = timeMinute(window.endTime, true);
    return minute >= start && minute < end;
  });
}

export function validateWindows(
  windows: Array<{ date?: string | null; startTime: string; endTime: string }>,
  recurrenceType: string,
): Array<{ date?: string | null; startTime: string; endTime: string }> {
  if (!Array.isArray(windows) || windows.length > 32)
    throw new ApiError("VALIDATION_ERROR", "scheduleWindows is invalid");
  return windows.map((window) => {
    if (window.date) validateLocalDate(window.date, "scheduleWindow.date");
    if (recurrenceType !== "ONCE" && window.date) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Repeating location TODO windows cannot have a fixed date",
      );
    }
    validateLocalTime(window.startTime);
    validateLocalTime(window.endTime, true);
    if (
      timeMinute(window.startTime, false) >= timeMinute(window.endTime, true)
    ) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "schedule window start must be before end",
      );
    }
    return {
      date: window.date ?? null,
      startTime: window.startTime,
      endTime: window.endTime,
    };
  });
}

export function timeMinute(value: string, allow2400: boolean): number {
  validateLocalTime(value, allow2400);
  if (value === "24:00") return 1440;
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function matchesRule(date: DateParts, rule: RecurrenceRuleDto): boolean {
  if (rule.type === "ONCE") return formatDate(date) === rule.startDate;
  if (rule.type === "DAILY") return true;
  if (rule.type === "WEEKLY")
    return (rule.weekdays ?? []).includes(isoWeekday(date));
  return (rule.monthDays ?? []).includes(date.day);
}

function isoWeekday(date: DateParts): number {
  const weekday = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function parseDate(value: string): DateParts {
  const [year = "0", month = "0", day = "0"] = value.split("-");
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function formatDate(value: DateParts): string {
  const normalized = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return `${normalized.getUTCFullYear().toString().padStart(4, "0")}-${(normalized.getUTCMonth() + 1).toString().padStart(2, "0")}-${normalized.getUTCDate().toString().padStart(2, "0")}`;
}

function addDays(value: DateParts, days: number): DateParts {
  const result = new Date(
    Date.UTC(value.year, value.month - 1, value.day + days),
  );
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function compareDate(left: DateParts, right: DateParts): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function localTuple(
  date: string,
  time: string,
): DateParts & { hour: number; minute: number } {
  const parsed = parseDate(date);
  const [hour = "0", minute = "0"] = time.split(":");
  return { ...parsed, hour: Number(hour), minute: Number(minute) };
}

function compareTuple(
  left: { date: DateParts; hour: number; minute: number },
  right: DateParts & { hour: number; minute: number },
): number {
  const dateComparison = compareDate(left.date, right);
  if (dateComparison !== 0) return dateComparison;
  return left.hour * 60 + left.minute - (right.hour * 60 + right.minute);
}
