// Lightweight cron expression parser.
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
// Field formats: *, N, N-M, N-M/S, star/S, N,M,O

function matchField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

/**
 * Shift a Date to a target timezone offset (in minutes from UTC).
 * Returns a new Date whose UTC methods reflect the shifted local time.
 */
function shiftToTimezone(date: Date, timezone: string): Date {
  // Use Intl to get the offset for the given timezone
  const str = date.toLocaleString("en-US", { timeZone: timezone });
  const local = new Date(str);
  return local;
}

export function cronMatches(expr: string, date: Date, timezone: string): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const shifted = shiftToTimezone(date, timezone);

  return (
    matchField(minute, shifted.getMinutes()) &&
    matchField(hour, shifted.getHours()) &&
    matchField(dayOfMonth, shifted.getDate()) &&
    matchField(month, shifted.getMonth() + 1) &&
    matchField(dayOfWeek, shifted.getDay())
  );
}

export function nextCronMatch(expr: string, after: Date, timezone: string): Date {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Search up to 48 hours ahead
  for (let i = 0; i < 2880; i++) {
    if (cronMatches(expr, d, timezone)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return d; // fallback
}
