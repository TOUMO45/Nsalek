// Reports. Cash collected or paid is not accounting profit; waived amounts are separate from
// cash; receivables and payables are never netted across parties.
import { addDays } from "./dates.ts";
import { installmentProgress } from "./installments.ts";
import { activeAdjustments, figuresOf, partyBalance, paymentFiguresOf, type Balance, type LedgerIndex } from "./ledger.ts";
import type { CurrencyCode, ISODate, Minor, Party, PaymentMethod } from "./types.ts";

export type PeriodReport = {
  currency: CurrencyCode;
  newReceivables: Minor;
  newPayables: Minor;
  cashReceived: Minor;
  cashPaid: Minor;
  receivedByMethod: Partial<Record<PaymentMethod, Minor>>;
  paidByMethod: Partial<Record<PaymentMethod, Minor>>;
  waivedReceivable: Minor;
  waivedPayable: Minor;
  netted: Minor;
  increases: Minor;
  decreases: Minor;
  advancesReceived: Minor;
  counts: { obligations: number; payments: number };
};

export function periodReport(idx: LedgerIndex, from: ISODate, to: ISODate): Map<CurrencyCode, PeriodReport> {
  const map = new Map<CurrencyCode, PeriodReport>();
  const get = (c: CurrencyCode) => {
    let r = map.get(c);
    if (!r) {
      r = {
        currency: c,
        newReceivables: 0,
        newPayables: 0,
        cashReceived: 0,
        cashPaid: 0,
        receivedByMethod: {},
        paidByMethod: {},
        waivedReceivable: 0,
        waivedPayable: 0,
        netted: 0,
        increases: 0,
        decreases: 0,
        advancesReceived: 0,
        counts: { obligations: 0, payments: 0 },
      };
      map.set(c, r);
    }
    return r;
  };
  const inRange = (d: ISODate) => d >= from && d <= to;
  for (const ob of idx.obligation.values()) {
    if (ob.state !== "posted") continue;
    if (inRange(ob.date)) {
      const r = get(ob.currency);
      if (ob.direction === "receivable") r.newReceivables += ob.principal;
      else r.newPayables += ob.principal;
      r.counts.obligations++;
    }
    for (const adj of activeAdjustments(idx.adjByOb.get(ob.id))) {
      if (!inRange(adj.date)) continue;
      const r = get(ob.currency);
      if (adj.type === "waiver" || adj.type === "write_off") {
        if (ob.direction === "receivable") r.waivedReceivable += adj.amount;
        else r.waivedPayable += adj.amount;
      } else if (adj.type === "netting") {
        // One offset reduces both sides by the same amount; count it once (the receivable side).
        if (ob.direction === "receivable") r.netted += adj.amount;
      }
      else if (adj.type === "increase") r.increases += adj.amount;
      else r.decreases += adj.amount;
    }
  }
  for (const p of idx.payment.values()) {
    if (p.state !== "posted" || !inRange(p.date)) continue;
    const r = get(p.currency);
    r.counts.payments++;
    if (p.direction === "receivable") {
      r.cashReceived += p.amount;
      r.receivedByMethod[p.method] = (r.receivedByMethod[p.method] ?? 0) + p.amount;
      r.advancesReceived += paymentFiguresOf(idx, p).unallocated;
    } else {
      r.cashPaid += p.amount;
      r.paidByMethod[p.method] = (r.paidByMethod[p.method] ?? 0) + p.amount;
    }
  }
  return map;
}

export type PartyRow = { party: Party; currency: CurrencyCode; balance: Balance };

export function perPartyBalances(idx: LedgerIndex, today: ISODate): PartyRow[] {
  const rows: PartyRow[] = [];
  for (const party of idx.parties) {
    if (party.mergedIntoId) continue;
    for (const [currency, balance] of partyBalance(idx, party.id, today)) {
      if (balance.receivable || balance.payable || balance.advanceReceived || balance.advancePaid) rows.push({ party, currency, balance });
    }
  }
  return rows.sort((a, b) => b.balance.receivable + b.balance.payable - (a.balance.receivable + a.balance.payable));
}

export type UpcomingInstallment = { party: Party; obligationId: string; currency: CurrencyCode; dueDate: ISODate; remaining: Minor; state: string };

export function upcomingInstallments(idx: LedgerIndex, today: ISODate, days = 30): UpcomingInstallment[] {
  const until = addDays(today, days);
  const out: UpcomingInstallment[] = [];
  for (const ob of idx.obligation.values()) {
    if (ob.state !== "posted") continue;
    const plan = (idx.plansByOb.get(ob.id) ?? []).find((p) => p.state === "active");
    if (!plan) continue;
    const party = idx.party.get(ob.partyId);
    if (!party) continue;
    for (const it of installmentProgress(plan, figuresOf(idx, ob).settled, today)) {
      if (it.remaining > 0 && it.dueDate <= until)
        out.push({ party, obligationId: ob.id, currency: ob.currency, dueDate: it.dueDate, remaining: it.remaining, state: it.state });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
