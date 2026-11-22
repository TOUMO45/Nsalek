// Collections: aging, due lists, promises, reminder queue and a daily action list built from
// transparent rules. There is no risk score.
import { addDays, daysBetween } from "./dates.ts";
import { installmentProgress } from "./installments.ts";
import { figuresOf, type LedgerIndex } from "./ledger.ts";
import type { CurrencyCode, Direction, ISODate, Minor, Obligation, Party, PromiseToPay, WorkspaceSettings } from "./types.ts";

export type AgingBucket = { key: string; min: number; max: number | null };

/**
 * Bucket boundaries are whole local days past the due date, inclusive.
 * bounds [7, 30, 60, 90] → 1–7, 8–30, 31–60, 61–90, 91+. Due today or later is "not_due";
 * debts without a due date are "no_due_date" and are never overdue.
 */
export function agingBuckets(bounds: number[]): AgingBucket[] {
  const out: AgingBucket[] = [];
  let min = 1;
  for (const b of bounds) {
    out.push({ key: `${min}-${b}`, min, max: b });
    min = b + 1;
  }
  out.push({ key: `${min}+`, min, max: null });
  return out;
}

export type AgingRow = { key: string; amount: Minor; count: number };
export type AgingReport = Map<CurrencyCode, { noDueDate: AgingRow; notDue: AgingRow; buckets: AgingRow[]; total: Minor }>;

export function agingReport(idx: LedgerIndex, today: ISODate, settings: WorkspaceSettings, direction: Direction): AgingReport {
  const buckets = agingBuckets(settings.agingBounds);
  const report: AgingReport = new Map();
  for (const ob of idx.obligation.values()) {
    if (ob.state !== "posted" || ob.direction !== direction) continue;
    const out = figuresOf(idx, ob).outstanding;
    if (out <= 0) continue;
    let r = report.get(ob.currency);
    if (!r) {
      r = {
        noDueDate: { key: "no_due_date", amount: 0, count: 0 },
        notDue: { key: "not_due", amount: 0, count: 0 },
        buckets: buckets.map((b) => ({ key: b.key, amount: 0, count: 0 })),
        total: 0,
      };
      report.set(ob.currency, r);
    }
    r.total += out;
    let row: AgingRow;
    if (!ob.dueDate) row = r.noDueDate;
    else {
      const d = daysBetween(ob.dueDate, today);
      if (d <= 0) row = r.notDue;
      else row = r.buckets[buckets.findIndex((b) => d >= b.min && (b.max === null || d <= b.max))];
    }
    row.amount += out;
    row.count++;
  }
  return report;
}

export type DueItem = { obligation: Obligation; party: Party; outstanding: Minor; daysPastDue: number };

function openReceivablesWith(idx: LedgerIndex, test: (o: Obligation) => boolean): DueItem[] {
  const out: DueItem[] = [];
  for (const ob of idx.obligation.values()) {
    if (ob.state !== "posted") continue;
    const outstanding = figuresOf(idx, ob).outstanding;
    if (outstanding <= 0 || !test(ob)) continue;
    const party = idx.party.get(ob.partyId);
    if (!party || party.mergedIntoId) continue;
    out.push({ obligation: ob, party, outstanding, daysPastDue: 0 });
  }
  return out;
}

export function overdueList(idx: LedgerIndex, today: ISODate, direction: Direction = "receivable"): DueItem[] {
  return openReceivablesWith(idx, (o) => o.direction === direction && !!o.dueDate && o.dueDate < today)
    .map((x) => ({ ...x, daysPastDue: daysBetween(x.obligation.dueDate!, today) }))
    .sort((a, b) => b.daysPastDue - a.daysPastDue || b.outstanding - a.outstanding);
}

export function dueBetween(idx: LedgerIndex, from: ISODate, to: ISODate, direction: Direction = "receivable"): DueItem[] {
  return openReceivablesWith(idx, (o) => o.direction === direction && !!o.dueDate && o.dueDate >= from && o.dueDate <= to).sort((a, b) =>
    a.obligation.dueDate!.localeCompare(b.obligation.dueDate!),
  );
}

export type PromiseState = "cancelled" | "kept" | "broken" | "due_today" | "pending";

/**
 * A promise is "kept" when received payments dated from the day it was made up to the promised
 * date reach the promised amount. A promise never changes any debt.
 */
export function promiseState(promise: PromiseToPay, idx: LedgerIndex, today: ISODate): { state: PromiseState; paid: Minor } {
  if (promise.cancelledAt) return { state: "cancelled", paid: 0 };
  const paid = (idx.payByParty.get(promise.partyId) ?? [])
    .filter(
      (p) =>
        p.state === "posted" &&
        p.direction === "receivable" &&
        p.currency === promise.currency &&
        p.date >= promise.madeOn &&
        p.date <= promise.promisedDate,
    )
    .reduce((n, p) => n + p.amount, 0);
  if (paid >= promise.amount) return { state: "kept", paid };
  if (promise.promisedDate < today) return { state: "broken", paid };
  if (promise.promisedDate === today) return { state: "due_today", paid };
  return { state: "pending", paid };
}

export type QueueItem = {
  party: Party;
  amounts: { currency: CurrencyCode; amount: Minor }[];
  oldestDue: ISODate | null;
  maxDaysPastDue: number;
  lastReminderAt: string | null;
  lastPaymentDate: ISODate | null;
  reason: "overdue" | "due_today" | "due_soon" | "remind_on";
};

const RECENT_REMINDER_STATES = new Set(["opened_for_sharing", "marked_sent", "provider_accepted", "delivered"]);

export function lastReminder(idx: LedgerIndex, partyId: string) {
  const list = (idx.remindersByParty.get(partyId) ?? []).filter((r) => RECENT_REMINDER_STATES.has(r.status));
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function lastPayment(idx: LedgerIndex, partyId: string) {
  return (idx.payByParty.get(partyId) ?? []).filter((p) => p.state === "posted").sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/**
 * Guided reminder queue: parties with an unpaid receivable that is overdue, due today, due soon
 * or past its follow-up date. Excludes settled, disputed and snoozed debts, archived parties and
 * parties reminded within `reminderMinDays`.
 */
export function reminderQueue(idx: LedgerIndex, today: ISODate, settings: WorkspaceSettings, opts: { ignoreFrequencyCap?: boolean } = {}): QueueItem[] {
  const soon = addDays(today, settings.dueSoonDays);
  const out: QueueItem[] = [];
  for (const party of idx.parties) {
    if (party.archivedAt || party.mergedIntoId) continue;
    if (party.snoozedUntil && party.snoozedUntil >= today) continue;
    const last = lastReminder(idx, party.id);
    if (!opts.ignoreFrequencyCap && last && daysBetween(last.createdAt.slice(0, 10), today) < settings.reminderMinDays) continue;
    const amounts = new Map<CurrencyCode, Minor>();
    let reason: QueueItem["reason"] | null = null;
    let oldestDue: ISODate | null = null;
    const rank = { overdue: 4, due_today: 3, remind_on: 2, due_soon: 1 } as const;
    for (const ob of idx.obByParty.get(party.id) ?? []) {
      if (ob.state !== "posted" || ob.direction !== "receivable" || ob.disputed) continue;
      const outstanding = figuresOf(idx, ob).outstanding;
      if (outstanding <= 0) continue;
      amounts.set(ob.currency, (amounts.get(ob.currency) ?? 0) + outstanding);
      let r: QueueItem["reason"] | null = null;
      if (ob.dueDate && ob.dueDate < today) r = "overdue";
      else if (ob.dueDate === today) r = "due_today";
      else if (ob.remindOn && ob.remindOn <= today) r = "remind_on";
      else if (ob.dueDate && ob.dueDate <= soon) r = "due_soon";
      if (r && (!reason || rank[r] > rank[reason])) reason = r;
      if (ob.dueDate && (!oldestDue || ob.dueDate < oldestDue)) oldestDue = ob.dueDate;
    }
    if (!reason || !amounts.size) continue;
    out.push({
      party,
      amounts: [...amounts].map(([currency, amount]) => ({ currency, amount })),
      oldestDue,
      maxDaysPastDue: oldestDue && oldestDue < today ? daysBetween(oldestDue, today) : 0,
      lastReminderAt: last?.createdAt ?? null,
      lastPaymentDate: lastPayment(idx, party.id)?.date ?? null,
      reason,
    });
  }
  return out.sort((a, b) => b.maxDaysPastDue - a.maxDaysPastDue || (a.oldestDue ?? "9").localeCompare(b.oldestDue ?? "9"));
}

export type ActionKind =
  | "promise_due"
  | "promise_broken"
  | "installment_missed"
  | "installment_due"
  | "overdue"
  | "due_today"
  | "remind_on"
  | "payable_due";

export type DailyAction = {
  kind: ActionKind;
  party: Party;
  amount: Minor;
  currency: CurrencyCode;
  date: ISODate;
  obligationId?: string;
  promiseId?: string;
};

const PRIORITY: ActionKind[] = ["promise_due", "promise_broken", "installment_missed", "installment_due", "overdue", "due_today", "remind_on", "payable_due"];

/** Today's actions, one per party and kind, ordered by fixed rule priority then amount. */
export function dailyActions(idx: LedgerIndex, today: ISODate): DailyAction[] {
  const out: DailyAction[] = [];
  const byKey = new Map<string, DailyAction>();
  const pushOnce = (a: DailyAction) => {
    const key = `${a.kind}:${a.party.id}:${a.currency}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.amount += a.amount;
      return;
    }
    byKey.set(key, a);
    out.push(a);
  };
  for (const party of idx.parties) {
    if (party.archivedAt || party.mergedIntoId) continue;
    const snoozed = !!party.snoozedUntil && party.snoozedUntil >= today;
    for (const pr of idx.promisesByParty.get(party.id) ?? []) {
      const st = promiseState(pr, idx, today);
      const left = pr.amount - st.paid;
      if (st.state === "due_today") pushOnce({ kind: "promise_due", party, amount: left, currency: pr.currency, date: pr.promisedDate, promiseId: pr.id });
      if (st.state === "broken" && daysBetween(pr.promisedDate, today) <= 7)
        pushOnce({ kind: "promise_broken", party, amount: left, currency: pr.currency, date: pr.promisedDate, promiseId: pr.id });
    }
    for (const ob of idx.obByParty.get(party.id) ?? []) {
      if (ob.state !== "posted") continue;
      const f = figuresOf(idx, ob);
      if (f.outstanding <= 0) continue;
      if (ob.direction === "payable") {
        if (ob.dueDate && ob.dueDate <= today) pushOnce({ kind: "payable_due", party, amount: f.outstanding, currency: ob.currency, date: ob.dueDate, obligationId: ob.id });
        continue;
      }
      if (snoozed || ob.disputed) continue;
      const plan = (idx.plansByOb.get(ob.id) ?? []).find((p) => p.state === "active");
      if (plan) {
        for (const it of installmentProgress(plan, f.settled, today)) {
          if (it.state === "missed") pushOnce({ kind: "installment_missed", party, amount: it.remaining, currency: ob.currency, date: it.dueDate, obligationId: ob.id });
          if (it.state === "due") pushOnce({ kind: "installment_due", party, amount: it.remaining, currency: ob.currency, date: it.dueDate, obligationId: ob.id });
        }
        continue;
      }
      if (ob.dueDate && ob.dueDate < today) pushOnce({ kind: "overdue", party, amount: f.outstanding, currency: ob.currency, date: ob.dueDate, obligationId: ob.id });
      else if (ob.dueDate === today) pushOnce({ kind: "due_today", party, amount: f.outstanding, currency: ob.currency, date: today, obligationId: ob.id });
      else if (ob.remindOn && ob.remindOn <= today) pushOnce({ kind: "remind_on", party, amount: f.outstanding, currency: ob.currency, date: ob.remindOn, obligationId: ob.id });
    }
  }
  return out.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || b.amount - a.amount);
}

/** True when `time` ("HH:MM") falls inside quiet hours (which may wrap past midnight). */
export function inQuietHours(time: string, quiet: { start: string; end: string }): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}
