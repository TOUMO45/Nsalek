// Calendar dates as "YYYY-MM-DD" strings, computed in an explicit IANA time zone.
import type { ISODate } from "./types.ts";

export const DEFAULT_TIMEZONE = "Africa/Algiers";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date of `at` in time zone `tz`. */
export function todayIn(tz: string = DEFAULT_TIMEZONE, at: Date = new Date()): ISODate {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(tz, f);
  }
  return f.format(at);
}

/** Local "HH:MM" of `at` in time zone `tz`. */
export function timeIn(tz: string = DEFAULT_TIMEZONE, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const toUTC = (d: ISODate) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (ms: number): ISODate => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * 86_400_000);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / 86_400_000);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Adds whole months keeping the anchor day. When the target month is shorter, the last day of
 * that month is used (anchor 31: Jan 31 → Feb 28/29 → Mar 31 → Apr 30).
 */
export function addMonthsAnchored(start: ISODate, months: number, anchorDay = +start.slice(8, 10)): ISODate {
  const y = +start.slice(0, 4);
  const m = +start.slice(5, 7) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month1 = (((m % 12) + 12) % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

/** ISO week key "YYYY-Www" (weeks start Monday). */
export function isoWeekKey(date: ISODate): string {
  const d = new Date(toUTC(date));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** dd/mm/yyyy with Latin digits (stable in Arabic and French text). */
export function formatDate(date: ISODate | null | undefined, lang: "ar" | "fr" | "en" = "fr"): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  if (lang === "en") return `${d}/${m}/${y}`;
  return `${d}/${m}/${y}`;
}

export function formatDateTime(iso: string | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return "";
  const at = new Date(iso);
  return `${formatDate(todayIn(tz, at))} ${timeIn(tz, at)}`;
}
