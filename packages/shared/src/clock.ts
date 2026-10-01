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
