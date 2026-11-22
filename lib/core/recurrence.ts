// Recurring obligations: one new obligation per agreed period. Unlike an installment, each
// occurrence is a new debt. Occurrence ids are derived from the plan id and the period key, so
// replays, restarts, restores and future sync cannot create a second debt for the same period.
import { addDays, addMonthsAnchored, isoWeekKey, monthKey } from "./dates.ts";
import type { ISODate, RecurringPlan } from "./types.ts";

export type Occurrence = { periodKey: string; date: ISODate; obligationId: string };

export const occurrenceId = (planId: string, periodKey: string) => `rec_${planId}_${periodKey}`;

function paused(plan: RecurringPlan, date: ISODate): boolean {
  return plan.pauses.some((p) => date >= p.from && (!p.to || date < p.to));
}

/** All occurrences from the start date up to `until` (inclusive), skipping paused periods. */
export function occurrencesUntil(plan: RecurringPlan, until: ISODate, max = 1000): Occurrence[] {
  const out: Occurrence[] = [];
  const anchor = +plan.startDate.slice(8, 10);
  for (let i = 0; i < max; i++) {
    const date = plan.frequency === "monthly" ? addMonthsAnchored(plan.startDate, i, anchor) : addDays(plan.startDate, 7 * i);
    if (date > until) break;
    if (plan.endDate && date > plan.endDate) break;
    if (plan.state === "ended" && plan.endedAt && date > plan.endedAt.slice(0, 10)) break;
    if (paused(plan, date)) continue;
    const periodKey = plan.frequency === "monthly" ? monthKey(date) : isoWeekKey(date);
    out.push({ periodKey, date, obligationId: occurrenceId(plan.id, periodKey) });
  }
  return out;
}

export function nextOccurrences(plan: RecurringPlan, after: ISODate, count = 3): Occurrence[] {
  const horizon = plan.frequency === "monthly" ? addMonthsAnchored(after, count + 1) : addDays(after, 7 * (count + 1));
  return occurrencesUntil(plan, horizon)
    .filter((o) => o.date > after)
    .slice(0, count);
}
