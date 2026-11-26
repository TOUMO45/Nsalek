// When to look at the cloud. Pure, so the timing can be tested without a browser.

/** Quiet time after the last entry before sending. */
export const SETTLE = 4_000;
/** Least time between two saves; a big notebook on a slow phone gets more. */
export const MIN_GAP = 15_000;
/** While the app is open, how often another phone's newer copy is looked for. */
export const LOOK = 5 * 60_000;

export function waitBeforeSave(now: number, lastEnd: number, lastDuration: number): number {
  const gap = Math.min(5 * 60_000, Math.max(MIN_GAP, lastDuration * 4));
  return Math.max(SETTLE, lastEnd + gap - now);
}

/** Wait before trying again after `code`, or null when only the person can change something. */
export function waitAfterError(code: string, failures: number): number | null {
  if (code === "cloud_moved") return Math.min(30_000, 3_000 * failures);
  if (code === "cloud_offline") return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(failures - 1, 5));
  if (code === "cloud_quota") return 30 * 60_000;
  if (code === "cloud_failed") return Math.min(10 * 60_000, 60_000 * failures);
  return null;
}
