export function planDayOfWeek(date = new Date()) {
  return (date.getDay() + 6) % 7
}

export function parsePositiveInteger(value: string | null) {
  if (value == null || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parsePlanDay(value: string | null) {
  if (value == null || !/^\d$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 0 && parsed <= 6 ? parsed : null
}
