import {
  localToInstant,
  nextOccurrence,
  occurrenceForObservedDate,
  scheduleEligible,
  validateWindows,
} from "../src/todos/recurrence";

describe("recurrence authority", () => {
  test("schedules daily, weekly, and monthly rules without backfill", () => {
    expect(
      nextOccurrence(
        { type: "DAILY", startDate: "2026-07-01" },
        "09:00",
        new Date("2026-07-13T00:00:00.000Z"),
      ),
    ).toMatchObject({ occurrenceKey: "2026-07-14T09:00" });

    expect(
      nextOccurrence(
        { type: "WEEKLY", startDate: "2026-07-01", weekdays: [1, 4] },
        "09:00",
        new Date("2026-07-13T01:00:00.000Z"),
      ),
    ).toMatchObject({ occurrenceKey: "2026-07-16T09:00" });

    expect(
      nextOccurrence(
        { type: "MONTHLY", startDate: "2026-01-01", monthDays: [31] },
        "12:00",
        new Date("2026-04-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ occurrenceKey: "2026-05-31T12:00" });
  });

  test("converts the fixed Asia/Seoul local time to an instant", () => {
    expect(
      localToInstant({ date: "2026-03-08", time: "02:30" }).toISOString(),
    ).toBe("2026-03-07T17:30:00.000Z");
    expect(
      localToInstant({ date: "2026-11-01", time: "09:00" }).toISOString(),
    ).toBe("2026-11-01T00:00:00.000Z");
  });

  test("uses local recurrence dates for location observations", () => {
    expect(
      occurrenceForObservedDate(
        { type: "WEEKLY", startDate: "2026-07-01", weekdays: [1] },
        new Date("2026-07-12T15:30:00.000Z"),
      ),
    ).toEqual({ occurrenceKey: "2026-07-13", localDate: "2026-07-13" });
  });

  test("keeps undated ONCE location schedules open after their start date", () => {
    const rule = { type: "ONCE" as const, startDate: "2026-07-01" };
    expect(
      occurrenceForObservedDate(rule, new Date("2026-07-13T10:00:00.000Z"), {
        openEnded: true,
      }),
    ).toEqual({ occurrenceKey: "ONCE", localDate: "2026-07-13" });
    expect(
      occurrenceForObservedDate(rule, new Date("2026-07-13T10:00:00.000Z"), {
        openEnded: false,
        fixedDates: ["2026-07-14"],
      }),
    ).toBeNull();
    expect(
      occurrenceForObservedDate(rule, new Date("2026-07-13T10:00:00.000Z"), {
        openEnded: true,
        fixedDates: ["2026-07-14"],
      }),
    ).toEqual({ occurrenceKey: "ONCE", localDate: "2026-07-13" });
  });

  test("supports end-only 24:00 and rejects cross-midnight windows", () => {
    const windows = validateWindows(
      [{ startTime: "22:00", endTime: "24:00" }],
      "DAILY",
    );
    expect(
      scheduleEligible(new Date("2026-07-13T14:00:00.000Z"), windows),
    ).toBe(true);
    expect(
      scheduleEligible(new Date("2026-07-13T15:00:00.000Z"), windows),
    ).toBe(false);
    expect(() =>
      validateWindows([{ startTime: "22:00", endTime: "02:00" }], "DAILY"),
    ).toThrow("schedule window start must be before end");
  });

  test("rejects fixed dates on repeating location windows", () => {
    expect(() =>
      validateWindows(
        [{ date: "2026-07-13", startTime: "09:00", endTime: "10:00" }],
        "WEEKLY",
      ),
    ).toThrow("cannot have a fixed date");
  });
});
