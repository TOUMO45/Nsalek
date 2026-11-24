// Derived financial figures. Every balance shown anywhere (home, people, statements, reports,
// exports, reminders) comes from these functions. Nothing is cached in stored records.
import { addDays, daysBetween } from "./dates.ts";
import { normalizeText, phoneKey } from "./text.ts";
import { parseAmount } from "./money.ts";
import type {
  Adjustment,
  Allocation,
  CurrencyCode,
  Direction,
  ISODate,
  InstallmentPlan,
  LedgerData,
  Minor,
  Obligation,
  Party,
  Payment,
  PromiseToPay,
  ReminderLog,
} from "./types.ts";

export type ObligationFigures = {
  principal: Minor;
  increased: Minor;
  decreased: Minor;
  waived: Minor;
  writtenOff: Minor;
  netted: Minor;
  paid: Minor;
  /** Everything that reduced the amount: decreases, waivers, write-offs, netting, payments. */
  settled: Minor;
  outstanding: Minor;
};

export const activeAllocations = (list: Allocation[] | undefined) => (list ?? []).filter((a) => !a.reversedAt);
export const activeAdjustments = (list: Adjustment[] | undefined) => (list ?? []).filter((a) => !a.reversedAt);

export function obligationFigures(ob: Obligation, allocations: Allocation[] = [], adjustments: Adjustment[] = []): ObligationFigures {
  const f: ObligationFigures = {
    principal: ob.principal,
    increased: 0,
    decreased: 0,
    waived: 0,
    writtenOff: 0,
    netted: 0,
    paid: 0,
    settled: 0,
    outstanding: 0,
  };
  for (const a of activeAdjustments(adjustments)) {
    if (a.obligationId !== ob.id) continue;
    if (a.type === "increase") f.increased += a.amount;
    else if (a.type === "decrease") f.decreased += a.amount;
    else if (a.type === "waiver") f.waived += a.amount;
    else if (a.type === "write_off") f.writtenOff += a.amount;
    else if (a.type === "netting") f.netted += a.amount;
  }
  for (const a of activeAllocations(allocations)) if (a.obligationId === ob.id) f.paid += a.amount;
  f.settled = f.decreased + f.waived + f.writtenOff + f.netted + f.paid;
  f.outstanding = ob.state === "posted" ? f.principal + f.increased - f.settled : 0;
  return f;
}

export type ObligationStatus = "draft" | "voided" | "open" | "partly_paid" | "paid" | "waived" | "closed";

export function obligationStatus(ob: Obligation, f: ObligationFigures): ObligationStatus {
  if (ob.state === "draft") return "draft";
  if (ob.state === "voided") return "voided";
  // "Partly paid" means money (or an explicit offset) came in; a discount or correction alone leaves it open.
  if (f.outstanding > 0) return f.paid + f.netted > 0 ? "partly_paid" : "open";
  const forgiven = f.waived + f.writtenOff;
  if (forgiven > 0) return f.paid + f.netted + f.decreased > 0 ? "closed" : "waived";
  return "paid";
}

export type DueState = "none" | "not_due" | "due_soon" | "due_today" | "overdue";

export function dueState(ob: Obligation, outstanding: Minor, today: ISODate, dueSoonDays = 7): DueState {
  if (outstanding <= 0 || !ob.dueDate) return "none";
  if (ob.dueDate < today) return "overdue";
  if (ob.dueDate === today) return "due_today";
  if (ob.dueDate <= addDays(today, dueSoonDays)) return "due_soon";
  return "not_due";
}

export function daysPastDue(ob: Obligation, today: ISODate): number {
  return ob.dueDate ? Math.max(0, daysBetween(ob.dueDate, today)) : 0;
}

export type PaymentFigures = { allocated: Minor; unallocated: Minor };

export function paymentFigures(p: Payment, allocations: Allocation[] = []): PaymentFigures {
  if (p.state !== "posted") return { allocated: 0, unallocated: 0 };
  const allocated = activeAllocations(allocations)
    .filter((a) => a.paymentId === p.id)
    .reduce((n, a) => n + a.amount, 0);
  return { allocated, unallocated: p.amount - allocated };
}

// ---------------------------------------------------------------- index

export type LedgerIndex = {
  data: LedgerData;
  workspaceId: string;
  parties: Party[];
  party: Map<string, Party>;
  obligation: Map<string, Obligation>;
  payment: Map<string, Payment>;
  allocByOb: Map<string, Allocation[]>;
  allocByPay: Map<string, Allocation[]>;
  adjByOb: Map<string, Adjustment[]>;
  obByParty: Map<string, Obligation[]>;
  payByParty: Map<string, Payment[]>;
  adjByParty: Map<string, Adjustment[]>;
  plansByOb: Map<string, InstallmentPlan[]>;
  promisesByParty: Map<string, PromiseToPay[]>;
  remindersByParty: Map<string, ReminderLog[]>;
  figures: Map<string, ObligationFigures>;
};

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildIndex(data: LedgerData, workspaceId: string): LedgerIndex {
  const inWs = <T extends { workspaceId: string }>(list: T[]) => list.filter((r) => r.workspaceId === workspaceId);
  const idx: LedgerIndex = {
    data,
    workspaceId,
    parties: inWs(data.parties),
    party: new Map(),
    obligation: new Map(),
    payment: new Map(),
    allocByOb: new Map(),
    allocByPay: new Map(),
    adjByOb: new Map(),
    obByParty: new Map(),
    payByParty: new Map(),
    adjByParty: new Map(),
    plansByOb: new Map(),
    promisesByParty: new Map(),
    remindersByParty: new Map(),
    figures: new Map(),
  };
  for (const p of idx.parties) idx.party.set(p.id, p);
  for (const o of inWs(data.obligations)) {
    idx.obligation.set(o.id, o);
    push(idx.obByParty, o.partyId, o);
  }
  for (const p of inWs(data.payments)) {
    idx.payment.set(p.id, p);
    push(idx.payByParty, p.partyId, p);
  }
  for (const a of inWs(data.allocations)) {
    push(idx.allocByOb, a.obligationId, a);
    push(idx.allocByPay, a.paymentId, a);
  }
  for (const a of inWs(data.adjustments)) {
    push(idx.adjByOb, a.obligationId, a);
    push(idx.adjByParty, a.partyId, a);
  }
  for (const p of inWs(data.installmentPlans)) push(idx.plansByOb, p.obligationId, p);
  for (const p of inWs(data.promises)) push(idx.promisesByParty, p.partyId, p);
  for (const r of inWs(data.reminders)) push(idx.remindersByParty, r.partyId, r);
  for (const o of idx.obligation.values())
    idx.figures.set(o.id, obligationFigures(o, idx.allocByOb.get(o.id), idx.adjByOb.get(o.id)));
  return idx;
}

export const figuresOf = (idx: LedgerIndex, ob: Obligation) =>
  idx.figures.get(ob.id) ?? obligationFigures(ob, idx.allocByOb.get(ob.id), idx.adjByOb.get(ob.id));

export const paymentFiguresOf = (idx: LedgerIndex, p: Payment) => paymentFigures(p, idx.allocByPay.get(p.id));

// ---------------------------------------------------------------- balances

export type Balance = {
  receivable: Minor;
  payable: Minor;
  overdueReceivable: Minor;
  overduePayable: Minor;
  /** Received payments not allocated to any debt (explicit advances). */
  advanceReceived: Minor;
  /** Paid-out payments not allocated to any debt. */
  advancePaid: Minor;
  openReceivable: number;
  openPayable: number;
  dueToday: number;
  overdue: number;
};

export const emptyBalance = (): Balance => ({
  receivable: 0,
  payable: 0,
  overdueReceivable: 0,
  overduePayable: 0,
  advanceReceived: 0,
  advancePaid: 0,
  openReceivable: 0,
  openPayable: 0,
  dueToday: 0,
  overdue: 0,
});

export type BalanceByCurrency = Map<CurrencyCode, Balance>;

function addTo(map: BalanceByCurrency, currency: CurrencyCode): Balance {
  let b = map.get(currency);
  if (!b) {
    b = emptyBalance();
    map.set(currency, b);
  }
  return b;
}

export function partyBalance(idx: LedgerIndex, partyId: string, today: ISODate): BalanceByCurrency {
  const map: BalanceByCurrency = new Map();
  for (const ob of idx.obByParty.get(partyId) ?? []) {
    if (ob.state !== "posted") continue;
    const f = figuresOf(idx, ob);
    if (f.outstanding <= 0) continue;
    const b = addTo(map, ob.currency);
    const overdue = !!ob.dueDate && ob.dueDate < today;
    if (ob.direction === "receivable") {
      b.receivable += f.outstanding;
      b.openReceivable++;
      if (overdue) b.overdueReceivable += f.outstanding;
    } else {
      b.payable += f.outstanding;
      b.openPayable++;
      if (overdue) b.overduePayable += f.outstanding;
    }
    if (overdue) b.overdue++;
    if (ob.dueDate === today) b.dueToday++;
  }
  for (const p of idx.payByParty.get(partyId) ?? []) {
    const { unallocated } = paymentFiguresOf(idx, p);
    if (unallocated <= 0) continue;
    const b = addTo(map, p.currency);
    if (p.direction === "receivable") b.advanceReceived += unallocated;
    else b.advancePaid += unallocated;
  }
  return map;
}

export type WorkspaceTotals = Map<CurrencyCode, Balance & { debtors: number; creditors: number }>;

export function workspaceTotals(idx: LedgerIndex, today: ISODate): WorkspaceTotals {
  const totals: WorkspaceTotals = new Map();
  for (const party of idx.parties) {
    for (const [currency, b] of partyBalance(idx, party.id, today)) {
      let t = totals.get(currency);
      if (!t) {
        t = { ...emptyBalance(), debtors: 0, creditors: 0 };
        totals.set(currency, t);
      }
      t.receivable += b.receivable;
      t.payable += b.payable;
      t.overdueReceivable += b.overdueReceivable;
      t.overduePayable += b.overduePayable;
      t.advanceReceived += b.advanceReceived;
      t.advancePaid += b.advancePaid;
      t.openReceivable += b.openReceivable;
      t.openPayable += b.openPayable;
      t.dueToday += b.dueToday;
      t.overdue += b.overdue;
      if (b.receivable > 0) t.debtors++;
      if (b.payable > 0) t.creditors++;
    }
  }
  return totals;
}

/** Optional per-party net in one currency. Display only, never a stored settlement. */
export function netPosition(b: Balance): Minor {
  return b.receivable - b.payable;
}

// ---------------------------------------------------------------- allocation planning

export type AllocationLine = { obligationId: string; amount: Minor };

export function allocationOrder(a: Obligation, b: Obligation): number {
  return (
    (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date) ||
    a.date.localeCompare(b.date) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Oldest-due-first plan. Returns the unallocated remainder instead of making any debt negative. */
export function planAllocation(
  open: { obligation: Obligation; outstanding: Minor }[],
  amount: Minor,
): { lines: AllocationLine[]; unallocated: Minor } {
  let rest = amount;
  const lines: AllocationLine[] = [];
  for (const { obligation, outstanding } of [...open].sort((x, y) => allocationOrder(x.obligation, y.obligation))) {
    if (rest <= 0) break;
    const part = Math.min(rest, outstanding);
    if (part > 0) {
      lines.push({ obligationId: obligation.id, amount: part });
      rest -= part;
    }
  }
  return { lines, unallocated: rest };
}

export function openObligations(idx: LedgerIndex, partyId: string, direction: Direction, currency: CurrencyCode) {
  return (idx.obByParty.get(partyId) ?? [])
    .filter((o) => o.state === "posted" && o.direction === direction && o.currency === currency)
    .map((obligation) => ({ obligation, outstanding: figuresOf(idx, obligation).outstanding }))
    .filter((x) => x.outstanding > 0);
}

// ---------------------------------------------------------------- effects, timeline, statements

export type Effect = {
  key: string;
  date: ISODate;
  at: string;
  direction: Direction;
  currency: CurrencyCode;
  /** Signed change of the outstanding amount in this direction. */
  delta: Minor;
  kind: "obligation" | "increase" | "decrease" | "waiver" | "write_off" | "netting" | "payment" | "advance_applied";
  sourceId: string;
  obligationId?: string;
  paymentId?: string;
};

/** Effects of active records on a party's outstanding amounts. Summing all effects equals outstanding. */
export function partyEffects(idx: LedgerIndex, partyId: string): Effect[] {
  const out: Effect[] = [];
  const obs = (idx.obByParty.get(partyId) ?? []).filter((o) => o.state === "posted");
  for (const ob of obs) {
    out.push({
      key: "o:" + ob.id,
      date: ob.date,
      at: ob.createdAt,
      direction: ob.direction,
      currency: ob.currency,
      delta: ob.principal,
      kind: "obligation",
      sourceId: ob.id,
      obligationId: ob.id,
    });
    for (const adj of activeAdjustments(idx.adjByOb.get(ob.id))) {
      out.push({
        key: "a:" + adj.id,
        date: adj.date,
        at: adj.createdAt,
        direction: ob.direction,
        currency: ob.currency,
        delta: adj.type === "increase" ? adj.amount : -adj.amount,
        kind: adj.type,
        sourceId: adj.id,
        obligationId: ob.id,
      });
    }
  }
  const obById = new Map(obs.map((o) => [o.id, o]));
  for (const p of idx.payByParty.get(partyId) ?? []) {
    if (p.state !== "posted") continue;
    // Allocations recorded with the payment form the "payment" entry; an advance applied later (even the
    // same day) is its own entry at the time it was applied, so running balances stay in order.
    const groups = new Map<string, { date: ISODate; at: string; initial: boolean; amount: Minor }>();
    for (const a of activeAllocations(idx.allocByPay.get(p.id))) {
      if (!obById.has(a.obligationId)) continue;
      const initial = a.createdAt <= p.createdAt;
      const k = initial ? `${a.date}` : `${a.date}:${a.createdAt}`;
      const g = groups.get(k) ?? { date: a.date, at: initial ? (a.date === p.date ? p.createdAt : a.date + "T23:59:59Z") : a.createdAt, initial, amount: 0 };
      g.amount += a.amount;
      groups.set(k, g);
    }
    for (const [k, g] of groups) {
      out.push({
        key: `p:${p.id}:${k}`,
        date: g.date,
        at: g.at,
        direction: p.direction,
        currency: p.currency,
        delta: -g.amount,
        kind: g.initial && g.date === p.date ? "payment" : "advance_applied",
        sourceId: p.id,
        paymentId: p.id,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

export type StatementRow = Effect & { balance: Minor };
export type StatementSection = {
  direction: Direction;
  opening: Minor;
  rows: StatementRow[];
  increases: Minor;
  decreases: Minor;
  closing: Minor;
};
export type Statement = {
  partyId: string;
  currency: CurrencyCode;
  from: ISODate;
  to: ISODate;
  sections: StatementSection[];
  advances: { received: Minor; paid: Minor };
};

export function buildStatement(idx: LedgerIndex, partyId: string, currency: CurrencyCode, from: ISODate, to: ISODate): Statement {
  const effects = partyEffects(idx, partyId).filter((e) => e.currency === currency && e.date <= to);
  const sections: StatementSection[] = [];
  for (const direction of ["receivable", "payable"] as Direction[]) {
    const list = effects.filter((e) => e.direction === direction);
    if (!list.length) continue;
    const opening = list.filter((e) => e.date < from).reduce((n, e) => n + e.delta, 0);
    let balance = opening;
    const rows: StatementRow[] = [];
    let increases = 0;
    let decreases = 0;
    for (const e of list.filter((e) => e.date >= from)) {
      balance += e.delta;
      if (e.delta >= 0) increases += e.delta;
      else decreases -= e.delta;
      rows.push({ ...e, balance });
    }
    sections.push({ direction, opening, rows, increases, decreases, closing: balance });
  }
  let received = 0;
  let paid = 0;
  for (const p of idx.payByParty.get(partyId) ?? []) {
    if (p.currency !== currency || p.date > to) continue;
    const allocatedByTo = activeAllocations(idx.allocByPay.get(p.id))
      .filter((a) => a.date <= to)
      .reduce((n, a) => n + a.amount, 0);
    const unallocated = p.state === "posted" ? p.amount - allocatedByTo : 0;
    if (p.direction === "receivable") received += unallocated;
    else paid += unallocated;
  }
  return { partyId, currency, from, to, sections, advances: { received, paid } };
}

// ---------------------------------------------------------------- search

export type PartyFilters = {
  direction?: "receivable" | "payable" | "both" | "settled";
  due?: "overdue" | "due_today" | "due_soon" | "no_due";
  currency?: CurrencyCode;
  tag?: string;
  archived?: boolean;
  from?: ISODate;
  to?: ISODate;
};

export type PartyMatch = { party: Party; reason: "name" | "phone" | "amount" | "text" | "all" };

type SearchEntry = { name: string; phones: string; text: string };
const searchCache = new WeakMap<LedgerIndex, Map<string, SearchEntry>>();

/** Normalized search text per party, built once per ledger snapshot (not per keystroke). */
function searchEntries(idx: LedgerIndex): Map<string, SearchEntry> {
  let cache = searchCache.get(idx);
  if (cache) return cache;
  cache = new Map();
  for (const party of idx.parties) {
    // Each phone is searchable as E.164 digits and as the national form (0 + last 9 digits).
    const phones = [...party.phones, ...party.representatives.map((r) => r.phone)]
      .filter(Boolean)
      .flatMap((ph) => [ph.replace(/\D/g, ""), "0" + phoneKey(ph)])
      .join(" ");
    const obs = (idx.obByParty.get(party.id) ?? []).filter((o) => o.state === "posted");
    const text = normalizeText([party.notes, party.tags.join(" "), ...obs.map((o) => o.description + " " + o.reference)].join(" "));
    cache.set(party.id, { name: normalizeText(party.displayName), phones, text });
  }
  searchCache.set(idx, cache);
  return cache;
}

export function searchParties(idx: LedgerIndex, query: string, filters: PartyFilters, today: ISODate, dueSoonDays = 7): PartyMatch[] {
  const q = normalizeText(query);
  const digits = q.replace(/\D/g, "");
  const entries = searchEntries(idx);
  const currencies = new Set(idx.parties.length ? [...idx.obligation.values()].map((o) => o.currency) : []);
  const amounts = new Set<number>();
  if (q && /\d/.test(q)) {
    for (const c of currencies.size ? currencies : new Set(["DZD"])) {
      const r = parseAmount(query, c);
      if (r.ok) amounts.add(r.minor);
    }
  }
  const results: PartyMatch[] = [];
  for (const party of idx.parties) {
    if (party.mergedIntoId) continue;
    if (!!party.archivedAt !== !!filters.archived) continue;
    if (filters.tag && !party.tags.includes(filters.tag)) continue;
    const obs = (idx.obByParty.get(party.id) ?? []).filter((o) => o.state === "posted");
    const inRange = (o: Obligation) => (!filters.from || o.date >= filters.from) && (!filters.to || o.date <= filters.to);
    if ((filters.from || filters.to) && !obs.some(inRange)) continue;
    const open = obs
      .map((o) => ({ o, f: figuresOf(idx, o) }))
      .filter((x) => x.f.outstanding > 0 && (!filters.currency || x.o.currency === filters.currency));
    if (filters.currency && !obs.some((o) => o.currency === filters.currency)) continue;
    if (filters.direction === "receivable" && !open.some((x) => x.o.direction === "receivable")) continue;
    if (filters.direction === "payable" && !open.some((x) => x.o.direction === "payable")) continue;
    if (filters.direction === "both" && !(open.some((x) => x.o.direction === "receivable") && open.some((x) => x.o.direction === "payable"))) continue;
    if (filters.direction === "settled" && open.length) continue;
    if (filters.due) {
      const states = open.map((x) => dueState(x.o, x.f.outstanding, today, dueSoonDays));
      if (filters.due === "no_due" ? !open.some((x) => !x.o.dueDate) : !states.includes(filters.due)) continue;
    }
    if (!q) {
      results.push({ party, reason: "all" });
      continue;
    }
    const entry = entries.get(party.id)!;
    const name = entry.name;
    if (name.includes(q) || q.split(" ").every((w) => name.includes(w))) {
      results.push({ party, reason: "name" });
      continue;
    }
    if (digits.length >= 3 && entry.phones.includes(digits)) {
      results.push({ party, reason: "phone" });
      continue;
    }
    if (amounts.size && obs.some((o) => amounts.has(o.principal) || amounts.has(figuresOf(idx, o).outstanding))) {
      results.push({ party, reason: "amount" });
      continue;
    }
    if (entry.text.includes(q)) {
      results.push({ party, reason: "text" });
    }
  }
  return results;
}

/** Possible duplicates: same normalized name, or a shared phone. */
export function findDuplicates(parties: Party[], candidate: { displayName: string; phones: string[] }, excludeId?: string): Party[] {
  const name = normalizeText(candidate.displayName);
  const keys = new Set(candidate.phones.map(phoneKey).filter((k) => k.length >= 8));
  return parties.filter(
    (p) =>
      p.id !== excludeId &&
      !p.mergedIntoId &&
      ((name && normalizeText(p.displayName) === name) || p.phones.some((ph) => keys.has(phoneKey(ph)))),
  );
}

/** Posted payments of a person that still carry an unused advance, oldest first. */
export function advancePayments(idx: LedgerIndex, partyId: string, direction: Direction, currency: CurrencyCode): { payment: Payment; unallocated: Minor }[] {
  return (idx.payByParty.get(partyId) ?? [])
    .filter((p) => p.state === "posted" && p.direction === direction && p.currency === currency)
    .map((payment) => ({ payment, unallocated: paymentFiguresOf(idx, payment).unallocated }))
    .filter((x) => x.unallocated > 0)
    .sort((a, b) => a.payment.date.localeCompare(b.payment.date) || a.payment.createdAt.localeCompare(b.payment.createdAt));
}

export type ReceiptFigures ={ lines: { obligationId: string; amount: Minor; remainingAfter: Minor }[]; advance: Minor; remainingAfter: Minor };

/**
 * What a receipt shows: the payment's own allocations and the balances as they stood right after it
 * was recorded. Later payments, reversals, corrections, advance applications and new debts never
 * change a receipt. Drafts carry no posting time, so a draft posted later counts from its creation.
 */
export function receiptFigures(idx: LedgerIndex, p: Payment): ReceiptFigures {
  const at = p.createdAt;
  const asOf = <T extends { createdAt: string; reversedAt?: string | null }>(list: T[] | undefined): T[] =>
    (list ?? []).filter((x) => x.createdAt <= at).map((x) => (x.reversedAt && x.reversedAt > at ? { ...x, reversedAt: null } : x));
  const outstandingAt = (ob: Obligation | undefined): Minor => {
    if (!ob || ob.createdAt > at || ob.state === "draft") return 0;
    const voided = ob.state === "voided" && (!ob.voidedAt || ob.voidedAt <= at);
    return obligationFigures({ ...ob, state: voided ? "voided" : "posted" }, asOf(idx.allocByOb.get(ob.id)), asOf(idx.adjByOb.get(ob.id))).outstanding;
  };
  const lines = activeAllocations(asOf(idx.allocByPay.get(p.id))).map((a) => ({ obligationId: a.obligationId, amount: a.amount, remainingAfter: outstandingAt(idx.obligation.get(a.obligationId)) }));
  const remainingAfter = (idx.obByParty.get(p.partyId) ?? []).filter((o) => o.direction === p.direction && o.currency === p.currency).reduce((n, o) => n + outstandingAt(o), 0);
  return { lines, advance: p.amount - lines.reduce((n, l) => n + l.amount, 0), remainingAfter };
}
