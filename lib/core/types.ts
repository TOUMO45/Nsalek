// Domain types for the Nsalek financial core.
// Every amount is an integer number of minor units (centimes for DZD).
// Dates without time are local calendar dates "YYYY-MM-DD" in the workspace time zone.

export type ISODate = string; // YYYY-MM-DD
export type ISOTime = string; // full ISO timestamp (UTC)
export type Minor = number; // safe integer minor units
export type CurrencyCode = string; // ISO 4217, e.g. "DZD"

/** receivable: the other party owes the workspace (ليك). payable: the workspace owes them (عليك). */
export type Direction = "receivable" | "payable";

export type WorkspaceMode = "personal" | "business";

export type LegacyRef = { system: string; collection: string; id: string };

export type WorkspaceSettings = {
  /** Upper bounds (inclusive, in days past due) of aging buckets; last bucket is open-ended. */
  agingBounds: number[];
  /** Minimum whole days between two reminders to the same party. */
  reminderMinDays: number;
  /** Local notification quiet hours, "HH:MM" 24h. */
  quietHours: { start: string; end: string };
  /** Items due within this many days count as "due soon". */
  dueSoonDays: number;
  invoices: {
    enabled: boolean;
    prefix: string;
    nextNumber: number;
    /** Optional configured tax rates in basis points; empty means no tax lines. */
    taxRates: { id: string; label: string; bps: number }[];
  };
  receipts: { prefix: string; nextNumber: number };
  creditLimitWarnings: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  mode: WorkspaceMode;
  defaultCurrency: CurrencyCode;
  timezone: string;
  country: string;
  business: { name: string; phone: string; address: string; email: string; taxId: string };
  settings: WorkspaceSettings;
  createdAt: ISOTime;
  updatedAt?: ISOTime;
  archivedAt?: ISOTime | null;
  demo?: boolean;
};

export type Party = {
  id: string;
  workspaceId: string;
  kind: "person" | "organization";
  displayName: string;
  phones: string[]; // normalized E.164 when recognized, otherwise digits as typed
  email: string;
  address: string;
  taxId: string;
  tags: string[];
  isCustomer: boolean;
  isSupplier: boolean;
  notes: string;
  /** Optional warning threshold per currency for receivables. Not credit scoring. */
  creditLimits: Record<CurrencyCode, Minor>;
  representatives: { name: string; phone: string; role: string }[];
  snoozedUntil?: ISODate | null;
  archivedAt?: ISOTime | null;
  mergedIntoId?: string | null;
  legacy?: LegacyRef | null;
  importBatchId?: string | null;
  createdAt: ISOTime;
  updatedAt?: ISOTime;
};

export type ObligationKind =
  | "debt"
  | "loan"
  | "credit_sale"
  | "service"
  | "invoice"
  | "opening_balance"
  | "recurring";

export type Obligation = {
  id: string;
  workspaceId: string;
  partyId: string;
  direction: Direction;
  kind: ObligationKind;
  currency: CurrencyCode;
  principal: Minor;
  date: ISODate;
  dueDate?: ISODate | null;
  remindOn?: ISODate | null;
  description: string;
  reference: string;
  tags: string[];
  state: "draft" | "posted" | "voided";
  voidedAt?: ISOTime | null;
  voidReason?: string | null;
  replacesId?: string | null;
  replacedById?: string | null;
  disputed?: { since: ISOTime; note: string } | null;
  invoiceId?: string | null;
  recurringPlanId?: string | null;
  periodKey?: string | null;
  importBatchId?: string | null;
  importFingerprint?: string | null;
  legacy?: LegacyRef | null;
  creditOverrideReason?: string | null;
  /** Optional domain extensions. Never required for a general debt. */
  extension?: { veterinary?: VeterinaryExtension } | null;
  attachmentIds: string[];
  createdAt: ISOTime;
  createdBy: string;
  updatedAt?: ISOTime;
};

export type VeterinaryExtension = {
  species?: string;
  animalQuantity?: number;
  unitPrice?: Minor;
  medicines?: string[];
};

export type AdjustmentType = "increase" | "decrease" | "waiver" | "write_off" | "netting";

export type Adjustment = {
  id: string;
  workspaceId: string;
  obligationId: string;
  partyId: string;
  type: AdjustmentType;
  amount: Minor; // always positive; sign comes from type
  date: ISODate;
  reason: string;
  nettingId?: string | null;
  reversedAt?: ISOTime | null;
  reversalReason?: string | null;
  createdAt: ISOTime;
  createdBy: string;
};

export type PaymentMethod = "cash" | "bank_transfer" | "ccp_baridimob" | "card" | "other";

export type Payment = {
  id: string;
  workspaceId: string;
  partyId: string;
  /** The direction of the obligations it settles: receivable = money received, payable = money paid out. */
  direction: Direction;
  currency: CurrencyCode;
  amount: Minor;
  date: ISODate;
  method: PaymentMethod;
  methodLabel: string;
  reference: string;
  note: string;
  /** True only when the user explicitly accepted keeping an unallocated remainder as an advance. */
  allowAdvance: boolean;
  state: "posted" | "reversed";
  reversedAt?: ISOTime | null;
  reversalReason?: string | null;
  receiptNumber?: string | null;
  importBatchId?: string | null;
  importFingerprint?: string | null;
  legacy?: LegacyRef | null;
  attachmentIds: string[];
  createdAt: ISOTime;
  createdBy: string;
};

export type Allocation = {
  id: string;
  workspaceId: string;
  paymentId: string;
  obligationId: string;
  partyId: string;
  amount: Minor;
  /** Effective date: the payment date, or the date an advance was applied later. */
  date: ISODate;
  reversedAt?: ISOTime | null;
  createdAt: ISOTime;
};

export type InstallmentItem = { seq: number; dueDate: ISODate; amount: Minor };

export type InstallmentPlan = {
  id: string;
  workspaceId: string;
  obligationId: string;
  partyId: string;
  frequency: "weekly" | "monthly" | "custom";
  items: InstallmentItem[];
  total: Minor;
  /** Amount already settled on the obligation when the plan was created. */
  baseSettled: Minor;
  state: "active" | "superseded" | "cancelled";
  supersedesId?: string | null;
  supersededById?: string | null;
  reason: string;
  createdAt: ISOTime;
};

export type RecurringPlan = {
  id: string;
  workspaceId: string;
  partyId: string;
  direction: Direction;
  currency: CurrencyCode;
  amount: Minor;
  description: string;
  frequency: "monthly" | "weekly";
  startDate: ISODate;
  endDate?: ISODate | null;
  dueAfterDays: number;
  pauses: { from: ISODate; to?: ISODate | null }[];
  state: "active" | "ended";
  endedAt?: ISOTime | null;
  createdAt: ISOTime;
};

export type PromiseToPay = {
  id: string;
  workspaceId: string;
  partyId: string;
  obligationId?: string | null;
  currency: CurrencyCode;
  amount: Minor;
  promisedDate: ISODate;
  note: string;
  madeOn: ISODate;
  cancelledAt?: ISOTime | null;
  createdAt: ISOTime;
};

export type ReminderChannel = "whatsapp" | "sms" | "email" | "copy" | "local_notification";
/** Only states with real evidence may be recorded. This version can reach the first three plus failed. */
export type ReminderStatus =
  | "prepared"
  | "opened_for_sharing"
  | "marked_sent"
  | "provider_accepted"
  | "delivered"
  | "failed";

export type ReminderLog = {
  id: string;
  workspaceId: string;
  partyId: string;
  channel: ReminderChannel;
  language: string;
  message: string;
  amounts: { currency: CurrencyCode; amount: Minor }[];
  status: ReminderStatus;
  history: { status: ReminderStatus; at: ISOTime }[];
  createdAt: ISOTime;
};

export type InvoiceLine = {
  description: string;
  /** Quantity in thousandths (1 unit = 1000). */
  quantityMilli: number;
  unitPrice: Minor;
  discountBps: number;
  taxBps: number;
};

export type Invoice = {
  id: string;
  workspaceId: string;
  partyId: string;
  number: string;
  date: ISODate;
  dueDate?: ISODate | null;
  currency: CurrencyCode;
  lines: InvoiceLine[];
  notes: string;
  state: "draft" | "posted" | "voided";
  obligationId?: string | null;
  totals: { subtotal: Minor; discount: Minor; tax: Minor; total: Minor };
  postedAt?: ISOTime | null;
  voidedAt?: ISOTime | null;
  createdAt: ISOTime;
};

export type DraftNote = {
  id: string;
  workspaceId: string;
  text: string;
  convertedTo?: { type: "obligation" | "payment"; id: string } | null;
  archivedAt?: ISOTime | null;
  createdAt: ISOTime;
};

export type Attachment = {
  id: string;
  workspaceId: string;
  ownerType: "obligation" | "payment" | "party" | "invoice";
  ownerId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** base64 payload (no data: prefix) */
  data: string;
  createdAt: ISOTime;
};

export type AuditEvent = {
  id: string;
  workspaceId: string;
  at: ISOTime;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  commandId: string;
};

export type ImportBatch = {
  id: string;
  workspaceId: string;
  source: "csv" | "agrovet" | "backup_merge";
  fileName: string;
  fileHash: string;
  created: { store: StoreName; id: string }[];
  counts: Record<string, number>;
  state: "committed" | "reversed";
  reversedAt?: ISOTime | null;
  reversalReason?: string | null;
  report?: unknown;
  createdAt: ISOTime;
};

export type CommandRecord = { id: string; type: string; at: ISOTime; result: unknown };

/** Non-extractable AES key. It never leaves the device and is not part of any backup. */
export type BackupKey = { key: CryptoKey; salt: string; iterations: number; createdAt: ISOTime; confirmedAt: ISOTime };

export type MetaRecord = {
  id: string; // "app"
  schemaVersion: number;
  deviceId: string;
  activeWorkspaceId: string | null;
  lastBackupAt?: ISOTime | null;
  lastBackupError?: string | null;
  /** How the last backup left the app: handed to another app, or saved on this device. */
  lastBackupVia?: "shared" | "downloaded" | null;
  /** Key for one-tap backups, derived once from the user's passphrase (see core/quickBackup.ts). */
  backupKey?: BackupKey | null;
  pin?: { salt: string; hash: string; iterations: number } | null;
  /** Consecutive wrong PINs and when the last one happened (see core/pin.ts). */
  pinFailures?: number;
  pinLastFailAt?: ISOTime | null;
  persistentStorage?: "granted" | "denied" | "unsupported" | null;
  lastNotifiedOn?: ISODate | null;
};

export type SnapshotRecord = { id: string; createdAt: ISOTime; reason: string; backup: string };

export type RowMap = {
  meta: MetaRecord;
  workspaces: Workspace;
  parties: Party;
  obligations: Obligation;
  adjustments: Adjustment;
  payments: Payment;
  allocations: Allocation;
  installmentPlans: InstallmentPlan;
  recurringPlans: RecurringPlan;
  promises: PromiseToPay;
  reminders: ReminderLog;
  invoices: Invoice;
  notes: DraftNote;
  attachments: Attachment;
  audit: AuditEvent;
  importBatches: ImportBatch;
  commands: CommandRecord;
  snapshots: SnapshotRecord;
};

export type StoreName = keyof RowMap;

/** Stores whose records belong to a workspace and are part of a workspace backup. */
export const DATA_STORES = [
  "workspaces",
  "parties",
  "obligations",
  "adjustments",
  "payments",
  "allocations",
  "installmentPlans",
  "recurringPlans",
  "promises",
  "reminders",
  "invoices",
  "notes",
  "attachments",
  "audit",
  "importBatches",
] as const satisfies readonly StoreName[];

export type DataStore = (typeof DATA_STORES)[number];

export const ALL_STORES: StoreName[] = [...DATA_STORES, "meta", "commands", "snapshots"];

/** In-memory snapshot of all workspace-scoped records. */
export type LedgerData = { [K in DataStore]: RowMap[K][] };

export const emptyLedger = (): LedgerData => ({
  workspaces: [],
  parties: [],
  obligations: [],
  adjustments: [],
  payments: [],
  allocations: [],
  installmentPlans: [],
  recurringPlans: [],
  promises: [],
  reminders: [],
  invoices: [],
  notes: [],
  attachments: [],
  audit: [],
  importBatches: [],
});

export class DomainError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, details?: Record<string, unknown>): never {
  throw new DomainError(code, details);
}

export function check(condition: unknown, code: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) fail(code, details);
}
