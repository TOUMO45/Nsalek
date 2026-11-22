// Agrovet (veterinary clinic app) export → Nsalek import plan.
//
// Explicit, optional and reversible. This module only transforms a JSON object the user supplies;
// it never opens a network connection or a database. `planAgrovetImport` is the dry run: it returns
// the records to create plus a review report. Committing goes through the `commitImport` command
// (one transaction, refuses a file already imported, re-verifies the ledger invariants) and
// `reverseImport` undoes a committed batch.
//
// Medical-data policy: species, animal quantities, unit prices, medicine names, clinical notes,
// payment notes and reminder texts are NOT copied unless the matching option is set. Veterinary
// details only ever go to `extension.veterinary`. The report counts withheld fields but never holds
// their content: it carries ids, codes, dates and amounts only.
import type { ImportRecords } from "../core/commands.ts";
import { canonical } from "../core/backup.ts";
import { sha256Hex } from "../core/crypto.ts";
import { DEFAULT_TIMEZONE, isISODate, todayIn } from "../core/dates.ts";
import { buildIndex, figuresOf, partyBalance } from "../core/ledger.ts";
import { isCurrency, isPositiveMinor } from "../core/money.ts";
import { normalizePhone } from "../core/text.ts";
import {
  emptyLedger,
  fail,
  type Allocation,
  type CurrencyCode,
  type ISODate,
  type ISOTime,
  type LegacyRef,
  type Obligation,
  type Party,
  type Payment,
  type ReminderLog,
  type ReminderStatus,
  type VeterinaryExtension,
} from "../core/types.ts";

export const AGROVET_SYSTEM = "agrovet";
export const IMPORT_ACTOR = "import:agrovet";
export const IMPORT_TAG = "agrovet";
export const ARCHIVED_TAG = "agrovet:archived";
/** Stored instead of the reminder text unless `includeReminderMessages` is set. */
export const WITHHELD_REMINDER_TEXT = "Agrovet reminder (text not imported)";

export type AgrovetImportOptions = {
  workspaceId: string;
  /** Clock used for createdAt fallbacks and the report timestamp. Default: current time. */
  now?: Date | string;
  /** Local calendar date used to reject future-dated rows. Default: today in `timezone`. */
  today?: ISODate;
  timezone?: string;
  /** Agrovet amounts are DZD centimes. */
  currency?: CurrencyCode;
  /** Prefix of every generated id. Change it only to re-import data after a reversed batch. */
  idPrefix?: string;
  /** Copy species, quantity, unit price and medicine names into `extension.veterinary`. */
  includeVeterinaryDetails?: boolean;
  /** Copy client notes into party notes (they may hold clinical information). */
  includeClientNotes?: boolean;
  /** Copy payment notes into payment notes. */
  includePaymentNotes?: boolean;
  /** Copy the reminder message text into the reminder log. */
  includeReminderMessages?: boolean;
};

export type Severity = "info" | "warning" | "blocking";

export type ReviewItem = {
  severity: Severity;
  code: string;
  collection: "clients" | "debts" | "payments" | "allocations" | "reminders" | "medicines";
  /** Agrovet id of the record. Never a name, note or medical text. */
  id?: string;
  newId?: string;
  amount?: number;
  /** Numbers, dates, ids and codes only. */
  detail?: Record<string, number | string | boolean | null>;
};

/** Invariant: source = imported + Σ skipped + orphaned. */
export type EntityCounts = { source: number; imported: number; skipped: Record<string, number>; orphaned: number };

export type FieldCounts = {
  clientNotes: number;
  debtNotes: number;
  paymentNotes: number;
  reminderMessages: number;
  /** Debts carrying species / quantity / unit price / medicines. */
  veterinaryDetails: number;
  medicineItems: number;
  medicineCatalog: number;
};

export type ClientMismatch = {
  clientId: string;
  partyId: string;
  cachedBalance: number | null;
  computedBalance: number;
  difference: number | null;
  cachedTotalDebt: number | null;
  importedPrincipal: number;
  cachedTotalPaid: number | null;
  importedAllocated: number;
};

export type OpeningBalanceEntry = {
  clientId: string;
  partyId: string;
  obligationId: string;
  amount: number;
  date: ISODate;
  dateSource: "lastDebtDate" | "today";
  /** Payments of this client that were not imported because the balance already nets them. */
  coveredPayments: number;
  coveredAmount: number;
};

export type AgrovetImportReport = {
  source: "agrovet";
  version: 1;
  workspaceId: string;
  generatedAt: ISOTime;
  today: ISODate;
  currency: CurrencyCode;
  fileHash: string;
  options: {
    idPrefix: string;
    includeVeterinaryDetails: boolean;
    includeClientNotes: boolean;
    includePaymentNotes: boolean;
    includeReminderMessages: boolean;
  };
  counts: {
    clients: EntityCounts;
    debts: EntityCounts;
    payments: EntityCounts;
    allocations: EntityCounts;
    reminders: EntityCounts;
    medicines: EntityCounts;
    openingBalances: number;
  };
  totals: {
    debt: { cached: number; imported: number; openingBalances: number; difference: number; matches: boolean };
    paid: {
      cached: number;
      imported: number;
      orphaned: number;
      coveredByOpeningBalance: number;
      skipped: number;
      advances: number;
      difference: number;
      matches: boolean;
    };
    balance: { cached: number; outstanding: number; advances: number; net: number; difference: number; matches: boolean };
  };
  mismatches: ClientMismatch[];
  openingBalances: OpeningBalanceEntry[];
  followUpDates: { mapped: number; invalid: number; note: string };
  withheld: FieldCounts;
  included: FieldCounts;
  review: ReviewItem[];
  blocking: number;
  ready: boolean;
};

export type AgrovetIdMap = {
  clients: Record<string, string>;
  debts: Record<string, string>;
  payments: Record<string, string>;
  reminders: Record<string, string>;
  /** Agrovet client id → opening-balance obligation id. */
  openingBalances: Record<string, string>;
};

export type AgrovetImportPlan = {
  records: ImportRecords & { reminders: ReminderLog[] };
  report: AgrovetImportReport;
  fileHash: string;
  idMap: AgrovetIdMap;
};

// ---------------------------------------------------------------- input helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const SOURCE_ID = /^[\w-]{1,100}$/;
const PREFIX = /^[A-Za-z0-9][\w-]{0,19}$/;
const WORKSPACE_ID = /^[\w:.-]{1,160}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const safeInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const isSet = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false;
const sourceId = (v: unknown) => (typeof v === "string" && SOURCE_ID.test(v) ? v : null);

/** ISO timestamp from an ISO string, epoch milliseconds or a Firestore `{seconds, nanoseconds}` value. */
export function isoTime(v: unknown): ISOTime | null {
  let ms: number | null = null;
  if (typeof v === "string" && v.trim()) ms = Date.parse(v);
  else if (typeof v === "number") ms = v;
  else if (isObj(v)) {
    const s = v.seconds ?? v._seconds;
    const n = v.nanoseconds ?? v._nanoseconds ?? 0;
    if (typeof s === "number" && typeof n === "number") ms = s * 1000 + Math.floor(n / 1e6);
  }
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

export type AgrovetExport = { clients: unknown[]; debts: unknown[]; payments: unknown[]; medicines: unknown[]; reminders: unknown[] };

/** Parses (when given text) and checks the top-level shape `{ clients, debts, payments, medicines?, reminders? }`. */
export function readAgrovetExport(source: unknown): { raw: Obj; data: AgrovetExport } {
  let raw: unknown = source;
  if (typeof source === "string") {
    try {
      raw = JSON.parse(source);
    } catch {
      fail("invalid_json");
    }
  }
  if (!isObj(raw)) fail("invalid_agrovet_export");
  const obj = raw;
  const list = (key: string, required: boolean): unknown[] => {
    const v = obj[key];
    if (v === undefined && !required) return [];
    if (!Array.isArray(v)) fail("invalid_agrovet_export", { field: key });
    return v;
  };
  return {
    raw: obj,
    data: {
      clients: list("clients", true),
      debts: list("debts", true),
      payments: list("payments", true),
      medicines: list("medicines", false),
      reminders: list("reminders", false),
    },
  };
}

const newCounts = (): EntityCounts => ({ source: 0, imported: 0, skipped: {}, orphaned: 0 });
const newFields = (): FieldCounts => ({
  clientNotes: 0,
  debtNotes: 0,
  paymentNotes: 0,
  reminderMessages: 0,
  veterinaryDetails: 0,
  medicineItems: 0,
  medicineCatalog: 0,
});
const skip = (c: EntityCounts, reason: string, n = 1) => {
  if (n > 0) c.skipped[reason] = (c.skipped[reason] ?? 0) + n;
};
const legacy = (collection: string, id: string): LegacyRef => ({ system: AGROVET_SYSTEM, collection, id });

type ClientInfo = {
  id: string;
  partyId: string;
  lastDebtDate: string;
  totalDebt: number | null;
  totalPaid: number | null;
  balance: number | null;
  debts: number;
  principal: number;
  allocated: number;
  openingBalance: OpeningBalanceEntry | null;
};

type DebtInfo = { clientId: string; obligation: Obligation; cachedPaid: number | null };

// ---------------------------------------------------------------- planner

export async function planAgrovetImport(source: unknown, options: AgrovetImportOptions): Promise<AgrovetImportPlan> {
  const { raw, data } = readAgrovetExport(source);
  const workspaceId = options.workspaceId;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) fail("invalid_id");
  const currency = options.currency ?? "DZD";
  if (!isCurrency(currency)) fail("invalid_currency");
  const prefix = options.idPrefix ?? "ag";
  if (!PREFIX.test(prefix)) fail("invalid_id_prefix");
  const clock = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(clock.getTime())) fail("invalid_now");
  const now = clock.toISOString();
  const today = options.today ?? todayIn(options.timezone ?? DEFAULT_TIMEZONE, clock);
  if (!isISODate(today)) fail("invalid_date");
  const opt = {
    idPrefix: prefix,
    includeVeterinaryDetails: options.includeVeterinaryDetails === true,
    includeClientNotes: options.includeClientNotes === true,
    includePaymentNotes: options.includePaymentNotes === true,
    includeReminderMessages: options.includeReminderMessages === true,
  };
  const fileHash = await sha256Hex(canonical(raw));

  const review: ReviewItem[] = [];
  const note = (item: ReviewItem) => review.push(item);
  const withheld = newFields();
  const included = newFields();
  const field = (key: keyof FieldCounts, copied: boolean, n = 1) => {
    (copied ? included : withheld)[key] += n;
  };
  const counts = {
    clients: newCounts(),
    debts: newCounts(),
    payments: newCounts(),
    allocations: newCounts(),
    reminders: newCounts(),
    medicines: newCounts(),
    openingBalances: 0,
  };

  const parties: Party[] = [];
  const obligations: Obligation[] = [];
  const payments: Payment[] = [];
  const allocations: Allocation[] = [];
  const reminders: ReminderLog[] = [];
  const clientMap = new Map<string, ClientInfo>();
  const debtMap = new Map<string, DebtInfo>();
  const paymentIds = new Map<string, string>();
  const reminderIds = new Map<string, string>();
  const seenPayments = new Set<string>();
  const seenReminders = new Set<string>();

  // ---- clients → parties
  for (const c of data.clients) {
    counts.clients.source++;
    if (!isObj(c)) {
      skip(counts.clients, "invalid_record");
      continue;
    }
    const id = sourceId(c.id);
    if (!id) {
      skip(counts.clients, "invalid_id");
      note({ severity: "warning", code: "client_invalid_id", collection: "clients" });
      continue;
    }
    if (clientMap.has(id)) {
      skip(counts.clients, "duplicate_id");
      note({ severity: "warning", code: "client_duplicate_id", collection: "clients", id });
      continue;
    }
    const partyId = `${prefix}_c_${id}`;
    let displayName = str(c.name).slice(0, 120);
    if (!displayName) {
      displayName = `Agrovet ${id}`.slice(0, 120);
      note({ severity: "warning", code: "client_name_missing", collection: "clients", id, newId: partyId });
    }
    const phoneRaw = str(c.phone);
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone?.e164) note({ severity: "info", code: "client_phone_not_normalized", collection: "clients", id, newId: partyId });
    const address = str(c.address);
    if (address.length > 300) note({ severity: "warning", code: "client_address_truncated", collection: "clients", id, newId: partyId });
    const notesRaw = str(c.notes);
    if (notesRaw) field("clientNotes", opt.includeClientNotes);
    if (opt.includeClientNotes && notesRaw.length > 2000) note({ severity: "warning", code: "client_notes_truncated", collection: "clients", id, newId: partyId });
    const archived = c.archived === true;
    const createdAt = isoTime(c.createdAt) ?? now;
    const party: Party = {
      id: partyId,
      workspaceId,
      kind: "person",
      displayName,
      phones: phone ? [phone.value] : [],
      email: "",
      address: address.slice(0, 300),
      taxId: "",
      tags: [IMPORT_TAG],
      isCustomer: true,
      isSupplier: false,
      notes: opt.includeClientNotes ? notesRaw.slice(0, 2000) : "",
      creditLimits: {},
      representatives: [],
      snoozedUntil: null,
      archivedAt: archived ? isoTime(c.updatedAt) ?? now : null,
      mergedIntoId: null,
      legacy: legacy("clients", id),
      createdAt,
    };
    const info: ClientInfo = {
      id,
      partyId,
      lastDebtDate: str(c.lastDebtDate),
      totalDebt: safeInt(c.totalDebt),
      totalPaid: safeInt(c.totalPaid),
      balance: safeInt(c.balance),
      debts: 0,
      principal: 0,
      allocated: 0,
      openingBalance: null,
    };
    if (info.totalDebt === null || info.totalPaid === null || info.balance === null)
      note({ severity: "warning", code: "client_cache_invalid", collection: "clients", id, newId: partyId });
    else if (info.totalDebt - info.totalPaid !== info.balance)
      note({ severity: "warning", code: "client_cache_inconsistent", collection: "clients", id, newId: partyId, detail: { totalDebt: info.totalDebt, totalPaid: info.totalPaid, balance: info.balance } });
    if (info.balance !== null && info.balance < 0)
      note({ severity: "warning", code: "client_negative_balance", collection: "clients", id, newId: partyId, amount: info.balance });
    if (archived && (info.balance ?? 0) > 0)
      note({ severity: "info", code: "client_archived_with_balance", collection: "clients", id, newId: partyId, amount: info.balance ?? 0 });
    parties.push(party);
    clientMap.set(id, info);
    counts.clients.imported++;
  }

  // Debts that received money from their own client must never be dropped, even if flagged deleted.
  const referenced = new Set<string>();
  const refKey = (clientId: unknown, debtId: unknown) => `${String(clientId)}\u0000${String(debtId)}`;
  for (const p of data.payments)
    if (isObj(p) && Array.isArray(p.allocations))
      for (const a of p.allocations)
        if (isObj(a) && typeof a.debtId === "string" && isPositiveMinor(a.amount)) referenced.add(refKey(p.clientId, a.debtId));

  // ---- debts → receivable obligations
  const seenDebts = new Set<string>();
  const followUpDates = { mapped: 0, invalid: 0, note: "Agrovet reminderDate is a follow-up date. It is imported as remindOn; dueDate stays empty." };
  for (const d of data.debts) {
    counts.debts.source++;
    if (!isObj(d)) {
      skip(counts.debts, "invalid_record");
      continue;
    }
    const id = sourceId(d.id);
    if (!id) {
      skip(counts.debts, "invalid_id");
      note({ severity: "warning", code: "debt_invalid_id", collection: "debts" });
      continue;
    }
    if (seenDebts.has(id)) {
      skip(counts.debts, "duplicate_id");
      note({ severity: "warning", code: "debt_duplicate_id", collection: "debts", id });
      continue;
    }
    seenDebts.add(id);
    const amount = safeInt(d.totalAmount) ?? undefined;
    const clientId = typeof d.clientId === "string" ? d.clientId : "";
    const client = clientMap.get(clientId);
    if (!client) {
      counts.debts.orphaned++;
      note({ severity: "warning", code: "debt_client_missing", collection: "debts", id, amount });
      continue;
    }
    const deleted = isSet(d.deletedAt);
    const hasPayments = (safeInt(d.totalPaid) ?? 0) > 0 || referenced.has(refKey(clientId, id));
    if (deleted && !hasPayments) {
      skip(counts.debts, "voided");
      note({ severity: "info", code: "debt_voided_skipped", collection: "debts", id, amount });
      continue;
    }
    const principal = d.totalAmount;
    if (!isPositiveMinor(principal)) {
      skip(counts.debts, "invalid_amount");
      note({ severity: "warning", code: "debt_invalid_amount", collection: "debts", id });
      continue;
    }
    const date = d.date;
    if (!isISODate(date)) {
      skip(counts.debts, "invalid_date");
      note({ severity: "warning", code: "debt_invalid_date", collection: "debts", id, amount: principal });
      continue;
    }
    if (date > today) {
      skip(counts.debts, "future_date");
      note({ severity: "warning", code: "debt_future_date", collection: "debts", id, amount: principal, detail: { date } });
      continue;
    }
    const obligationId = `${prefix}_d_${id}`;
    const archived = d.archived === true;
    if (deleted) note({ severity: "warning", code: "debt_deleted_with_payments", collection: "debts", id, newId: obligationId, amount: principal });
    if (archived) note({ severity: "info", code: "debt_archived_imported", collection: "debts", id, newId: obligationId, amount: principal });
    const qty = safeInt(d.animalQuantity);
    const unit = safeInt(d.unitPrice);
    if (qty !== null && unit !== null && qty * unit !== principal)
      note({ severity: "warning", code: "debt_amount_formula_mismatch", collection: "debts", id, newId: obligationId, amount: principal, detail: { computed: qty * unit } });
    const remindOn = isISODate(d.reminderDate) ? d.reminderDate : null;
    if (remindOn) followUpDates.mapped++;
    else if (isSet(d.reminderDate)) followUpDates.invalid++;
    const species = str(d.animalType).slice(0, 40);
    const medicines = (Array.isArray(d.medicineItems) ? d.medicineItems : [])
      .map((i) => (isObj(i) ? str(i.medicineNameSnapshot).slice(0, 150) : ""))
      .filter(Boolean)
      .slice(0, 20);
    const hasVet = !!species || (qty !== null && qty > 0) || (unit !== null && unit > 0) || medicines.length > 0;
    if (hasVet) field("veterinaryDetails", opt.includeVeterinaryDetails);
    if (medicines.length) field("medicineItems", opt.includeVeterinaryDetails, medicines.length);
    if (str(d.notes)) field("debtNotes", false);
    const ob: Obligation = {
      id: obligationId,
      workspaceId,
      partyId: client.partyId,
      direction: "receivable",
      kind: "service",
      currency,
      principal,
      date,
      dueDate: null,
      remindOn,
      description: `Agrovet ${date}`,
      reference: "",
      tags: archived ? [IMPORT_TAG, ARCHIVED_TAG] : [IMPORT_TAG],
      attachmentIds: [],
      state: "posted",
      voidedAt: null,
      voidReason: null,
      replacesId: null,
      replacedById: null,
      disputed: null,
      creditOverrideReason: null,
      legacy: legacy("debts", id),
      createdAt: isoTime(d.createdAt) ?? now,
      createdBy: IMPORT_ACTOR,
    };
    if (opt.includeVeterinaryDetails && hasVet) {
      const vet: VeterinaryExtension = {};
      if (species) vet.species = species;
      if (qty !== null && qty > 0) vet.animalQuantity = qty;
      if (unit !== null && unit > 0) vet.unitPrice = unit;
      if (medicines.length) vet.medicines = medicines;
      ob.extension = { veterinary: vet };
    }
    obligations.push(ob);
    debtMap.set(id, { clientId, obligation: ob, cachedPaid: safeInt(d.totalPaid) });
    client.debts++;
    client.principal += principal;
    counts.debts.imported++;
  }

  // ---- opening balances: a cached balance with no importable debt behind it
  const openingBalances: OpeningBalanceEntry[] = [];
  for (const client of clientMap.values()) {
    if (client.debts > 0 || !isPositiveMinor(client.balance)) continue;
    const useLast = isISODate(client.lastDebtDate) && client.lastDebtDate <= today;
    const date = useLast ? client.lastDebtDate : today;
    const obligationId = `${prefix}_ob_${client.id}`;
    obligations.push({
      id: obligationId,
      workspaceId,
      partyId: client.partyId,
      direction: "receivable",
      kind: "opening_balance",
      currency,
      principal: client.balance,
      date,
      dueDate: null,
      remindOn: null,
      description: "Agrovet opening balance",
      reference: "",
      tags: [IMPORT_TAG],
      attachmentIds: [],
      state: "posted",
      voidedAt: null,
      voidReason: null,
      replacesId: null,
      replacedById: null,
      disputed: null,
      creditOverrideReason: null,
      legacy: legacy("clients", client.id),
      createdAt: now,
      createdBy: IMPORT_ACTOR,
    });
    client.openingBalance = {
      clientId: client.id,
      partyId: client.partyId,
      obligationId,
      amount: client.balance,
      date,
      dateSource: useLast ? "lastDebtDate" : "today",
      coveredPayments: 0,
      coveredAmount: 0,
    };
    openingBalances.push(client.openingBalance);
    counts.openingBalances++;
    note({ severity: "info", code: "opening_balance_created", collection: "clients", id: client.id, newId: obligationId, amount: client.balance, detail: { date } });
  }

  // ---- payments → receivable payments + allocations
  let orphanedPaid = 0;
  let skippedPaid = 0;
  let coveredPaid = 0;
  for (const p of data.payments) {
    counts.payments.source++;
    const lines = isObj(p) && Array.isArray(p.allocations) ? p.allocations : [];
    counts.allocations.source += lines.length;
    const drop = (reason: string) => skip(counts.allocations, reason, lines.length);
    if (!isObj(p)) {
      skip(counts.payments, "invalid_record");
      drop("payment_skipped");
      continue;
    }
    const id = sourceId(p.id);
    const amountRaw = safeInt(p.amount) ?? undefined;
    if (!id || seenPayments.has(id)) {
      skip(counts.payments, id ? "duplicate_id" : "invalid_id");
      drop("payment_skipped");
      note({ severity: "warning", code: id ? "payment_duplicate_id" : "payment_invalid_id", collection: "payments", id: id ?? undefined, amount: amountRaw });
      continue;
    }
    seenPayments.add(id);
    const clientId = typeof p.clientId === "string" ? p.clientId : "";
    const client = clientMap.get(clientId);
    if (!client) {
      counts.payments.orphaned++;
      drop("payment_skipped");
      note({ severity: "warning", code: "payment_client_missing", collection: "payments", id, amount: amountRaw });
      continue;
    }
    const amount = p.amount;
    if (!isPositiveMinor(amount)) {
      skip(counts.payments, "invalid_amount");
      drop("payment_skipped");
      note({ severity: "warning", code: "payment_invalid_amount", collection: "payments", id });
      continue;
    }
    if (client.openingBalance) {
      // The cached balance already nets this payment; importing it would count it twice.
      skip(counts.payments, "covered_by_opening_balance");
      drop("covered_by_opening_balance");
      client.openingBalance.coveredPayments++;
      client.openingBalance.coveredAmount += amount;
      coveredPaid += amount;
      note({ severity: "info", code: "payment_covered_by_opening_balance", collection: "payments", id, amount });
      continue;
    }
    const date = p.date;
    if (!isISODate(date) || date > today) {
      const reason = isISODate(date) ? "future_date" : "invalid_date";
      skip(counts.payments, reason);
      drop("payment_skipped");
      skippedPaid += amount;
      note({ severity: "warning", code: `payment_${reason}`, collection: "payments", id, amount });
      continue;
    }
    const paymentId = `${prefix}_p_${id}`;
    const createdAt = isoTime(p.createdAt) ?? now;
    const planned: Allocation[] = [];
    lines.forEach((a, i) => {
      if (!isObj(a) || !isPositiveMinor(a.amount)) {
        skip(counts.allocations, "invalid_amount");
        note({ severity: "warning", code: "allocation_invalid_amount", collection: "allocations", id, detail: { index: i + 1 } });
        return;
      }
      const debtRef = typeof a.debtId === "string" ? a.debtId : "";
      const debt = debtMap.get(debtRef);
      if (!debt || debt.clientId !== clientId) {
        counts.allocations.orphaned++;
        orphanedPaid += a.amount;
        const reason = debt ? "other_client" : seenDebts.has(debtRef) ? "debt_skipped" : "debt_missing";
        note({ severity: "warning", code: "allocation_orphan", collection: "allocations", id, amount: a.amount, detail: { index: i + 1, debtId: sourceId(debtRef) ?? "invalid", reason } });
        return;
      }
      planned.push({
        id: `${prefix}_a_${id}_${i + 1}`,
        workspaceId,
        paymentId,
        obligationId: debt.obligation.id,
        partyId: client.partyId,
        amount: a.amount,
        date,
        reversedAt: null,
        createdAt,
      });
    });
    const allocated = planned.reduce((n, a) => n + a.amount, 0);
    if (allocated > amount)
      note({ severity: "blocking", code: "payment_overallocated", collection: "payments", id, newId: paymentId, amount, detail: { allocated } });
    const unallocated = amount - allocated;
    if (unallocated > 0)
      note({ severity: "warning", code: "payment_unallocated_advance", collection: "payments", id, newId: paymentId, amount: unallocated });
    const method = str(p.paymentMethod);
    if (method && method !== "cash" && method !== "other")
      note({ severity: "info", code: "payment_method_unknown", collection: "payments", id, newId: paymentId });
    const noteRaw = str(p.notes);
    if (noteRaw) field("paymentNotes", opt.includePaymentNotes);
    if (opt.includePaymentNotes && noteRaw.length > 1000)
      note({ severity: "warning", code: "payment_note_truncated", collection: "payments", id, newId: paymentId });
    payments.push({
      id: paymentId,
      workspaceId,
      partyId: client.partyId,
      direction: "receivable",
      currency,
      amount,
      date,
      method: method === "cash" ? "cash" : "other",
      methodLabel: "",
      reference: "",
      note: opt.includePaymentNotes ? noteRaw.slice(0, 1000) : "",
      allowAdvance: unallocated > 0,
      state: "posted",
      reversedAt: null,
      reversalReason: null,
      receiptNumber: null,
      legacy: legacy("payments", id),
      attachmentIds: [],
      createdAt,
      createdBy: IMPORT_ACTOR,
    });
    allocations.push(...planned);
    paymentIds.set(id, paymentId);
    client.allocated += allocated;
    counts.payments.imported++;
    counts.allocations.imported += planned.length;
  }

  // ---- reminders → reminder log (Agrovet only knew that the SMS composer was opened)
  for (const r of data.reminders) {
    counts.reminders.source++;
    if (!isObj(r)) {
      skip(counts.reminders, "invalid_record");
      continue;
    }
    const id = sourceId(r.id);
    if (!id || seenReminders.has(id)) {
      skip(counts.reminders, id ? "duplicate_id" : "invalid_id");
      continue;
    }
    seenReminders.add(id);
    const client = clientMap.get(typeof r.clientId === "string" ? r.clientId : "");
    if (!client) {
      counts.reminders.orphaned++;
      note({ severity: "info", code: "reminder_client_missing", collection: "reminders", id });
      continue;
    }
    const reminderId = `${prefix}_r_${id}`;
    const status: ReminderStatus = r.status === "composer_opened" ? "opened_for_sharing" : "prepared";
    if (r.status !== "composer_opened") note({ severity: "info", code: "reminder_status_unknown", collection: "reminders", id, newId: reminderId });
    const createdAt = isoTime(r.createdAt) ?? now;
    const message = str(r.message);
    if (message) field("reminderMessages", opt.includeReminderMessages);
    reminders.push({
      id: reminderId,
      workspaceId,
      partyId: client.partyId,
      channel: "sms",
      language: r.language === "ar" ? "ar" : "fr",
      message: opt.includeReminderMessages && message ? message.slice(0, 1500) : WITHHELD_REMINDER_TEXT,
      amounts: isPositiveMinor(r.balance) ? [{ currency, amount: r.balance }] : [],
      status,
      history: [{ status, at: createdAt }],
      createdAt,
    });
    reminderIds.set(id, reminderId);
    counts.reminders.imported++;
  }

  // ---- medicines: catalog only, never imported
  counts.medicines.source = data.medicines.length;
  skip(counts.medicines, "not_imported", data.medicines.length);
  withheld.medicineCatalog = data.medicines.length;

  // ---- reconciliation on the planned records, with the same ledger logic the app uses
  const ledger = emptyLedger();
  ledger.parties = parties;
  ledger.obligations = obligations;
  ledger.payments = payments;
  ledger.allocations = allocations;
  ledger.reminders = reminders;
  const idx = buildIndex(ledger, workspaceId);
  for (const ob of obligations) {
    const outstanding = figuresOf(idx, ob).outstanding;
    if (outstanding < 0)
      note({ severity: "blocking", code: "debt_overallocated", collection: "debts", id: ob.legacy?.id, newId: ob.id, amount: outstanding });
  }
  for (const [id, info] of debtMap) {
    const paid = figuresOf(idx, info.obligation).paid;
    if (info.cachedPaid !== null && info.cachedPaid !== paid)
      note({ severity: "warning", code: "debt_paid_cache_mismatch", collection: "debts", id, newId: info.obligation.id, amount: paid, detail: { cachedTotalPaid: info.cachedPaid } });
  }

  const totals: AgrovetImportReport["totals"] = {
    debt: { cached: 0, imported: 0, openingBalances: 0, difference: 0, matches: false },
    paid: { cached: 0, imported: 0, orphaned: orphanedPaid, coveredByOpeningBalance: coveredPaid, skipped: skippedPaid, advances: 0, difference: 0, matches: false },
    balance: { cached: 0, outstanding: 0, advances: 0, net: 0, difference: 0, matches: false },
  };
  const mismatches: ClientMismatch[] = [];
  for (const client of clientMap.values()) {
    const b = partyBalance(idx, client.partyId, today).get(currency);
    const outstanding = b?.receivable ?? 0;
    const advances = b?.advanceReceived ?? 0;
    const net = outstanding - advances;
    totals.debt.cached += client.totalDebt ?? 0;
    totals.debt.imported += client.principal;
    totals.debt.openingBalances += client.openingBalance?.amount ?? 0;
    totals.paid.cached += client.totalPaid ?? 0;
    totals.paid.imported += client.allocated;
    totals.paid.advances += advances;
    totals.balance.cached += client.balance ?? 0;
    totals.balance.outstanding += outstanding;
    totals.balance.advances += advances;
    if (client.balance === null || client.balance !== net) {
      mismatches.push({
        clientId: client.id,
        partyId: client.partyId,
        cachedBalance: client.balance,
        computedBalance: net,
        difference: client.balance === null ? null : client.balance - net,
        cachedTotalDebt: client.totalDebt,
        importedPrincipal: client.principal,
        cachedTotalPaid: client.totalPaid,
        importedAllocated: client.allocated,
      });
      note({ severity: "warning", code: "balance_mismatch", collection: "clients", id: client.id, newId: client.partyId, amount: net, detail: { cachedBalance: client.balance } });
    }
  }
  totals.debt.difference = totals.debt.cached - (totals.debt.imported + totals.debt.openingBalances);
  totals.debt.matches = totals.debt.difference === 0;
  totals.paid.difference = totals.paid.cached - totals.paid.imported;
  totals.paid.matches = totals.paid.difference === 0;
  totals.balance.net = totals.balance.outstanding - totals.balance.advances;
  totals.balance.difference = totals.balance.cached - totals.balance.net;
  totals.balance.matches = totals.balance.difference === 0;

  const blocking = review.filter((r) => r.severity === "blocking").length;
  const report: AgrovetImportReport = {
    source: "agrovet",
    version: 1,
    workspaceId,
    generatedAt: now,
    today,
    currency,
    fileHash,
    options: opt,
    counts,
    totals,
    mismatches,
    openingBalances,
    followUpDates,
    withheld,
    included,
    review,
    blocking,
    ready: blocking === 0,
  };
  const idMap: AgrovetIdMap = {
    clients: Object.fromEntries([...clientMap].map(([k, v]) => [k, v.partyId])),
    debts: Object.fromEntries([...debtMap].map(([k, v]) => [k, v.obligation.id])),
    payments: Object.fromEntries(paymentIds),
    reminders: Object.fromEntries(reminderIds),
    openingBalances: Object.fromEntries(openingBalances.map((o) => [o.clientId, o.obligationId])),
  };
  return { records: { parties, obligations, payments, allocations, reminders }, report, fileHash, idMap };
}

/** Payload for `execute(store, { id, type: "commitImport", payload })`. */
export function agrovetCommitPayload(plan: AgrovetImportPlan, fileName: string) {
  return {
    workspaceId: plan.report.workspaceId,
    source: "agrovet" as const,
    fileName,
    fileHash: plan.fileHash,
    records: plan.records,
    report: plan.report,
  };
}
