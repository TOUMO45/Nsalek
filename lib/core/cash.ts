// Cash book: the money that goes through the drawer. Its own entries (sales, expenses...) and,
// without typing them twice, the repayments of debts received or paid in cash. Integer minor units
// only; a cancelled entry stays visible and counts for nothing.
import { textCell, numberCell, toCsv, type CsvCell, type CsvOptions } from "./csv.ts";
import type { Lang } from "./money.ts";
import type { CashEntry, CashKind, CurrencyCode, ISODate, LedgerData, Minor, Payment } from "./types.ts";

export type CashLine = {
  id: string;
  date: ISODate;
  direction: "in" | "out";
  amount: Minor;
  currency: CurrencyCode;
  kind: CashKind | "repayment";
  /** The entry's category, or the person's name for a repayment. */
  label: string;
  note: string;
  partyId?: string;
  entry?: CashEntry;
  payment?: Payment;
  voided: boolean;
  createdAt: string;
};

/** Lines of one notebook between two dates (inclusive), oldest first. */
export function cashLines(data: LedgerData, workspaceId: string, from: ISODate, to: ISODate): CashLine[] {
  const out: CashLine[] = [];
  for (const e of data.cashEntries) {
    if (e.workspaceId !== workspaceId || e.date < from || e.date > to) continue;
    out.push({ id: e.id, date: e.date, direction: e.direction, amount: e.amount, currency: e.currency, kind: e.kind, label: e.category, note: e.note, entry: e, voided: !!e.voidedAt, createdAt: e.createdAt });
  }
  const names = new Map(data.parties.filter((p) => p.workspaceId === workspaceId).map((p) => [p.id, p.displayName]));
  for (const p of data.payments) {
    if (p.workspaceId !== workspaceId || p.method !== "cash" || p.date < from || p.date > to) continue;
    out.push({
      id: p.id,
      date: p.date,
      direction: p.direction === "receivable" ? "in" : "out",
      amount: p.amount,
      currency: p.currency,
      kind: "repayment",
      label: names.get(p.partyId) ?? "",
      note: p.note,
      partyId: p.partyId,
      payment: p,
      voided: p.state !== "posted",
      createdAt: p.createdAt,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export type CashTotals = { in: Minor; out: Minor; net: Minor };

export function cashTotals(lines: CashLine[], currency: CurrencyCode): CashTotals {
  let i = 0;
  let o = 0;
  for (const l of lines) {
    if (l.voided || l.currency !== currency) continue;
    if (l.direction === "in") i += l.amount;
    else o += l.amount;
  }
  return { in: i, out: o, net: i - o };
}

/**
 * Cash at hand at the end of `upTo`. It starts from the latest "opening" (the drawer counted),
 * or else from the first entry of the cash book itself: repayments from before the cash book was
 * used are not in today's drawer. null when the cash book has no entry of its own yet.
 */
export function cashAtHand(data: LedgerData, workspaceId: string, upTo: ISODate, currency: CurrencyCode): Minor | null {
  const lines = cashLines(data, workspaceId, "0000-01-01", upTo).filter((l) => !l.voided && l.currency === currency);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].kind === "opening") {
      start = i;
      break;
    }
  if (start < 0) start = lines.findIndex((l) => l.kind !== "repayment");
  return start < 0 ? null : cashTotals(lines.slice(start), currency).net;
}

/** Currencies that appear in the cash book, the notebook's own first. */
export function cashCurrencies(data: LedgerData, workspaceId: string, first: CurrencyCode): CurrencyCode[] {
  const set = new Set<CurrencyCode>([first]);
  for (const l of cashLines(data, workspaceId, "0000-01-01", "9999-12-31")) set.add(l.currency);
  return [...set];
}

export type CashSummary = { totals: CashTotals; byKind: [CashLine["kind"], Minor][]; byCategory: { direction: "in" | "out"; category: string; amount: Minor }[] };

/** A month ("2026-11") or any range: totals by kind and by category, largest first. */
export function cashSummary(data: LedgerData, workspaceId: string, from: ISODate, to: ISODate, currency: CurrencyCode): CashSummary {
  const lines = cashLines(data, workspaceId, from, to).filter((l) => !l.voided && l.currency === currency);
  const kinds = new Map<CashLine["kind"], Minor>();
  const cats = new Map<string, { direction: "in" | "out"; category: string; amount: Minor }>();
  for (const l of lines) {
    kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + (l.direction === "in" ? l.amount : -l.amount));
    if (l.kind === "repayment") continue;
    const key = `${l.direction}|${l.label.trim().toLowerCase()}`;
    const c = cats.get(key) ?? { direction: l.direction, category: l.label.trim(), amount: 0 };
    c.amount += l.amount;
    cats.set(key, c);
  }
  return {
    totals: cashTotals(lines, currency),
    byKind: [...kinds].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
    byCategory: [...cats.values()].sort((a, b) => b.amount - a.amount),
  };
}

const COLS: Record<string, [string, string, string]> = {
  date: ["date", "Date", "التاريخ"],
  kind: ["kind", "Nature", "النوع"],
  label: ["label", "Libellé", "البيان"],
  note: ["note", "Note", "ملاحظة"],
  in: ["in", "Entrée", "دخل"],
  out: ["out", "Sortie", "خرج"],
  currency: ["currency", "Devise", "العملة"],
  state: ["state", "État", "الوضع"],
  id: ["id", "ID", "المعرف"],
};

/** The lines as a spreadsheet; cancelled lines are kept and marked. */
export function exportCash(data: LedgerData, workspaceId: string, from: ISODate, to: ISODate, opts: CsvOptions & { lang?: Lang } = {}): string {
  const col = (k: string) => COLS[k][opts.lang === "fr" ? 1 : opts.lang === "ar" ? 2 : 0];
  const rows: CsvCell[][] = [["date", "kind", "label", "note", "in", "out", "currency", "state", "id"].map(col)];
  for (const l of cashLines(data, workspaceId, from, to))
    rows.push([
      l.date,
      l.kind,
      textCell(l.label),
      textCell(l.note),
      l.direction === "in" ? numberCell(l.amount, l.currency) : "",
      l.direction === "out" ? numberCell(l.amount, l.currency) : "",
      l.currency,
      l.voided ? "voided" : "posted",
      l.id,
    ]);
  return toCsv(rows, opts);
}
