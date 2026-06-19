import type { RuntimeTimeMetadata } from "@socrates/contracts"

export const currentRuntimeTime = (date = new Date()): RuntimeTimeMetadata => {
  const timeZone = systemTimezone()
  return {
    currentDate: formatLocalDate(date, timeZone),
    currentDateTime: date.toISOString(),
    timeZone,
    source: "system",
  }
}

export const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "system-local"

export const formatLocalDate = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  const year = part("year")
  const month = part("month")
  const day = part("day")
  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10)
}
