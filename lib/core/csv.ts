// CSV primitives and ledger exports. Real CSV only (RFC 4180, CRLF, optional UTF-8 BOM); no XLSX.
// Text cells pass through a formula-injection guard; amounts generated here are numeric cells
// (CsvNumber) that are never altered, so "-1500.50" stays a number in every spreadsheet.
import { buildIndex, emptyBalance, figuresOf, obligationStatus, partyBalance, paymentFiguresOf } from "./ledger.ts";
import { exponentOf, type Lang } from "./money.ts";
import { displayPhone } from "./text.ts";
import { DomainError, type CurrencyCode, type ISODate, type LedgerData, type Minor } from "./types.ts";

export type Delimiter = "," | ";" | "\t";
export const DELIMITERS: readonly Delimiter[] = [",", ";", "\t"];

// ---------------------------------------------------------------- cells

/** A cell holding a number we generated (amount, count). Bypasses the formula guard. */
export class CsvNumber {
  readonly text: string;
  constructor(text: string) {
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new DomainError("invalid_number_cell", { text });
    this.text = text;
  }
}

/** string = user-controlled text (guarded); number/CsvNumber = generated numeric value; null = empty. */
export type CsvCell = string | number | null | undefined | CsvNumber;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Prefixes "'" to text that a spreadsheet could evaluate as a formula (=, +, -, @, tab, CR). */
export function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? "'" + text : text;
}

/** Exact inverse of guardFormula, used when re-reading our own exports. */
export function unguardFormula(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

/** User-controlled text cell, formula-guarded. */
export function textCell(value: string | null | undefined): string {
  return guardFormula(value ?? "");
}

/** Minor units → plain decimal with a dot and no grouping: 150050 DZD → "1500.50", -5 → "-0.05". */
export function amountDecimal(minor: Minor, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(minor)) throw new DomainError("invalid_amount", { minor });
  const exp = exponentOf(currency);
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(exp);
  const int = (abs / base).toString();
  const frac = exp ? "." + (abs % base).toString().padStart(exp, "0") : "";
  return (minor < 0 ? "-" : "") + int + frac;
}

/** Amount cell in the currency's decimals. Never formula-guarded. */
export function numberCell(minor: Minor, currency: CurrencyCode): CsvNumber {
  return new CsvNumber(amountDecimal(minor, currency));
}

/** Integer cell (counts, line numbers). Never formula-guarded. */
export function integerCell(n: number): CsvNumber {
  if (!Number.isSafeInteger(n)) throw new DomainError("invalid_number_cell", { n });
  return new CsvNumber(String(n));
}

function cellText(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof CsvNumber) return cell.text;
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return guardFormula(String(cell));
}

function quoteField(text: string, delimiter: Delimiter): string {
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvOptions = { delimiter?: Delimiter; bom?: boolean };

/**
 * RFC 4180 writer: fields with the delimiter, quotes or line breaks are quoted, quotes doubled,
 * CRLF between records (and after the last). Strings are always formula-guarded (safe by
 * default); use numberCell/integerCell for generated numbers. UTF-8 BOM by default for Excel.
 */
export function toCsv(rows: readonly (readonly CsvCell[])[], opts: CsvOptions = {}): string {
  const d = opts.delimiter ?? ",";
  if (!DELIMITERS.includes(d)) throw new DomainError("invalid_delimiter");
  let out = opts.bom === false ? "" : "﻿";
  for (const row of rows) out += row.map((c) => quoteField(cellText(c), d)).join(d) + "\r\n";
  return out;
}

// ---------------------------------------------------------------- reading

export type DecodedCsv = { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252"; bom: boolean };

/** BOM detection (UTF-8, UTF-16LE/BE); otherwise strict UTF-8, falling back to windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(b.subarray(3)), encoding: "utf-8", bom: true };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)
    return { text: new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b.subarray(2)), encoding: "utf-16le", bom: true };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff)
    return { text: new TextDecoder("utf-16be", { ignoreBOM: true }).decode(b.subarray(2)), encoding: "utf-16be", bom: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b), encoding: "utf-8", bom: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(b), encoding: "windows-1252", bom: false };
  }
}

export type ParsedCsv = {
  delimiter: Delimiter;
  rows: string[][];
  /** 1-based physical line where each row starts (rows may span lines inside quotes). */
  lines: number[];
};

function readRecords(src: string, d: Delimiter, limit: number, strict: boolean): { rows: string[][]; lines: number[] } {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "" && !quoted)) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
    field = "";
    quoted = false;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
        continue;
      }
      if (c === "\r" || c === "\n") line++;
      if (c === "\r" && src[i + 1] === "\n") {
        field += "\r\n";
        i += 2;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "" && !quoted) {
      inQuotes = true;
      quoted = true;
      i++;
      continue;
    }
    if (c === d) {
      row.push(field);
      field = "";
      quoted = false;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      line++;
      rowLine = line;
      if (rows.length >= limit) return { rows, lines };
      continue;
    }
    // A quote inside an unquoted field, or text after a closing quote, is kept literally.
    field += c;
    i++;
  }
  if (inQuotes && strict) throw new DomainError("csv_unterminated_quote", { line: rowLine });
  if (field !== "" || row.length > 0 || quoted) endRow();
  return { rows, lines };
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Picks the delimiter giving the most consistent column count (> 1) over the first records,
 * ignoring delimiters inside quotes. Ties prefer more columns, then , ; tab. Defaults to ",".
 */
export function detectDelimiter(text: string, sample = 30): Delimiter {
  const src = stripBom(text);
  let best: { d: Delimiter; consistency: number; columns: number } | null = null;
  for (const d of DELIMITERS) {
    const { rows } = readRecords(src, d, sample, false);
    if (!rows.length) continue;
    const freq = new Map<number, number>();
    for (const r of rows) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
    let columns = 0;
    let hits = 0;
    for (const [n, f] of freq) if (f > hits || (f === hits && n > columns)) [columns, hits] = [n, f];
    if (columns <= 1) continue;
    const consistency = hits / rows.length;
    if (!best || consistency > best.consistency || (consistency === best.consistency && columns > best.columns))
      best = { d, consistency, columns };
  }
  return best?.d ?? ",";
}

/** Tolerant RFC 4180 reader: quoted fields, doubled quotes, embedded CR/LF, CRLF/LF/CR records. Blank lines are skipped. */
export function parseCsv(text: string, delimiter?: Delimiter): ParsedCsv {
  const src = stripBom(text);
  const d = delimiter ?? detectDelimiter(src);
  if (!DELIMITERS.includes(d)) throw new DomainError("invalid_delimiter");
  const { rows, lines } = readRecords(src, d, Infinity, true);
  return { delimiter: d, rows, lines };
}

// ---------------------------------------------------------------- exports

export type ExportOptions = CsvOptions & {
  /** Workspace-local date, used for overdue figures. */
  today: ISODate;
  /** Header language. Values (direction, status, method) stay machine-readable. */
  lang?: Lang;
};

export type ExportKind = "parties" | "obligations" | "payments" | "import_errors";

/** "nsalek-parties-2026-11-22.csv". */
export function exportFileName(kind: ExportKind, today: ISODate): string {
  return `nsalek-${kind}-${today}.csv`;
}

// en, fr, ar
const LABELS: Record<string, [string, string, string]> = {
  party_id: ["party_id", "ID personne", "معرف الشخص"],
  name: ["name", "Nom", "الاسم"],
  phones: ["phones", "Téléphones", "الهواتف"],
  currency: ["currency", "Devise", "العملة"],
  receivable: ["receivable", "À recevoir", "ليك"],
  payable: ["payable", "À payer", "عليك"],
  advance_received: ["advance_received", "Avance reçue", "تسبيق مستلم"],
  advance_paid: ["advance_paid", "Avance versée", "تسبيق مدفوع"],
  overdue_receivable: ["overdue_receivable", "En retard à recevoir", "متأخر ليك"],
  overdue_payable: ["overdue_payable", "En retard à payer", "متأخر عليك"],
  archived: ["archived", "Archivé", "مؤرشف"],
  obligation_id: ["obligation_id", "ID dette", "معرف الدين"],
  party_name: ["party_name", "Personne", "الشخص"],
  direction: ["direction", "Sens", "الاتجاه"],
  kind: ["kind", "Nature", "النوع"],
  principal: ["principal", "Montant initial", "المبلغ الأصلي"],
  increased: ["increased", "Augmentations", "الزيادات"],
  decreased: ["decreased", "Réductions", "التخفيضات"],
  waived: ["waived", "Remises", "الإعفاءات"],
  written_off: ["written_off", "Pertes", "الشطب"],
  netted: ["netted", "Compensé", "المقاصة"],
  paid: ["paid", "Payé", "المدفوع"],
  outstanding: ["outstanding", "Reste dû", "المتبقي"],
  status: ["status", "Statut", "الحالة"],
  date: ["date", "Date", "التاريخ"],
  due_date: ["due_date", "Échéance", "تاريخ الاستحقاق"],
  description: ["description", "Description", "الوصف"],
  reference: ["reference", "Référence", "المرجع"],
  payment_id: ["payment_id", "ID paiement", "معرف الدفعة"],
  amount: ["amount", "Montant", "المبلغ"],
  allocated: ["allocated", "Affecté", "المخصص"],
  unallocated: ["unallocated", "Non affecté", "غير المخصص"],
  method: ["method", "Moyen", "الطريقة"],
  method_label: ["method_label", "Précision moyen", "تفاصيل الطريقة"],
  note: ["note", "Note", "ملاحظة"],
  state: ["state", "État", "الوضع"],
  receipt_number: ["receipt_number", "N° reçu", "رقم الوصل"],
};

const header = (keys: string[], lang: Lang = "en") => keys.map((k) => LABELS[k][lang === "en" ? 0 : lang === "fr" ? 1 : 2]);

function indexFor(data: LedgerData, workspaceId: string) {
  const ws = data.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new DomainError("workspace_not_found");
  return { ws, idx: buildIndex(data, workspaceId) };
}

const PARTY_COLS = ["party_id", "name", "phones", "currency", "receivable", "payable", "advance_received", "advance_paid", "overdue_receivable", "overdue_payable", "archived"];

/** One row per party per currency (currencies with posted records or a balance; else the workspace currency). */
export function exportParties(data: LedgerData, workspaceId: string, opts: ExportOptions): string {
  const { ws, idx } = indexFor(data, workspaceId);
  const rows: CsvCell[][] = [header(PARTY_COLS, opts.lang)];
  const parties = idx.parties.filter((p) => !p.mergedIntoId).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  for (const p of parties) {
    const balances = partyBalance(idx, p.id, opts.today);
    const currencies = new Set<CurrencyCode>(balances.keys());
    for (const o of idx.obByParty.get(p.id) ?? []) if (o.state === "posted") currencies.add(o.currency);
    for (const x of idx.payByParty.get(p.id) ?? []) if (x.state === "posted") currencies.add(x.currency);
    if (!currencies.size) currencies.add(ws.defaultCurrency);
    for (const c of [...currencies].sort()) {
      const b = balances.get(c) ?? emptyBalance();
      rows.push([
        textCell(p.id),
        textCell(p.displayName),
        textCell(p.phones.map(displayPhone).join(" / ")),
        textCell(c),
        numberCell(b.receivable, c),
        numberCell(b.payable, c),
        numberCell(b.advanceReceived, c),
        numberCell(b.advancePaid, c),
        numberCell(b.overdueReceivable, c),
        numberCell(b.overduePayable, c),
        p.archivedAt ? "true" : "false",
      ]);
    }
  }
  return toCsv(rows, opts);
}

const OBLIGATION_COLS = [
  "obligation_id", "party_id", "party_name", "direction", "kind", "currency", "principal", "increased", "decreased",
  "waived", "written_off", "netted", "paid", "outstanding", "status", "date", "due_date", "description", "reference",
];

/** Every obligation of the workspace with its derived figures (outstanding = principal + increased − settled). */
export function exportObligations(data: LedgerData, workspaceId: string, opts: ExportOptions): string {
  const { idx } = indexFor(data, workspaceId);
  const rows: CsvCell[][] = [header(OBLIGATION_COLS, opts.lang)];
  const list = [...idx.obligation.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const o of list) {
    const f = figuresOf(idx, o);
    const c = o.currency;
    rows.push([
      textCell(o.id),
      textCell(o.partyId),
      textCell(idx.party.get(o.partyId)?.displayName ?? ""),
      o.direction,
      o.kind,
      textCell(c),
      numberCell(f.principal, c),
      numberCell(f.increased, c),
      numberCell(f.decreased, c),
      numberCell(f.waived, c),
      numberCell(f.writtenOff, c),
      numberCell(f.netted, c),
      numberCell(f.paid, c),
      numberCell(f.outstanding, c),
      obligationStatus(o, f),
      o.date,
      o.dueDate ?? "",
      textCell(o.description),
      textCell(o.reference),
    ]);
  }
  return toCsv(rows, opts);
}

const PAYMENT_COLS = [
  "payment_id", "party_id", "party_name", "direction", "currency", "amount", "allocated", "unallocated", "date",
  "method", "method_label", "reference", "note", "state", "receipt_number",
];

/** Every payment of the workspace; allocated/unallocated are 0 for reversed payments. */
export function exportPayments(data: LedgerData, workspaceId: string, opts: ExportOptions): string {
  const { idx } = indexFor(data, workspaceId);
  const rows: CsvCell[][] = [header(PAYMENT_COLS, opts.lang)];
  const list = [...idx.payment.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const p of list) {
    const f = paymentFiguresOf(idx, p);
    const c = p.currency;
    rows.push([
      textCell(p.id),
      textCell(p.partyId),
      textCell(idx.party.get(p.partyId)?.displayName ?? ""),
      p.direction,
      textCell(c),
      numberCell(p.amount, c),
      numberCell(f.allocated, c),
      numberCell(f.unallocated, c),
      p.date,
      p.method,
      textCell(p.methodLabel),
      textCell(p.reference),
      textCell(p.note),
      p.state,
      textCell(p.receiptNumber ?? ""),
    ]);
  }
  return toCsv(rows, opts);
}
