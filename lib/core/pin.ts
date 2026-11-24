// Wrong-PIN slowdown. The PIN is a privacy screen (not encryption), but a 4-digit code must not be
// guessable by simply trying them all: after 5 wrong tries each further try waits 30 s, doubling,
// up to 15 minutes. The counter is stored with the PIN, so reloading the app does not reset it.
const FREE_TRIES = 5;
const FIRST_DELAY = 30_000;
const MAX_DELAY = 15 * 60_000;

/** Wait required after `failures` consecutive wrong PINs. */
export function pinDelayMs(failures: number): number {
  if (failures < FREE_TRIES) return 0;
  return Math.min(MAX_DELAY, FIRST_DELAY * 2 ** Math.min(failures - FREE_TRIES, 20));
}
