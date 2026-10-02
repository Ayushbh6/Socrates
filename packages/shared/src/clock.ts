/** Injectable clock so routing and ledger time are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(start: Date | string): Clock & { set(date: Date | string): void; advance(ms: number): void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (date) => {
      current = new Date(date);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Render a date in a fixed IANA time zone as parts, without external libraries. */
export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
    weekday: get("weekday") || WEEKDAYS[date.getUTCDay()]!,
  };
}

/**
 * The instant a calendar day (YYYY-MM-DD) begins in an IANA time zone, so
 * date filters in the user's zone can be applied to UTC timestamps in SQL.
 */
export function zonedDayStart(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  // Two corrections settle any offset, including days that start inside a DST change.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const [ph, pmin] = p.time.split(":").map(Number) as [number, number];
    const shown = Date.UTC(py, pm - 1, pd, ph, pmin);
    guess += target - shown;
  }
  return new Date(guess);
}

/** The calendar day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
