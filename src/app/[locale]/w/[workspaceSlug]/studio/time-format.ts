// Timestamps of the Creator Studio as people read and type them.

/** 83_450 → "1:23.4" (minutes:seconds.tenths); hours are added past 60 minutes. */
export function formatTimestamp(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const seconds = Math.floor(tenths / 10) % 60;
  const minutes = Math.floor(tenths / 600) % 60;
  const hours = Math.floor(tenths / 36_000);
  const rest = `${String(seconds).padStart(2, "0")}.${tenths % 10}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Milliseconds as the seconds value of a form field ("83.45"). */
export function secondsInput(ms: number): string {
  return String(ms / 1000);
}
