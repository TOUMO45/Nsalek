// CSV import pipeline: mapping, per-row validation and a dry run that builds exactly the records
// `commitImport` writes (one transaction, reversible with `reverseImport`). Nothing here writes
// to the store. Identity is never guessed from a name alone unless the user turns on matchByName.
import type { ImportRecords } from "./commands.ts";
import { sha256Hex } from "./crypto.ts";
import { isISODate } from "./dates.ts";
import { buildIndex, findDuplicates, openObligations, planAllocation, type AllocationLine } from "./ledger.ts";
import { isCurrency, normalizeDigits, parseAmount, type Lang } from "./money.ts";
import { normalizePhone, normalizeText, phoneKey } from "./text.ts";
import {
  DomainError,
  type Allocation,
  type CurrencyCode,
  type Direction,
  type ISODate,
  type ISOTime,
  type LedgerData,
  type Minor,
  type Obligation,
  type Party,
  type Payment,
} from "./types.ts";
import { integerCell, parseCsv, toCsv, unguardFormula, type CsvCell, type Delimiter } from "./csv.ts";

export { decodeCsvBytes, detectDelimiter, parseCsv, type DecodedCsv, type ParsedCsv } from "./csv.ts";

// ---------------------------------------------------------------- mapping

export type ImportField = "type" | "partyName" | "phone" | "direction" | "amount" | "currency" | "date" | "dueDate" | "description" | "reference";

export const IMPORT_FIELDS: readonly ImportField[] = ["type", "partyName", "phone", "direction", "amount", "currency", "date", "dueDate", "description", "reference"];
export const REQUIRED_FIELDS: readonly ImportField[] = ["type", "partyName", "direction", "amount", "date"];

/** A 0-based column index, a fixed value used for every row, or null/absent when unmapped. */
export type ColumnRef = number | { value: string } | null;

export type DateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";

export type ImportMapping = { [K in ImportField]?: ColumnRef } & {
  dateFormat: DateFormat;
  /** "centime": the amount column holds whole DZD centimes (DZD rows only). */
  amountUnit: "major" | "centime";
  /** Used when no currency column is mapped or the cell is empty. */
  defaultCurrency: CurrencyCode;
  /** Match existing people by exact normalized name (off by default: names are not identities). */
  matchByName: boolean;
  /** Keep a payment's excess over open debts as an advance instead of rejecting the row. */
  allowAdvance: boolean;
  /** First row is a header (default true). */
  hasHeader?: boolean;
  /** Force a delimiter instead of auto-detection. */
  delimiter?: Delimiter;
};

const DATE_FORMATS: readonly DateFormat[] = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"];

/** Throws DomainError("mapping_required" | "invalid_mapping" | "invalid_currency", { field }). */
export function checkMapping(m: ImportMapping): void {
  for (const field of IMPORT_FIELDS) {
    const ref = m[field];
    if (ref === undefined || ref === null) {
      if (REQUIRED_FIELDS.includes(field)) throw new DomainError("mapping_required", { field });
      continue;
    }
    if (typeof ref === "number") {
      if (!Number.isSafeInteger(ref) || ref < 0 || ref > 1000) throw new DomainError("invalid_mapping", { field });
    } else if (typeof ref !== "object" || typeof ref.value !== "string") {
      throw new DomainError("invalid_mapping", { field });
    } else if (REQUIRED_FIELDS.includes(field) && !ref.value.trim()) {
      throw new DomainError("mapping_required", { field });
    }
  }
  if (!DATE_FORMATS.includes(m.dateFormat)) throw new DomainError("invalid_mapping", { field: "dateFormat" });
  if (m.amountUnit !== "major" && m.amountUnit !== "centime") throw new DomainError("invalid_mapping", { field: "amountUnit" });
  if (typeof m.defaultCurrency !== "string" || !isCurrency(m.defaultCurrency)) throw new DomainError("invalid_currency", { field: "defaultCurrency" });
}

const key = (s: string) => normalizeText(s).replace(/[_\-.']+/g, " ").replace(/\s+/g, " ").trim();

const HEADER_SYNONYMS: Record<ImportField, string[]> = {
  type: ["type", "nature", "kind", "النوع"],
  partyName: ["name", "nom", "party", "person", "personne", "client", "contact", "الاسم", "الشخص", "اسم"],
  phone: ["phone", "telephone", "tel", "mobile", "phones", "الهاتف", "هاتف", "رقم الهاتف"],
  direction: ["direction", "sens", "side", "الاتجاه"],
  amount: ["amount", "montant", "somme", "المبلغ"],
  currency: ["currency", "devise", "monnaie", "العملة"],
  date: ["date", "التاريخ"],
  dueDate: ["due date", "due", "echeance", "date d echeance", "تاريخ الاستحقاق", "الاستحقاق"],
  description: ["description", "libelle", "details", "note", "الوصف", "البيان"],
  reference: ["reference", "ref", "numero", "المرجع", "رقم"],
};

/** Proposes column indexes from header names (ar/fr/en, case- and accent-insensitive). */
export function suggestMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const wanted = new Set(HEADER_SYNONYMS[field].map(key));
    const i = headers.findIndex((h, n) => !used.has(n) && wanted.has(key(h)));
    if (i >= 0) {
      out[field] = i;
      used.add(i);
    }
  }
  return out;
}

// ---------------------------------------------------------------- value parsing

const TYPE_WORDS: Record<"debt" | "payment", string[]> = {
  debt: ["debt", "obligation", "dette", "دين"],
  payment: ["payment", "repayment", "paiement", "versement", "remboursement", "reglement", "دفع", "دفعة", "تسديد", "خلاص"],
};

const DIRECTION_WORDS: Record<Direction, string[]> = {
  receivable: ["receivable", "owed to me", "they owe me", "creance", "a recevoir", "on me doit", "ليك", "دين لي", "مستحق لي"],
  payable: ["payable", "i owe", "i owe them", "dette", "a payer", "je dois", "عليك", "دين علي", "مستحق علي"],
};

function lookup<T extends string>(table: Record<T, string[]>, raw: string): T | null {
  const k = key(raw);
  for (const [value, words] of Object.entries(table) as [T, string[]][]) if (words.some((w) => key(w) === k)) return value;
  return null;
}

/** Accepts only clear synonyms; anything else is null (a row error, never a guess). */
export const parseDirection = (raw: string): Direction | null => lookup(DIRECTION_WORDS, raw);
export const parseRowType = (raw: string): "debt" | "payment" | null => lookup(TYPE_WORDS, raw);

/** Parses a date in the declared format (Arabic-Indic digits accepted). Null when invalid. */
export function parseDateCell(raw: string, format: DateFormat): ISODate | null {
  const s = normalizeDigits(raw).trim();
  let y: string, m: string, d: string;
  if (format === "YYYY-MM-DD") {
    const r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (!r) return null;
    [y, m, d] = [r[1], r[2], r[3]];
  } else {
    const r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!r) return null;
    [d, m] = format === "DD/MM/YYYY" ? [r[1], r[2]] : [r[2], r[1]];
    y = r[3];
  }
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isISODate(iso) ? iso : null;
}

const CURRENCY_ALIASES: Record<string, CurrencyCode> = { DA: "DZD", "دج": "DZD", "د.ج": "DZD", "€": "EUR" };

function parseCurrency(raw: string, fallback: CurrencyCode): CurrencyCode | null {
  const s = raw.trim();
  if (!s) return fallback;
  const code = CURRENCY_ALIASES[s] ?? CURRENCY_ALIASES[s.toUpperCase()] ?? s.toUpperCase();
  return isCurrency(code) ? code : null;
}

/** Fingerprint of a row's financial content: party identity|type|direction|currency|amount|date|reference. */
export async function importFingerprint(f: {
  party: string;
  type: "debt" | "payment";
  direction: Direction;
  currency: CurrencyCode;
  amount: Minor;
  date: ISODate;
  reference: string;
}): Promise<string> {
  return sha256Hex(JSON.stringify([f.party, f.type, f.direction, f.currency, f.amount, f.date, normalizeText(f.reference)]));
}

/** Identity used in fingerprints: the phone key when known, else the normalized name. */
export const partyIdentity = (name: string, phone: string | null) => {
  const k = phone ? phoneKey(phone) : "";
  return k.length >= 8 ? "tel:" + k : "name:" + normalizeText(name);
};

// ---------------------------------------------------------------- dry run

export const MAX_IMPORT_ROWS = 20_000;

export type RowPreview = {
  type: "debt" | "payment" | null;
  partyName: string;
  phone: string | null;
  partyId: string | null;
  /** How the counterparty was resolved. */
  party: "new" | "matched_phone" | "matched_name" | null;
  direction: Direction | null;
  currency: CurrencyCode | null;
  amount: Minor | null;
  date: ISODate | null;
  dueDate: ISODate | null;
  description: string;
  reference: string;
  /** Payment rows: planned oldest-due-first allocation. */
  allocations: AllocationLine[];
  /** Payment rows: amount not allocated (an advance when allowed, otherwise the overpayment). */
  unallocated: Minor;
  /** Existing or earlier-in-file people that look like this new person (same name or phone). */
  possibleDuplicates: { id: string; displayName: string }[];
  duplicateOf: { line: number } | { store: "obligations" | "payments"; id: string } | null;
  /** Non-blocking notes: "name_differs" (matched by phone), "phone_not_saved" (matched by name). */
  warnings: string[];
  /** Id of the obligation/payment this row creates. */
  recordId: string | null;
};

export type ImportRow = { line: number; status: "ok" | "error" | "duplicate"; errors: string[]; preview: RowPreview };

export type NewPartyInfo = { id: string; displayName: string; phones: string[]; lines: number[]; possibleDuplicates: { id: string; displayName: string }[] };
export type MatchedPartyInfo = { id: string; displayName: string; by: "phone" | "name"; lines: number[] };

export type ImportTotals = { currency: CurrencyCode; direction: Direction; debts: Minor; payments: Minor; advances: Minor }[];

export type ImportCounts = {
  rows: number;
  ok: number;
  error: number;
  duplicate: number;
  newParties: number;
  matchedParties: number;
  obligations: number;
  payments: number;
  allocations: number;
};

export type DryRunResult = {
  workspaceId: string;
  fileName: string;
  fileHash: string;
  delimiter: Delimiter;
  /** A committed batch with the same file hash exists; commitImport will refuse (already_imported). */
  alreadyImported: boolean;
  rows: ImportRow[];
  records: ImportRecords;
  newParties: NewPartyInfo[];
  matchedParties: MatchedPartyInfo[];
  /** Downloadable CSV (line, code) of rejected rows; duplicates are listed with code "duplicate". */
  errorsCsv: string;
  counts: ImportCounts;
  totals: ImportTotals;
  /** Summary stored on the ImportBatch. */
  report: { fileName: string; delimiter: Delimiter; counts: ImportCounts; totals: ImportTotals; rejected: { line: number; status: string; errors: string[] }[] };
};

export type DryRunInput = {
  text: string;
  mapping: ImportMapping;
  data: LedgerData;
  workspaceId: string;
  /** Workspace-local date; rows dated after it are rejected. */
  today: ISODate;
  fileName: string;
  /** createdAt of the built records (default: now). */
  now?: ISOTime;
};

type Draft = {
  line: number;
  errors: string[];
  type: "debt" | "payment" | null;
  name: string;
  nameKey: string;
  phone: string | null;
  phoneKey: string;
  direction: Direction | null;
  currency: CurrencyCode | null;
  amount: Minor | null;
  date: ISODate | null;
  dueDate: ISODate | null;
  description: string;
  reference: string;
  fingerprint: string | null;
};

type PoolEntry = { party: Party; isNew: boolean; nameKey: string; phoneKeys: string[] };

const pad = (n: number) => String(n).padStart(6, "0");

function readRow(cells: string[], line: number, m: ImportMapping, today: ISODate): Draft {
  const get = (field: ImportField): string => {
    const ref = m[field];
    if (ref === undefined || ref === null) return "";
    const raw = typeof ref === "number" ? (cells[ref] ?? "") : ref.value;
    return unguardFormula(raw.trim()).trim();
  };
  const errors: string[] = [];
  const typeRaw = get("type");
  const type = typeRaw ? parseRowType(typeRaw) : null;
  if (!typeRaw) errors.push("type_required");
  else if (!type) errors.push("invalid_type");

  const name = get("partyName").replace(/\s+/g, " ");
  if (!name) errors.push("name_required");
  else if (name.length > 120) errors.push("name_too_long");

  const phoneRaw = get("phone");
  let phone: string | null = null;
  let pk = "";
  if (phoneRaw) {
    const n = phoneRaw.length <= 40 ? normalizePhone(phoneRaw) : null;
    pk = n ? phoneKey(n.value) : "";
    if (!n || pk.length < 8) errors.push("invalid_phone");
    else phone = n.value;
  }

  const dirRaw = get("direction");
  const direction = dirRaw ? parseDirection(dirRaw) : null;
  if (!dirRaw) errors.push("direction_required");
  else if (!direction) errors.push("invalid_direction");

  const currency = parseCurrency(get("currency"), m.defaultCurrency);
  if (!currency) errors.push("invalid_currency");

  let amount: Minor | null = null;
  const amountRaw = get("amount");
  if (!amountRaw) errors.push("amount_required");
  else if (currency) {
    if (m.amountUnit === "centime" && currency !== "DZD") errors.push("centime_requires_dzd");
    else {
      const r = parseAmount(amountRaw, currency, { unit: m.amountUnit });
      if (!r.ok) errors.push("amount_" + r.error);
      else if (r.expression) errors.push("amount_expression");
      else amount = r.minor;
    }
  }

  const dateRaw = get("date");
  const date = dateRaw ? parseDateCell(dateRaw, m.dateFormat) : null;
  if (!dateRaw) errors.push("date_required");
  else if (!date) errors.push("invalid_date");
  else if (date > today) errors.push("future_date");

  const dueRaw = type === "payment" ? "" : get("dueDate");
  const dueDate = dueRaw ? parseDateCell(dueRaw, m.dateFormat) : null;
  if (dueRaw && !dueDate) errors.push("invalid_due_date");
  else if (dueDate && date && dueDate < date) errors.push("due_before_date");

  const description = get("description");
  if (description.length > 500) errors.push("description_too_long");
  const reference = get("reference");
  if (reference.length > 120) errors.push("reference_too_long");

  return { line, errors, type, name, nameKey: normalizeText(name), phone, phoneKey: pk, direction, currency, amount, date, dueDate, description, reference, fingerprint: null };
}

const emptyPreview = (d: Draft): RowPreview => ({
  type: d.type,
  partyName: d.name,
  phone: d.phone,
  partyId: null,
  party: null,
  direction: d.direction,
  currency: d.currency,
  amount: d.amount,
  date: d.date,
  dueDate: d.dueDate,
  description: d.description,
  reference: d.reference,
  allocations: [],
  unallocated: 0,
  possibleDuplicates: [],
  duplicateOf: null,
  warnings: [],
  recordId: null,
});

/**
 * Validates every row and builds the records a commit would write, without writing anything.
 * Rows with errors or duplicates are excluded from `records`; the rest are self-consistent
 * (payments allocate oldest-due-first to existing debts and debts from earlier rows).
 */
export async function dryRunImport(input: DryRunInput): Promise<DryRunResult> {
  const { text, mapping, data, workspaceId, today, fileName } = input;
  const now = input.now ?? new Date().toISOString();
  checkMapping(mapping);
  if (!isISODate(today)) throw new DomainError("invalid_date", { field: "today" });
  if (!data.workspaces.some((w) => w.id === workspaceId)) throw new DomainError("workspace_not_found");

  const parsed = parseCsv(text, mapping.delimiter);
  const start = mapping.hasHeader === false ? 0 : 1;
  const body: { cells: string[]; line: number }[] = [];
  for (let i = start; i < parsed.rows.length; i++) {
    const cells = parsed.rows[i];
    if (cells.every((c) => !c.trim())) continue;
    body.push({ cells, line: parsed.lines[i] });
  }
  if (body.length > MAX_IMPORT_ROWS) throw new DomainError("csv_too_large", { max: MAX_IMPORT_ROWS, rows: body.length });

  const fileHash = await sha256Hex(text);
  const batches = data.importBatches.filter((b) => b.workspaceId === workspaceId && b.fileHash === fileHash);
  const alreadyImported = batches.some((b) => b.state === "committed");
  // Ids are derived from the hash and line so replaying the same dry run collides; after a
  // reversal (same file again) the generation suffix keeps new ids distinct from voided ones.
  const prefix = `csv_${fileHash.slice(0, 12)}` + (batches.length ? `_r${batches.length}` : "");

  const drafts = body.map((r) => readRow(r.cells, r.line, mapping, today));
  await Promise.all(
    drafts.map(async (d) => {
      if (d.errors.length) return;
      d.fingerprint = await importFingerprint({
        party: partyIdentity(d.name, d.phone),
        type: d.type!,
        direction: d.direction!,
        currency: d.currency!,
        amount: d.amount!,
        date: d.date!,
        reference: d.reference,
      });
    }),
  );

  const idx = buildIndex(data, workspaceId);
  const existingFp = new Map<string, { store: "obligations" | "payments"; id: string }>();
  for (const o of idx.obligation.values()) if (o.importFingerprint && o.state !== "voided") existingFp.set(o.importFingerprint, { store: "obligations", id: o.id });
  for (const p of idx.payment.values()) if (p.importFingerprint && p.state === "posted") existingFp.set(p.importFingerprint, { store: "payments", id: p.id });
  const seenFp = new Map<string, number>();

  // Matching pool: active people of this workspace, plus people created by earlier rows.
  const entry = (party: Party, isNew: boolean): PoolEntry => ({ party, isNew, nameKey: normalizeText(party.displayName), phoneKeys: party.phones.map(phoneKey).filter((k) => k.length >= 8) });
  const pool: PoolEntry[] = idx.parties.filter((p) => !p.mergedIntoId && !p.archivedAt).map((p) => entry(p, false));
  const dupeCandidates: Party[] = [...idx.parties];
  const newByKey = new Map<string, PoolEntry>();
  const newInfo = new Map<string, NewPartyInfo>();
  const matched = new Map<string, MatchedPartyInfo>();
  const used = new Set<string>();

  const remaining = new Map<string, Minor>();
  const openLists = new Map<string, Obligation[]>();
  const openList = (pe: PoolEntry, direction: Direction, currency: CurrencyCode) => {
    const k = `${pe.party.id}|${direction}|${currency}`;
    let list = openLists.get(k);
    if (!list) {
      list = [];
      if (!pe.isNew)
        for (const x of openObligations(idx, pe.party.id, direction, currency)) {
          remaining.set(x.obligation.id, x.outstanding);
          list.push(x.obligation);
        }
      openLists.set(k, list);
    }
    return list;
  };

  const records: ImportRecords = { parties: [], obligations: [], payments: [], allocations: [] };
  const rows: ImportRow[] = [];
  const totals = new Map<string, ImportTotals[number]>();

  for (const d of drafts) {
    const preview = emptyPreview(d);
    const errors = [...d.errors];
    const done = (status: ImportRow["status"]) => rows.push({ line: d.line, status, errors, preview });
    if (errors.length) {
      done("error");
      continue;
    }
    const fp = d.fingerprint!;
    const dupExisting = existingFp.get(fp);
    const dupLine = seenFp.get(fp);
    if (!seenFp.has(fp)) seenFp.set(fp, d.line);
    if (dupExisting || dupLine !== undefined) {
      preview.duplicateOf = dupExisting ?? { line: dupLine! };
      done("duplicate");
      continue;
    }

    // ---- counterparty
    let pe: PoolEntry | null = null;
    let how: RowPreview["party"] = null;
    if (d.phoneKey) {
      const hits = pool.filter((x) => x.phoneKeys.includes(d.phoneKey));
      if (hits.length > 1) errors.push("ambiguous_party");
      else if (hits.length === 1) {
        pe = hits[0];
        how = pe.isNew ? "new" : "matched_phone";
        if (pe.nameKey !== d.nameKey) preview.warnings.push("name_differs");
      }
    }
    if (!pe && !errors.length) {
      const grouped = newByKey.get(`${d.nameKey}|${d.phoneKey}`);
      if (grouped) {
        pe = grouped;
        how = "new";
      } else if (mapping.matchByName) {
        // With a phone that matched nobody, only people without any phone can be the same person.
        const hits = pool.filter((x) => x.nameKey === d.nameKey && (!d.phoneKey || !x.phoneKeys.length));
        if (hits.length > 1) errors.push("ambiguous_party");
        else if (hits.length === 1) {
          pe = hits[0];
          how = pe.isNew ? "new" : "matched_name";
          if (d.phone && !pe.party.phones.includes(d.phone)) preview.warnings.push("phone_not_saved");
        }
      }
    }
    if (!pe && !errors.length) {
      const party: Party = {
        id: `${prefix}_p${pad(d.line)}`,
        workspaceId,
        kind: "person",
        displayName: d.name,
        phones: d.phone ? [d.phone] : [],
        email: "",
        address: "",
        taxId: "",
        tags: [],
        isCustomer: false,
        isSupplier: false,
        notes: "",
        creditLimits: {},
        representatives: [],
        snoozedUntil: null,
        archivedAt: null,
        mergedIntoId: null,
        importBatchId: null,
        createdAt: now,
      };
      const possibleDuplicates = findDuplicates(dupeCandidates, party).map((p) => ({ id: p.id, displayName: p.displayName }));
      pe = entry(party, true);
      how = "new";
      pool.push(pe);
      dupeCandidates.push(party);
      newByKey.set(`${d.nameKey}|${d.phoneKey}`, pe);
      newInfo.set(party.id, { id: party.id, displayName: party.displayName, phones: party.phones, lines: [], possibleDuplicates });
    }
    if (!pe) {
      done("error");
      continue;
    }
    const target = pe;
    const partyId = target.party.id;
    preview.partyId = partyId;
    preview.party = how;
    if (target.isNew) preview.possibleDuplicates = newInfo.get(partyId)?.possibleDuplicates ?? [];

    const direction = d.direction!;
    const currency = d.currency!;
    const amount = d.amount!;
    const recordId = `${prefix}_${pad(d.line)}`;
    const list = openList(target, direction, currency);
    const tk = `${currency}|${direction}`;
    const total = totals.get(tk) ?? { currency, direction, debts: 0, payments: 0, advances: 0 };

    if (d.type === "debt") {
      const ob: Obligation = {
        id: recordId,
        workspaceId,
        partyId,
        direction,
        kind: "debt",
        currency,
        principal: amount,
        date: d.date!,
        dueDate: d.dueDate,
        remindOn: null,
        description: d.description,
        reference: d.reference,
        tags: [],
        state: "posted",
        voidedAt: null,
        voidReason: null,
        replacesId: null,
        replacedById: null,
        disputed: null,
        importBatchId: null,
        importFingerprint: fp,
        creditOverrideReason: null,
        attachmentIds: [],
        createdAt: now,
        createdBy: "import",
      };
      records.obligations.push(ob);
      list.push(ob);
      remaining.set(ob.id, amount);
      total.debts += amount;
    } else {
      const open = list.map((obligation) => ({ obligation, outstanding: remaining.get(obligation.id) ?? 0 })).filter((x) => x.outstanding > 0);
      const plan = planAllocation(open, amount);
      preview.allocations = plan.lines;
      preview.unallocated = plan.unallocated;
      if (plan.unallocated > 0 && !mapping.allowAdvance) {
        errors.push("overpayment");
        done("error");
        continue;
      }
      const pay: Payment = {
        id: recordId,
        workspaceId,
        partyId,
        direction,
        currency,
        amount,
        date: d.date!,
        method: "other",
        methodLabel: "",
        reference: d.reference,
        note: d.description,
        allowAdvance: mapping.allowAdvance,
        state: "posted",
        reversedAt: null,
        reversalReason: null,
        receiptNumber: null,
        importBatchId: null,
        importFingerprint: fp,
        attachmentIds: [],
        createdAt: now,
        createdBy: "import",
      };
      records.payments.push(pay);
      plan.lines.forEach((l, i) => {
        remaining.set(l.obligationId, (remaining.get(l.obligationId) ?? 0) - l.amount);
        const a: Allocation = {
          id: `alc_${pay.id}_${i + 1}`,
          workspaceId,
          paymentId: pay.id,
          obligationId: l.obligationId,
          partyId,
          amount: l.amount,
          date: pay.date,
          reversedAt: null,
          createdAt: now,
        };
        records.allocations.push(a);
      });
      total.payments += amount;
      total.advances += plan.unallocated;
    }
    totals.set(tk, total);
    preview.recordId = recordId;
    used.add(partyId);
    if (target.isNew) newInfo.get(partyId)!.lines.push(d.line);
    else {
      const info: MatchedPartyInfo = matched.get(partyId) ?? { id: partyId, displayName: target.party.displayName, by: how === "matched_name" ? "name" : "phone", lines: [] };
      info.lines.push(d.line);
      matched.set(partyId, info);
    }
    done("ok");
  }

  for (const pe of pool) if (pe.isNew && used.has(pe.party.id)) records.parties.push(pe.party);
  const newParties = [...newInfo.values()].filter((p) => used.has(p.id));
  const matchedParties = [...matched.values()];

  const counts: ImportCounts = {
    rows: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    error: rows.filter((r) => r.status === "error").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    newParties: newParties.length,
    matchedParties: matchedParties.length,
    obligations: records.obligations.length,
    payments: records.payments.length,
    allocations: records.allocations.length,
  };
  const totalList = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.direction.localeCompare(b.direction));
  const rejected = rows.filter((r) => r.status !== "ok");
  const errorRows: CsvCell[][] = [["line", "code"]];
  for (const r of rejected) for (const code of r.status === "duplicate" ? ["duplicate"] : r.errors) errorRows.push([integerCell(r.line), code]);

  return {
    workspaceId,
    fileName,
    fileHash,
    delimiter: parsed.delimiter,
    alreadyImported,
    rows,
    records,
    newParties,
    matchedParties,
    errorsCsv: toCsv(errorRows),
    counts,
    totals: totalList,
    report: {
      fileName,
      delimiter: parsed.delimiter,
      counts,
      totals: totalList,
      rejected: rejected.slice(0, 1000).map((r) => ({ line: r.line, status: r.status, errors: r.status === "duplicate" ? ["duplicate"] : r.errors })),
    },
  };
}

/** Payload for `execute(store, { id, type: "commitImport", payload })`. */
export function commitPayload(r: DryRunResult) {
  return { workspaceId: r.workspaceId, source: "csv" as const, fileName: r.fileName, fileHash: r.fileHash, records: r.records, report: r.report };
}

// ---------------------------------------------------------------- template

const TEMPLATE: Record<Lang, { delimiter: Delimiter; header: string[]; rows: string[][] }> = {
  en: {
    delimiter: ",",
    header: ["type", "name", "phone", "direction", "amount", "currency", "date", "due_date", "description", "reference"],
    rows: [
      ["debt", "Karim Benali", "0550 12 34 56", "receivable", "15000", "DZD", "2026-11-01", "2026-12-01", "Cement, 10 bags", "INV-001"],
      ["payment", "Karim Benali", "0550 12 34 56", "receivable", "5000", "DZD", "2026-11-10", "", "Cash", "R-001"],
    ],
  },
  fr: {
    delimiter: ";",
    header: ["type", "nom", "téléphone", "sens", "montant", "devise", "date", "échéance", "description", "référence"],
    rows: [
      ["dette", "Karim Benali", "0550 12 34 56", "créance", "15000", "DZD", "2026-11-01", "2026-12-01", "Ciment, 10 sacs", "F-001"],
      ["paiement", "Karim Benali", "0550 12 34 56", "créance", "5000", "DZD", "2026-11-10", "", "Espèces", "R-001"],
    ],
  },
  ar: {
    delimiter: ";",
    header: ["النوع", "الاسم", "الهاتف", "الاتجاه", "المبلغ", "العملة", "التاريخ", "تاريخ الاستحقاق", "الوصف", "المرجع"],
    rows: [
      ["دين", "كريم بن علي", "0550 12 34 56", "ليك", "15000", "DZD", "2026-11-01", "2026-12-01", "إسمنت 10 أكياس", "F-001"],
      ["دفع", "كريم بن علي", "0550 12 34 56", "ليك", "5000", "DZD", "2026-11-10", "", "نقدا", "R-001"],
    ],
  },
};

/** Template CSV (UTF-8 BOM, YYYY-MM-DD dates, plain amounts) with a header and two example rows. */
export function csvTemplate(lang: Lang): string {
  const t = TEMPLATE[lang] ?? TEMPLATE.en;
  return toCsv([t.header, ...t.rows], { delimiter: t.delimiter });
}
