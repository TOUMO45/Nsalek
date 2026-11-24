// Command engine. Every change to financial data goes through `execute`, which runs the
// handler inside one read-write transaction, records the command id for idempotency and
// appends audit events. Handlers only await store operations (IndexedDB requirement).
import { addDays, isISODate, todayIn } from "./dates.ts";
import { buildSchedule } from "./installments.ts";
import { invoiceTotals } from "./invoice.ts";
import {
  allocationOrder,
  findDuplicates,
  obligationFigures,
  paymentFigures,
  planAllocation,
  type AllocationLine,
} from "./ledger.ts";
import { isCurrency, isPositiveMinor, isValidMinor } from "./money.ts";
import { occurrencesUntil } from "./recurrence.ts";
import type { Store, Tx } from "./store.ts";
import { normalizePhone } from "./text.ts";
import {
  check,
  fail,
  type Adjustment,
  type AdjustmentType,
  type Allocation,
  type AuditEvent,
  type Direction,
  type ISODate,
  type ImportBatch,
  type InstallmentPlan,
  type Invoice,
  type InvoiceLine,
  type Obligation,
  type ObligationKind,
  type Party,
  type Payment,
  type PaymentMethod,
  type PromiseToPay,
  type RecurringPlan,
  type ReminderChannel,
  type ReminderLog,
  type ReminderStatus,
  type RowMap,
  type StoreName,
  type Workspace,
  type WorkspaceSettings,
} from "./types.ts";

export type Write = { store: StoreName; value: unknown; deleted?: boolean };

export type CommandInput = { id: string; type: string; payload: Record<string, unknown>; actor?: string };

export type CommandOutcome<T = unknown> = { result: T; replayed: boolean; writes: Write[] };

type Ctx = {
  tx: Tx;
  now: string;
  clock: Date;
  actor: string;
  commandId: string;
  writes: Write[];
  seq: number;
};

type Handler = (ctx: Ctx, p: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------- validation helpers

const ID_RE = /^[\w:.-]{1,160}$/;

const idOf = (v: unknown, code = "invalid_id"): string => {
  check(typeof v === "string" && ID_RE.test(v), code);
  return v;
};
const text = (v: unknown, max = 500): string => {
  if (v === undefined || v === null) return "";
  check(typeof v === "string", "invalid_text");
  const s = v.trim();
  check(s.length <= max, "text_too_long", { max });
  return s;
};
const required = (v: unknown, max: number, code: string) => {
  const s = text(v, max);
  check(s.length > 0, code);
  return s;
};
const isoDate = (v: unknown, code = "invalid_date"): ISODate => {
  check(isISODate(v), code);
  return v;
};
const optDate = (v: unknown, code = "invalid_date"): ISODate | null => (v ? isoDate(v, code) : null);
const positive = (v: unknown, code = "amount_positive") => {
  check(isPositiveMinor(v), code);
  return v as number;
};
const currencyOf = (v: unknown) => {
  check(typeof v === "string" && isCurrency(v), "invalid_currency");
  return v;
};
function oneOf<T extends string>(v: unknown, list: readonly T[], code: string): T {
  check(typeof v === "string" && (list as readonly string[]).includes(v), code);
  return v as T;
}
const bool = (v: unknown) => v === true;
const tags = (v: unknown): string[] => {
  if (!v) return [];
  check(Array.isArray(v) && v.length <= 30, "invalid_tags");
  return [...new Set(v.map((t) => required(t, 40, "invalid_tags")))];
};
const DIRECTIONS = ["receivable", "payable"] as const;
const METHODS = ["cash", "bank_transfer", "ccp_baridimob", "card", "other"] as const;
// "invoice" and "recurring" obligations are created only by their own flows.
const KINDS = ["debt", "loan", "credit_sale", "service", "opening_balance"] as const;

// ---------------------------------------------------------------- context helpers

async function put<K extends StoreName>(ctx: Ctx, store: K, value: RowMap[K]) {
  await ctx.tx.put(store, value);
  ctx.writes.push({ store, value });
}
async function add<K extends StoreName>(ctx: Ctx, store: K, value: RowMap[K]) {
  await ctx.tx.add(store, value);
  ctx.writes.push({ store, value });
}

async function audit(ctx: Ctx, e: Omit<AuditEvent, "id" | "at" | "actor" | "commandId">) {
  const event: AuditEvent = {
    id: `aud_${ctx.commandId}_${++ctx.seq}`,
    at: ctx.now,
    actor: ctx.actor,
    commandId: ctx.commandId,
    ...e,
  };
  await add(ctx, "audit", event);
}

async function workspace(ctx: Ctx, id: unknown): Promise<Workspace> {
  const ws = await ctx.tx.get("workspaces", idOf(id));
  check(ws && !ws.archivedAt, "workspace_not_found");
  return ws;
}
const todayOf = (ctx: Ctx, ws: Workspace) => todayIn(ws.timezone, ctx.clock);

async function party(ctx: Ctx, ws: Workspace, id: unknown, opts: { allowArchived?: boolean } = { allowArchived: true }) {
  const p = await ctx.tx.get("parties", idOf(id));
  check(p && p.workspaceId === ws.id, "party_not_found");
  check(!p.mergedIntoId, "party_merged");
  if (!opts.allowArchived) check(!p.archivedAt, "party_archived");
  return p;
}

async function obligation(ctx: Ctx, id: unknown) {
  const ob = await ctx.tx.get("obligations", idOf(id));
  check(ob, "obligation_not_found");
  return ob;
}

type PartyLedger = { obligations: Obligation[]; payments: Payment[]; allocations: Allocation[]; adjustments: Adjustment[] };

async function partyLedger(ctx: Ctx, partyId: string): Promise<PartyLedger> {
  const [obligations, payments, allocations, adjustments] = await Promise.all([
    ctx.tx.where("obligations", "partyId", partyId),
    ctx.tx.where("payments", "partyId", partyId),
    ctx.tx.where("allocations", "partyId", partyId),
    ctx.tx.where("adjustments", "partyId", partyId),
  ]);
  return { obligations, payments, allocations, adjustments };
}

const figures = (l: PartyLedger, ob: Obligation) => obligationFigures(ob, l.allocations, l.adjustments);

function openOf(l: PartyLedger, direction: Direction, currency: string) {
  return l.obligations
    .filter((o) => o.state === "posted" && o.direction === direction && o.currency === currency)
    .map((o) => ({ obligation: o, outstanding: figures(l, o).outstanding }))
    .filter((x) => x.outstanding > 0);
}

/** Validates explicit allocation lines against the compatible open obligations. */
function validateLines(lines: unknown, open: { obligation: Obligation; outstanding: number }[]): AllocationLine[] {
  check(Array.isArray(lines) && lines.length <= 1000, "invalid_allocations");
  const byId = new Map(open.map((x) => [x.obligation.id, x]));
  const seen = new Set<string>();
  return lines.map((raw) => {
    const l = raw as AllocationLine;
    const id = idOf(l?.obligationId);
    check(!seen.has(id), "duplicate_allocation");
    seen.add(id);
    const target = byId.get(id);
    check(target, "allocation_incompatible", { obligationId: id });
    positive(l.amount, "allocation_positive");
    check(l.amount <= target.outstanding, "allocation_exceeds_outstanding", { obligationId: id, outstanding: target.outstanding });
    return { obligationId: id, amount: l.amount };
  });
}

// ---------------------------------------------------------------- default settings

export const defaultSettings = (): WorkspaceSettings => ({
  agingBounds: [7, 30, 60, 90],
  reminderMinDays: 3,
  quietHours: { start: "21:00", end: "08:00" },
  dueSoonDays: 7,
  invoices: { enabled: false, prefix: "F-", nextNumber: 1, taxRates: [] },
  receipts: { prefix: "R-", nextNumber: 1 },
  creditLimitWarnings: true,
});

function settingsOf(v: unknown, base: WorkspaceSettings): WorkspaceSettings {
  if (!v || typeof v !== "object") return base;
  const s = v as Partial<WorkspaceSettings>;
  const next = { ...base, ...s, invoices: { ...base.invoices, ...(s.invoices ?? {}) }, receipts: { ...base.receipts, ...(s.receipts ?? {}) } };
  check(
    Array.isArray(next.agingBounds) &&
      next.agingBounds.length >= 1 &&
      next.agingBounds.length <= 8 &&
      next.agingBounds.every((b, i, a) => Number.isInteger(b) && b > 0 && (i === 0 || b > a[i - 1])),
    "invalid_aging",
  );
  check(Number.isInteger(next.reminderMinDays) && next.reminderMinDays >= 0 && next.reminderMinDays <= 60, "invalid_settings");
  check(Number.isInteger(next.dueSoonDays) && next.dueSoonDays >= 0 && next.dueSoonDays <= 60, "invalid_settings");
  check(/^\d{2}:\d{2}$/.test(next.quietHours.start) && /^\d{2}:\d{2}$/.test(next.quietHours.end), "invalid_settings");
  check(Array.isArray(next.invoices.taxRates) && next.invoices.taxRates.every((t) => Number.isInteger(t.bps) && t.bps >= 0 && t.bps <= 10000), "tax_invalid");
  check(Number.isInteger(next.invoices.nextNumber) && next.invoices.nextNumber >= 1, "invalid_settings");
  return next;
}

// ---------------------------------------------------------------- handlers

const handlers: Record<string, Handler> = {};

handlers.createWorkspace = async (ctx, p) => {
  const id = p.workspaceId ? idOf(p.workspaceId) : `ws_${ctx.commandId}`;
  const business = (p.business ?? {}) as Record<string, unknown>;
  const ws: Workspace = {
    id,
    name: required(p.name, 80, "name_required"),
    mode: oneOf(p.mode ?? "personal", ["personal", "business"] as const, "invalid_mode"),
    defaultCurrency: currencyOf(p.defaultCurrency ?? "DZD"),
    timezone: text(p.timezone ?? "Africa/Algiers", 64) || "Africa/Algiers",
    country: text(p.country ?? "DZ", 2) || "DZ",
    business: {
      name: text(business.name, 120),
      phone: text(business.phone, 40),
      address: text(business.address, 300),
      email: text(business.email, 120),
      taxId: text(business.taxId, 60),
    },
    settings: settingsOf(p.settings, defaultSettings()),
    createdAt: ctx.now,
    demo: bool(p.demo),
  };
  try {
    todayIn(ws.timezone);
  } catch {
    fail("invalid_timezone");
  }
  await add(ctx, "workspaces", ws);
  await audit(ctx, { workspaceId: id, action: "workspace.create", entityType: "workspace", entityId: id, after: ws });
  return { workspaceId: id };
};

handlers.updateWorkspace = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const c = (p.changes ?? {}) as Record<string, unknown>;
  const business = (c.business ?? ws.business) as Record<string, unknown>;
  const next: Workspace = {
    ...ws,
    name: c.name !== undefined ? required(c.name, 80, "name_required") : ws.name,
    mode: c.mode !== undefined ? oneOf(c.mode, ["personal", "business"] as const, "invalid_mode") : ws.mode,
    defaultCurrency: c.defaultCurrency !== undefined ? currencyOf(c.defaultCurrency) : ws.defaultCurrency,
    business: {
      name: text(business.name, 120),
      phone: text(business.phone, 40),
      address: text(business.address, 300),
      email: text(business.email, 120),
      taxId: text(business.taxId, 60),
    },
    settings: settingsOf(c.settings, ws.settings),
    updatedAt: ctx.now,
  };
  await put(ctx, "workspaces", next);
  await audit(ctx, { workspaceId: ws.id, action: "workspace.update", entityType: "workspace", entityId: ws.id, before: ws, after: next });
  return { workspaceId: ws.id };
};

handlers.archiveWorkspace = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const next = { ...ws, archivedAt: ctx.now };
  await put(ctx, "workspaces", next);
  await audit(ctx, { workspaceId: ws.id, action: "workspace.archive", entityType: "workspace", entityId: ws.id, reason: text(p.reason, 300) });
  return { workspaceId: ws.id };
};

function partyFields(p: Record<string, unknown>, base?: Party) {
  const phones = Array.isArray(p.phones) ? p.phones : base?.phones ?? [];
  check(phones.length <= 5, "too_many_phones");
  const normalized = [
    ...new Set(
      phones
        .map((ph) => normalizePhone(text(ph, 40)))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => x.value),
    ),
  ];
  const reps = Array.isArray(p.representatives) ? p.representatives : base?.representatives ?? [];
  check(reps.length <= 20, "invalid_representatives");
  const limits = (p.creditLimits ?? base?.creditLimits ?? {}) as Record<string, unknown>;
  const creditLimits: Record<string, number> = {};
  for (const [cur, v] of Object.entries(limits)) {
    if (v === null || v === undefined || v === 0) continue;
    currencyOf(cur);
    check(isValidMinor(v), "invalid_credit_limit");
    creditLimits[cur] = v as number;
  }
  const pick = <T>(key: string, fallback: T, f: (v: unknown) => T) => (p[key] !== undefined ? f(p[key]) : fallback);
  return {
    kind: pick("kind", base?.kind ?? "person", (v) => oneOf(v, ["person", "organization"] as const, "invalid_kind")),
    displayName: pick("displayName", base?.displayName ?? "", (v) => required(v, 120, "name_required")),
    phones: normalized,
    email: pick("email", base?.email ?? "", (v) => text(v, 120)),
    address: pick("address", base?.address ?? "", (v) => text(v, 300)),
    taxId: pick("taxId", base?.taxId ?? "", (v) => text(v, 60)),
    tags: pick("tags", base?.tags ?? [], tags),
    isCustomer: pick("isCustomer", base?.isCustomer ?? false, bool),
    isSupplier: pick("isSupplier", base?.isSupplier ?? false, bool),
    notes: pick("notes", base?.notes ?? "", (v) => text(v, 2000)),
    creditLimits,
    representatives: reps.map((r) => {
      const o = r as Record<string, unknown>;
      return { name: required(o.name, 120, "name_required"), phone: normalizePhone(text(o.phone, 40))?.value ?? "", role: text(o.role, 60) };
    }),
  };
}

handlers.createParty = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const fields = partyFields(p);
  check(fields.displayName, "name_required");
  if (!bool(p.allowDuplicate)) {
    const existing = await ctx.tx.where("parties", "workspaceId", ws.id);
    const dupes = findDuplicates(existing, fields);
    if (dupes.length) fail("possible_duplicate", { ids: dupes.map((d) => d.id), names: dupes.map((d) => d.displayName) });
  }
  const party: Party = {
    id: p.partyId ? idOf(p.partyId) : `pty_${ctx.commandId}`,
    workspaceId: ws.id,
    ...fields,
    snoozedUntil: null,
    archivedAt: null,
    mergedIntoId: null,
    createdAt: ctx.now,
  };
  await add(ctx, "parties", party);
  await audit(ctx, { workspaceId: ws.id, action: "party.create", entityType: "party", entityId: party.id, after: party });
  return { partyId: party.id };
};

handlers.updateParty = async (ctx, p) => {
  const before = await ctx.tx.get("parties", idOf(p.partyId));
  check(before, "party_not_found");
  const ws = await workspace(ctx, before.workspaceId);
  await party(ctx, ws, before.id);
  const changes = (p.changes ?? {}) as Record<string, unknown>;
  const after: Party = { ...before, ...partyFields(changes, before), updatedAt: ctx.now };
  await put(ctx, "parties", after);
  await audit(ctx, { workspaceId: ws.id, action: "party.update", entityType: "party", entityId: before.id, before, after });
  return { partyId: before.id };
};

handlers.archiveParty = async (ctx, p) => {
  const before = await ctx.tx.get("parties", idOf(p.partyId));
  check(before, "party_not_found");
  const ws = await workspace(ctx, before.workspaceId);
  const archived = bool(p.archived);
  if (archived) {
    const l = await partyLedger(ctx, before.id);
    const outstanding = l.obligations.reduce((n, o) => n + figures(l, o).outstanding, 0);
    // Archiving hides the contact; its debts stay in every total.
    if (outstanding > 0) check(bool(p.confirmOutstanding), "archive_has_balance", { outstanding });
  }
  const after: Party = { ...before, archivedAt: archived ? ctx.now : null, updatedAt: ctx.now };
  await put(ctx, "parties", after);
  await audit(ctx, { workspaceId: ws.id, action: archived ? "party.archive" : "party.restore", entityType: "party", entityId: before.id, reason: text(p.reason, 300) });
  return { partyId: before.id };
};

handlers.mergeParties = async (ctx, p) => {
  const source = await ctx.tx.get("parties", idOf(p.sourceId));
  const target = await ctx.tx.get("parties", idOf(p.targetId));
  check(source && target && source.id !== target.id, "party_not_found");
  check(source.workspaceId === target.workspaceId, "workspace_mismatch");
  check(!source.mergedIntoId && !target.mergedIntoId, "party_merged");
  const ws = await workspace(ctx, source.workspaceId);
  const moved: Record<string, string[]> = {};
  for (const store of ["obligations", "payments", "allocations", "adjustments", "promises", "reminders"] as const) {
    const rows = (await ctx.tx.where(store, "partyId", source.id)) as { id: string; partyId: string }[];
    moved[store] = rows.map((r) => r.id);
    for (const r of rows) await put(ctx, store, { ...r, partyId: target.id } as never);
  }
  for (const store of ["installmentPlans", "recurringPlans", "invoices"] as const) {
    const rows = ((await ctx.tx.where(store, "workspaceId", ws.id)) as { id: string; partyId: string }[]).filter((r) => r.partyId === source.id);
    moved[store] = rows.map((r) => r.id);
    for (const r of rows) await put(ctx, store, { ...r, partyId: target.id } as never);
  }
  const mergedTarget: Party = {
    ...target,
    phones: [...new Set([...target.phones, ...source.phones])].slice(0, 5),
    tags: [...new Set([...target.tags, ...source.tags])],
    notes: [target.notes, source.notes].filter(Boolean).join("\n"),
    isCustomer: target.isCustomer || source.isCustomer,
    isSupplier: target.isSupplier || source.isSupplier,
    updatedAt: ctx.now,
  };
  await put(ctx, "parties", mergedTarget);
  await put(ctx, "parties", { ...source, mergedIntoId: target.id, archivedAt: ctx.now, updatedAt: ctx.now });
  await audit(ctx, {
    workspaceId: ws.id,
    action: "party.merge",
    entityType: "party",
    entityId: source.id,
    reason: required(p.reason ?? "merge", 300, "reason_required"),
    before: { source, target },
    after: { targetId: target.id, moved },
  });
  return { partyId: target.id, moved };
};

handlers.snoozeParty = async (ctx, p) => {
  const before = await ctx.tx.get("parties", idOf(p.partyId));
  check(before, "party_not_found");
  const until = optDate(p.until);
  await put(ctx, "parties", { ...before, snoozedUntil: until, updatedAt: ctx.now });
  await audit(ctx, { workspaceId: before.workspaceId, action: until ? "party.snooze" : "party.unsnooze", entityType: "party", entityId: before.id, after: { until } });
  return { partyId: before.id };
};

async function creditCheck(ctx: Ctx, ws: Workspace, pt: Party, ob: Obligation, overrideReason: string) {
  const limit = pt.creditLimits?.[ob.currency];
  if (!ws.settings.creditLimitWarnings || ob.direction !== "receivable" || !limit) return null;
  const l = await partyLedger(ctx, pt.id);
  const current = openOf(l, "receivable", ob.currency).reduce((n, x) => n + x.outstanding, 0);
  if (current + ob.principal <= limit) return null;
  check(overrideReason, "credit_limit", { limit, after: current + ob.principal });
  return overrideReason;
}

function obligationFields(p: Record<string, unknown>, today: ISODate) {
  const date = isoDate(p.date ?? today);
  check(date <= today, "future_date");
  const dueDate = optDate(p.dueDate);
  if (dueDate) check(dueDate >= date, "due_before_date");
  const remindOn = optDate(p.remindOn);
  return {
    direction: oneOf(p.direction, DIRECTIONS, "invalid_direction"),
    kind: oneOf(p.kind ?? "debt", KINDS, "invalid_kind") as ObligationKind,
    currency: currencyOf(p.currency),
    principal: positive(p.principal),
    date,
    dueDate,
    remindOn,
    description: text(p.description, 500),
    reference: text(p.reference, 120),
    tags: tags(p.tags),
    attachmentIds: Array.isArray(p.attachmentIds) ? p.attachmentIds.map((a) => idOf(a)) : [],
  };
}

async function createInstallments(ctx: Ctx, ob: Obligation, spec: Record<string, unknown>, outstanding: number, baseSettled: number, supersedes?: InstallmentPlan) {
  const frequency = oneOf(spec.frequency, ["weekly", "monthly", "custom"] as const, "invalid_frequency");
  const items = buildSchedule({
    total: outstanding,
    frequency,
    count: spec.count as number,
    startDate: spec.startDate as ISODate,
    items: spec.items as { dueDate: ISODate; amount: number }[],
  });
  const plan: InstallmentPlan = {
    id: `ins_${ctx.commandId}`,
    workspaceId: ob.workspaceId,
    obligationId: ob.id,
    partyId: ob.partyId,
    frequency,
    items,
    total: outstanding,
    baseSettled,
    state: "active",
    supersedesId: supersedes?.id ?? null,
    supersededById: null,
    reason: text(spec.reason, 300),
    createdAt: ctx.now,
  };
  if (supersedes) await put(ctx, "installmentPlans", { ...supersedes, state: "superseded", supersededById: plan.id });
  await add(ctx, "installmentPlans", plan);
  await audit(ctx, {
    workspaceId: ob.workspaceId,
    action: supersedes ? "installments.reschedule" : "installments.create",
    entityType: "installmentPlan",
    entityId: plan.id,
    reason: plan.reason || null,
    before: supersedes ?? null,
    after: plan,
  });
  return plan;
}

handlers.createObligation = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId, { allowArchived: false });
  const today = todayOf(ctx, ws);
  const fields = obligationFields(p, today);
  const ob: Obligation = {
    id: p.obligationId ? idOf(p.obligationId) : `obl_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    ...fields,
    state: bool(p.draft) ? "draft" : "posted",
    voidedAt: null,
    voidReason: null,
    replacesId: null,
    replacedById: null,
    disputed: null,
    creditOverrideReason: null,
    attachmentIds: fields.attachmentIds,
    createdAt: ctx.now,
    createdBy: ctx.actor,
  };
  if (ob.state === "posted") ob.creditOverrideReason = await creditCheck(ctx, ws, pt, ob, text(p.creditOverrideReason, 300));
  await add(ctx, "obligations", ob);
  await audit(ctx, { workspaceId: ws.id, action: ob.state === "draft" ? "obligation.draft" : "obligation.post", entityType: "obligation", entityId: ob.id, after: ob, reason: ob.creditOverrideReason });
  let planId: string | null = null;
  if (p.installments && ob.state === "posted") planId = (await createInstallments(ctx, ob, p.installments as Record<string, unknown>, ob.principal, 0)).id;
  return { obligationId: ob.id, installmentPlanId: planId };
};

handlers.updateDraft = async (ctx, p) => {
  const before = await obligation(ctx, p.obligationId);
  check(before.state === "draft", "not_draft");
  const ws = await workspace(ctx, before.workspaceId);
  const merged = { ...before, ...(p.changes as object) } as unknown as Record<string, unknown>;
  const fields = obligationFields(merged, todayOf(ctx, ws));
  const after: Obligation = { ...before, ...fields, updatedAt: ctx.now };
  await put(ctx, "obligations", after);
  await audit(ctx, { workspaceId: ws.id, action: "obligation.draft_update", entityType: "obligation", entityId: before.id, before, after });
  return { obligationId: before.id };
};

handlers.postDraft = async (ctx, p) => {
  const before = await obligation(ctx, p.obligationId);
  check(before.state === "draft", "not_draft");
  const ws = await workspace(ctx, before.workspaceId);
  const pt = await party(ctx, ws, before.partyId, { allowArchived: false });
  obligationFields(before as unknown as Record<string, unknown>, todayOf(ctx, ws));
  const after: Obligation = { ...before, state: "posted", updatedAt: ctx.now };
  after.creditOverrideReason = await creditCheck(ctx, ws, pt, after, text(p.creditOverrideReason, 300));
  await put(ctx, "obligations", after);
  await audit(ctx, { workspaceId: ws.id, action: "obligation.post", entityType: "obligation", entityId: before.id, before, after });
  return { obligationId: before.id };
};

async function voidInternal(ctx: Ctx, ob: Obligation, reason: string) {
  check(ob.state !== "voided", "already_voided");
  const allocations = (await ctx.tx.where("allocations", "obligationId", ob.id)).filter((a) => !a.reversedAt);
  check(!allocations.length, "void_has_payments", { count: allocations.length });
  const netting = (await ctx.tx.where("adjustments", "obligationId", ob.id)).filter((a) => !a.reversedAt && a.type === "netting");
  check(!netting.length, "void_has_netting");
  const after: Obligation = { ...ob, state: "voided", voidedAt: ctx.now, voidReason: reason, updatedAt: ctx.now };
  await put(ctx, "obligations", after);
  for (const plan of await ctx.tx.where("installmentPlans", "obligationId", ob.id))
    if (plan.state === "active") await put(ctx, "installmentPlans", { ...plan, state: "cancelled" });
  await audit(ctx, { workspaceId: ob.workspaceId, action: "obligation.void", entityType: "obligation", entityId: ob.id, reason, before: ob, after });
  return after;
}

handlers.voidObligation = async (ctx, p) => {
  const ob = await obligation(ctx, p.obligationId);
  await workspace(ctx, ob.workspaceId);
  const reason = required(p.reason, 300, "reason_required");
  await voidInternal(ctx, ob, reason);
  if (ob.invoiceId) {
    const inv = await ctx.tx.get("invoices", ob.invoiceId);
    if (inv && inv.state === "posted") await put(ctx, "invoices", { ...inv, state: "voided", voidedAt: ctx.now });
  }
  return { obligationId: ob.id };
};

handlers.replaceObligation = async (ctx, p) => {
  const old = await obligation(ctx, p.obligationId);
  const ws = await workspace(ctx, old.workspaceId);
  check(old.state === "posted", "not_posted");
  check(!old.invoiceId, "use_invoice_void");
  const reason = required(p.reason, 300, "reason_required");
  const changes = (p.changes ?? {}) as Record<string, unknown>;
  const fields = obligationFields({ ...old, ...changes } as unknown as Record<string, unknown>, todayOf(ctx, ws));
  await voidInternal(ctx, old, reason);
  const next: Obligation = {
    ...old,
    ...fields,
    id: `obl_${ctx.commandId}`,
    state: "posted",
    voidedAt: null,
    voidReason: null,
    replacesId: old.id,
    replacedById: null,
    createdAt: ctx.now,
    createdBy: ctx.actor,
    updatedAt: undefined,
  };
  await add(ctx, "obligations", next);
  await put(ctx, "obligations", { ...(await obligation(ctx, old.id)), replacedById: next.id });
  await audit(ctx, { workspaceId: ws.id, action: "obligation.replace", entityType: "obligation", entityId: next.id, reason, before: old, after: next });
  return { obligationId: next.id, replacedId: old.id };
};

handlers.adjustObligation = async (ctx, p) => {
  const ob = await obligation(ctx, p.obligationId);
  const ws = await workspace(ctx, ob.workspaceId);
  check(ob.state === "posted", "not_posted");
  const type = oneOf(p.type, ["increase", "decrease", "waiver", "write_off"] as const, "invalid_adjustment") as AdjustmentType;
  const amount = positive(p.amount);
  const today = todayOf(ctx, ws);
  const date = isoDate(p.date ?? today);
  check(date <= today, "future_date");
  check(date >= ob.date, "adjustment_before_debt");
  const reason = required(p.reason, 300, "reason_required");
  const l = await partyLedger(ctx, ob.partyId);
  const f = figures(l, ob);
  if (type !== "increase") check(amount <= f.outstanding, "adjustment_exceeds_outstanding", { outstanding: f.outstanding });
  const adj: Adjustment = {
    id: `adj_${ctx.commandId}`,
    workspaceId: ws.id,
    obligationId: ob.id,
    partyId: ob.partyId,
    type,
    amount,
    date,
    reason,
    nettingId: null,
    reversedAt: null,
    createdAt: ctx.now,
    createdBy: ctx.actor,
  };
  await add(ctx, "adjustments", adj);
  await audit(ctx, { workspaceId: ws.id, action: `adjustment.${type}`, entityType: "adjustment", entityId: adj.id, reason, after: adj });
  return { adjustmentId: adj.id };
};

handlers.reverseAdjustment = async (ctx, p) => {
  const adj = await ctx.tx.get("adjustments", idOf(p.adjustmentId));
  check(adj && !adj.reversedAt, "adjustment_not_found");
  await workspace(ctx, adj.workspaceId);
  const reason = required(p.reason, 300, "reason_required");
  const group = adj.nettingId
    ? (await ctx.tx.where("adjustments", "partyId", adj.partyId)).filter((a) => a.nettingId === adj.nettingId && !a.reversedAt)
    : [adj];
  const l = await partyLedger(ctx, adj.partyId);
  for (const a of group) {
    if (a.type === "increase") {
      const ob = l.obligations.find((o) => o.id === a.obligationId);
      check(ob && figures(l, ob).outstanding >= a.amount, "reversal_would_go_negative");
    }
    await put(ctx, "adjustments", { ...a, reversedAt: ctx.now, reversalReason: reason });
    await audit(ctx, { workspaceId: a.workspaceId, action: "adjustment.reverse", entityType: "adjustment", entityId: a.id, reason });
  }
  return { reversed: group.map((a) => a.id) };
};

handlers.netBalances = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId);
  const currency = currencyOf(p.currency);
  const amount = positive(p.amount);
  const today = todayOf(ctx, ws);
  const date = isoDate(p.date ?? today);
  check(date <= today, "future_date");
  const reason = required(p.reason, 300, "reason_required");
  const l = await partyLedger(ctx, pt.id);
  // A disputed debt is never offset: the client contests it, so it cannot settle what we owe them.
  const rec = openOf(l, "receivable", currency).filter((x) => !x.obligation.disputed);
  const pay = openOf(l, "payable", currency).filter((x) => !x.obligation.disputed);
  const maxNet = Math.min(rec.reduce((n, x) => n + x.outstanding, 0), pay.reduce((n, x) => n + x.outstanding, 0));
  check(amount <= maxNet, "netting_exceeds", { max: maxNet });
  const nettingId = `net_${ctx.commandId}`;
  let n = 0;
  for (const side of [rec, pay]) {
    for (const line of planAllocation(side, amount).lines) {
      const adj: Adjustment = {
        id: `adj_${ctx.commandId}_${++n}`,
        workspaceId: ws.id,
        obligationId: line.obligationId,
        partyId: pt.id,
        type: "netting",
        amount: line.amount,
        date,
        reason,
        nettingId,
        reversedAt: null,
        createdAt: ctx.now,
        createdBy: ctx.actor,
      };
      await add(ctx, "adjustments", adj);
    }
  }
  await audit(ctx, { workspaceId: ws.id, action: "netting.create", entityType: "netting", entityId: nettingId, reason, after: { partyId: pt.id, currency, amount } });
  return { nettingId };
};

handlers.setDispute = async (ctx, p) => {
  const ob = await obligation(ctx, p.obligationId);
  await workspace(ctx, ob.workspaceId);
  const disputed = bool(p.disputed);
  const after: Obligation = { ...ob, disputed: disputed ? { since: ctx.now, note: text(p.note, 500) } : null, updatedAt: ctx.now };
  await put(ctx, "obligations", after);
  await audit(ctx, { workspaceId: ob.workspaceId, action: disputed ? "obligation.dispute" : "obligation.undispute", entityType: "obligation", entityId: ob.id, reason: text(p.note, 500) || null });
  return { obligationId: ob.id };
};

handlers.setObligationDates = async (ctx, p) => {
  // Due/reminder dates are scheduling data, not amounts; changes are audited.
  const ob = await obligation(ctx, p.obligationId);
  await workspace(ctx, ob.workspaceId);
  check(ob.state !== "voided", "already_voided");
  const dueDate = p.dueDate !== undefined ? optDate(p.dueDate) : ob.dueDate ?? null;
  if (dueDate) check(dueDate >= ob.date, "due_before_date");
  const remindOn = p.remindOn !== undefined ? optDate(p.remindOn) : ob.remindOn ?? null;
  const after: Obligation = { ...ob, dueDate, remindOn, updatedAt: ctx.now };
  await put(ctx, "obligations", after);
  await audit(ctx, { workspaceId: ob.workspaceId, action: "obligation.reschedule", entityType: "obligation", entityId: ob.id, before: { dueDate: ob.dueDate, remindOn: ob.remindOn }, after: { dueDate, remindOn }, reason: text(p.reason, 300) || null });
  return { obligationId: ob.id };
};

handlers.recordPayment = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId);
  const direction = oneOf(p.direction, DIRECTIONS, "invalid_direction");
  const currency = currencyOf(p.currency);
  const amount = positive(p.amount);
  const today = todayOf(ctx, ws);
  const date = isoDate(p.date ?? today);
  check(date <= today, "future_date");
  const method = oneOf(p.method ?? "cash", METHODS, "invalid_method") as PaymentMethod;
  const allowAdvance = bool(p.allowAdvance);
  const l = await partyLedger(ctx, pt.id);
  const open = openOf(l, direction, currency);
  const lines = p.allocations === undefined || p.allocations === null || p.allocations === "auto" ? planAllocation(open, amount).lines : validateLines(p.allocations, open);
  const allocated = lines.reduce((n, x) => n + x.amount, 0);
  check(allocated <= amount, "allocations_exceed_payment");
  const unallocated = amount - allocated;
  if (unallocated > 0 && !allowAdvance)
    fail("overpayment", { outstanding: open.reduce((n, x) => n + x.outstanding, 0), excess: unallocated });
  let receiptNumber: string | null = null;
  if (ws.mode === "business") {
    receiptNumber = `${ws.settings.receipts.prefix}${String(ws.settings.receipts.nextNumber).padStart(5, "0")}`;
    await put(ctx, "workspaces", { ...ws, settings: { ...ws.settings, receipts: { ...ws.settings.receipts, nextNumber: ws.settings.receipts.nextNumber + 1 } } });
  }
  const payment: Payment = {
    id: p.paymentId ? idOf(p.paymentId) : `pay_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    direction,
    currency,
    amount,
    date,
    method,
    methodLabel: text(p.methodLabel, 60),
    reference: text(p.reference, 120),
    note: text(p.note, 1000),
    allowAdvance,
    state: "posted",
    reversedAt: null,
    reversalReason: null,
    receiptNumber,
    attachmentIds: Array.isArray(p.attachmentIds) ? p.attachmentIds.map((a) => idOf(a)) : [],
    createdAt: ctx.now,
    createdBy: ctx.actor,
  };
  await add(ctx, "payments", payment);
  let i = 0;
  for (const line of lines) {
    await add(ctx, "allocations", {
      id: `alc_${payment.id}_${++i}`,
      workspaceId: ws.id,
      paymentId: payment.id,
      obligationId: line.obligationId,
      partyId: pt.id,
      amount: line.amount,
      date,
      reversedAt: null,
      createdAt: ctx.now,
    });
  }
  await audit(ctx, { workspaceId: ws.id, action: "payment.post", entityType: "payment", entityId: payment.id, after: { payment, allocations: lines } });
  return { paymentId: payment.id, allocations: lines, unallocated, receiptNumber };
};

handlers.applyAdvance = async (ctx, p) => {
  const pay = await ctx.tx.get("payments", idOf(p.paymentId));
  check(pay && pay.state === "posted", "payment_not_found");
  const ws = await workspace(ctx, pay.workspaceId);
  const today = todayOf(ctx, ws);
  const date = isoDate(p.date ?? today);
  check(date <= today && date >= pay.date, "invalid_date");
  const l = await partyLedger(ctx, pay.partyId);
  const { unallocated } = paymentFigures(pay, l.allocations);
  check(unallocated > 0, "no_advance");
  const open = openOf(l, pay.direction, pay.currency);
  const lines = p.allocations && p.allocations !== "auto" ? validateLines(p.allocations, open) : planAllocation(open, unallocated).lines;
  const total = lines.reduce((n, x) => n + x.amount, 0);
  check(total > 0, "nothing_to_apply");
  check(total <= unallocated, "allocations_exceed_payment");
  const existing = l.allocations.filter((a) => a.paymentId === pay.id).length;
  let i = existing;
  for (const line of lines)
    await add(ctx, "allocations", {
      id: `alc_${pay.id}_${++i}`,
      workspaceId: ws.id,
      paymentId: pay.id,
      obligationId: line.obligationId,
      partyId: pay.partyId,
      amount: line.amount,
      date,
      reversedAt: null,
      createdAt: ctx.now,
    });
  await audit(ctx, { workspaceId: ws.id, action: "payment.apply_advance", entityType: "payment", entityId: pay.id, after: { lines, date } });
  return { paymentId: pay.id, allocations: lines };
};

handlers.reversePayment = async (ctx, p) => {
  const pay = await ctx.tx.get("payments", idOf(p.paymentId));
  check(pay, "payment_not_found");
  check(pay.state === "posted", "already_reversed");
  await workspace(ctx, pay.workspaceId);
  const reason = required(p.reason, 300, "reason_required");
  const after: Payment = { ...pay, state: "reversed", reversedAt: ctx.now, reversalReason: reason };
  await put(ctx, "payments", after);
  const allocations = (await ctx.tx.where("allocations", "paymentId", pay.id)).filter((a) => !a.reversedAt);
  for (const a of allocations) await put(ctx, "allocations", { ...a, reversedAt: ctx.now });
  await audit(ctx, { workspaceId: pay.workspaceId, action: "payment.reverse", entityType: "payment", entityId: pay.id, reason, before: pay, after: { reversedAllocations: allocations.map((a) => a.id) } });
  return { paymentId: pay.id, restored: allocations.map((a) => ({ obligationId: a.obligationId, amount: a.amount })) };
};

handlers.createInstallmentPlan = async (ctx, p) => {
  const ob = await obligation(ctx, p.obligationId);
  await workspace(ctx, ob.workspaceId);
  check(ob.state === "posted", "not_posted");
  const l = await partyLedger(ctx, ob.partyId);
  const f = figures(l, ob);
  check(f.outstanding > 0, "nothing_outstanding");
  const plans = await ctx.tx.where("installmentPlans", "obligationId", ob.id);
  const active = plans.find((x) => x.state === "active");
  const plan = await createInstallments(ctx, ob, p, f.outstanding, f.settled, active);
  return { installmentPlanId: plan.id };
};

handlers.cancelInstallmentPlan = async (ctx, p) => {
  const plan = await ctx.tx.get("installmentPlans", idOf(p.planId));
  check(plan && plan.state === "active", "plan_not_found");
  await put(ctx, "installmentPlans", { ...plan, state: "cancelled" });
  await audit(ctx, { workspaceId: plan.workspaceId, action: "installments.cancel", entityType: "installmentPlan", entityId: plan.id, reason: text(p.reason, 300) || null });
  return { installmentPlanId: plan.id };
};

handlers.createRecurringPlan = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId, { allowArchived: false });
  const startDate = isoDate(p.startDate);
  const endDate = optDate(p.endDate);
  if (endDate) check(endDate >= startDate, "invalid_date");
  const plan: RecurringPlan = {
    id: `rcp_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    direction: oneOf(p.direction, DIRECTIONS, "invalid_direction"),
    currency: currencyOf(p.currency),
    amount: positive(p.amount),
    description: required(p.description, 300, "description_required"),
    frequency: oneOf(p.frequency, ["monthly", "weekly"] as const, "invalid_frequency"),
    startDate,
    endDate,
    dueAfterDays: Number.isInteger(p.dueAfterDays) ? Math.max(0, Math.min(365, p.dueAfterDays as number)) : 0,
    pauses: [],
    state: "active",
    endedAt: null,
    createdAt: ctx.now,
  };
  await add(ctx, "recurringPlans", plan);
  await audit(ctx, { workspaceId: ws.id, action: "recurring.create", entityType: "recurringPlan", entityId: plan.id, after: plan });
  return { recurringPlanId: plan.id };
};

handlers.updateRecurringPlan = async (ctx, p) => {
  const plan = await ctx.tx.get("recurringPlans", idOf(p.planId));
  check(plan && plan.state === "active", "plan_not_found");
  const ws = await workspace(ctx, plan.workspaceId);
  const today = todayOf(ctx, ws);
  const action = oneOf(p.action, ["pause", "resume", "end"] as const, "invalid_action");
  const date = isoDate(p.date ?? today);
  let next: RecurringPlan = plan;
  if (action === "pause") {
    check(!plan.pauses.some((x) => !x.to), "already_paused");
    next = { ...plan, pauses: [...plan.pauses, { from: date, to: null }] };
  } else if (action === "resume") {
    const open = plan.pauses.findIndex((x) => !x.to);
    check(open >= 0, "not_paused");
    check(date >= plan.pauses[open].from, "invalid_date");
    next = { ...plan, pauses: plan.pauses.map((x, i) => (i === open ? { ...x, to: date } : x)) };
  } else {
    next = { ...plan, state: "ended", endDate: plan.endDate && plan.endDate < date ? plan.endDate : date, endedAt: ctx.now };
  }
  await put(ctx, "recurringPlans", next);
  await audit(ctx, { workspaceId: ws.id, action: `recurring.${action}`, entityType: "recurringPlan", entityId: plan.id, before: plan, after: next });
  return { recurringPlanId: plan.id };
};

handlers.generateRecurring = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const today = todayOf(ctx, ws);
  const plans = await ctx.tx.where("recurringPlans", "workspaceId", ws.id);
  const created: string[] = [];
  for (const plan of plans) {
    const pt = await ctx.tx.get("parties", plan.partyId);
    if (!pt || pt.mergedIntoId) continue;
    for (const occ of occurrencesUntil(plan, today)) {
      if (await ctx.tx.get("obligations", occ.obligationId)) continue;
      const ob: Obligation = {
        id: occ.obligationId,
        workspaceId: ws.id,
        partyId: plan.partyId,
        direction: plan.direction,
        kind: "recurring",
        currency: plan.currency,
        principal: plan.amount,
        date: occ.date,
        dueDate: addDays(occ.date, plan.dueAfterDays),
        remindOn: null,
        description: plan.description,
        reference: occ.periodKey,
        tags: [],
        state: "posted",
        recurringPlanId: plan.id,
        periodKey: occ.periodKey,
        attachmentIds: [],
        createdAt: ctx.now,
        createdBy: "recurrence",
      };
      await add(ctx, "obligations", ob);
      created.push(ob.id);
    }
  }
  if (created.length) await audit(ctx, { workspaceId: ws.id, action: "recurring.generate", entityType: "workspace", entityId: ws.id, after: { created } });
  return { created };
};

handlers.createPromise = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId);
  const today = todayOf(ctx, ws);
  const promisedDate = isoDate(p.promisedDate);
  check(promisedDate >= today, "promise_in_past");
  const promise: PromiseToPay = {
    id: `prm_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    obligationId: p.obligationId ? idOf(p.obligationId) : null,
    currency: currencyOf(p.currency),
    amount: positive(p.amount),
    promisedDate,
    note: text(p.note, 500),
    madeOn: today,
    cancelledAt: null,
    createdAt: ctx.now,
  };
  await add(ctx, "promises", promise);
  await audit(ctx, { workspaceId: ws.id, action: "promise.create", entityType: "promise", entityId: promise.id, after: promise });
  return { promiseId: promise.id };
};

handlers.cancelPromise = async (ctx, p) => {
  const promise = await ctx.tx.get("promises", idOf(p.promiseId));
  check(promise && !promise.cancelledAt, "promise_not_found");
  await put(ctx, "promises", { ...promise, cancelledAt: ctx.now });
  await audit(ctx, { workspaceId: promise.workspaceId, action: "promise.cancel", entityType: "promise", entityId: promise.id });
  return { promiseId: promise.id };
};

const SETTABLE_REMINDER: ReminderStatus[] = ["prepared", "opened_for_sharing", "marked_sent", "failed"];

handlers.logReminder = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId);
  const channel = oneOf(p.channel, ["whatsapp", "sms", "email", "copy", "local_notification"] as const, "invalid_channel") as ReminderChannel;
  const status = oneOf(p.status ?? "prepared", SETTABLE_REMINDER, "no_provider_evidence");
  // Revalidate what is owed right now; the message must not claim a stale amount.
  const l = await partyLedger(ctx, pt.id);
  const byCurrency = new Map<string, number>();
  for (const o of l.obligations) {
    if (o.state !== "posted" || o.direction !== "receivable") continue;
    const out = figures(l, o).outstanding;
    if (out > 0) byCurrency.set(o.currency, (byCurrency.get(o.currency) ?? 0) + out);
  }
  check(byCurrency.size > 0, "nothing_due");
  const expected = p.expectedAmounts as { currency: string; amount: number }[] | undefined;
  if (expected) {
    for (const e of expected) check(byCurrency.get(e.currency) === e.amount, "balance_changed", { currency: e.currency, now: byCurrency.get(e.currency) ?? 0 });
  }
  const log: ReminderLog = {
    id: `rem_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    channel,
    language: oneOf(p.language ?? "ar", ["ar", "fr", "en"] as const, "invalid_language"),
    message: required(p.message, 1500, "message_required"),
    amounts: [...byCurrency].map(([currency, amount]) => ({ currency, amount })),
    status,
    history: [{ status, at: ctx.now }],
    createdAt: ctx.now,
  };
  await add(ctx, "reminders", log);
  return { reminderId: log.id, amounts: log.amounts };
};

handlers.updateReminderStatus = async (ctx, p) => {
  const log = await ctx.tx.get("reminders", idOf(p.reminderId));
  check(log, "reminder_not_found");
  const status = oneOf(p.status, SETTABLE_REMINDER, "no_provider_evidence");
  const next: ReminderLog = { ...log, status, history: [...log.history, { status, at: ctx.now }] };
  await put(ctx, "reminders", next);
  return { reminderId: log.id };
};

function invoiceLines(v: unknown): InvoiceLine[] {
  check(Array.isArray(v), "invoice_lines");
  return v.map((raw) => {
    const l = raw as Record<string, unknown>;
    return {
      description: required(l.description, 300, "line_description"),
      quantityMilli: l.quantityMilli as number,
      unitPrice: l.unitPrice as number,
      discountBps: (l.discountBps as number) ?? 0,
      taxBps: (l.taxBps as number) ?? 0,
    };
  });
}

handlers.saveInvoiceDraft = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const pt = await party(ctx, ws, p.partyId, { allowArchived: false });
  const existing = p.invoiceId ? await ctx.tx.get("invoices", idOf(p.invoiceId)) : undefined;
  if (existing) check(existing.state === "draft" && existing.workspaceId === ws.id, "not_draft");
  const lines = invoiceLines(p.lines);
  const allowedTax = new Set([0, ...ws.settings.invoices.taxRates.map((t) => t.bps)]);
  check(lines.every((l) => allowedTax.has(l.taxBps)), "tax_not_configured");
  const date = isoDate(p.date ?? todayOf(ctx, ws));
  const dueDate = optDate(p.dueDate);
  if (dueDate) check(dueDate >= date, "due_before_date");
  const inv: Invoice = {
    id: existing?.id ?? `inv_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    number: existing?.number ?? "",
    date,
    dueDate,
    currency: currencyOf(p.currency ?? ws.defaultCurrency),
    lines,
    notes: text(p.notes, 1000),
    state: "draft",
    obligationId: null,
    totals: invoiceTotals(lines),
    createdAt: existing?.createdAt ?? ctx.now,
  };
  await put(ctx, "invoices", inv);
  await audit(ctx, { workspaceId: ws.id, action: "invoice.draft", entityType: "invoice", entityId: inv.id, before: existing ?? null, after: inv });
  return { invoiceId: inv.id, totals: inv.totals };
};

handlers.postInvoice = async (ctx, p) => {
  const inv = await ctx.tx.get("invoices", idOf(p.invoiceId));
  check(inv && inv.state === "draft", "not_draft");
  const ws = await workspace(ctx, inv.workspaceId);
  const pt = await party(ctx, ws, inv.partyId, { allowArchived: false });
  const today = todayOf(ctx, ws);
  check(inv.date <= today, "future_date");
  const totals = invoiceTotals(inv.lines);
  const number = `${ws.settings.invoices.prefix}${String(ws.settings.invoices.nextNumber).padStart(5, "0")}`;
  await put(ctx, "workspaces", { ...ws, settings: { ...ws.settings, invoices: { ...ws.settings.invoices, nextNumber: ws.settings.invoices.nextNumber + 1 } } });
  const ob: Obligation = {
    id: `obl_${ctx.commandId}`,
    workspaceId: ws.id,
    partyId: pt.id,
    direction: "receivable",
    kind: "invoice",
    currency: inv.currency,
    principal: totals.total,
    date: inv.date,
    dueDate: inv.dueDate ?? null,
    remindOn: null,
    description: number,
    reference: number,
    tags: [],
    state: "posted",
    invoiceId: inv.id,
    attachmentIds: [],
    createdAt: ctx.now,
    createdBy: ctx.actor,
  };
  ob.creditOverrideReason = await creditCheck(ctx, ws, pt, ob, text(p.creditOverrideReason, 300));
  await add(ctx, "obligations", ob);
  const posted: Invoice = { ...inv, number, totals, state: "posted", obligationId: ob.id, postedAt: ctx.now };
  await put(ctx, "invoices", posted);
  await audit(ctx, { workspaceId: ws.id, action: "invoice.post", entityType: "invoice", entityId: inv.id, after: { invoice: posted, obligationId: ob.id } });
  return { invoiceId: inv.id, number, obligationId: ob.id };
};

handlers.voidInvoice = async (ctx, p) => {
  const inv = await ctx.tx.get("invoices", idOf(p.invoiceId));
  check(inv && inv.state !== "voided", "invoice_not_found");
  await workspace(ctx, inv.workspaceId);
  const reason = required(p.reason, 300, "reason_required");
  if (inv.obligationId) await voidInternal(ctx, await obligation(ctx, inv.obligationId), reason);
  await put(ctx, "invoices", { ...inv, state: "voided", voidedAt: ctx.now });
  await audit(ctx, { workspaceId: inv.workspaceId, action: "invoice.void", entityType: "invoice", entityId: inv.id, reason });
  return { invoiceId: inv.id };
};

handlers.addNote = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const note = { id: `note_${ctx.commandId}`, workspaceId: ws.id, text: required(p.text, 2000, "text_required"), convertedTo: null, archivedAt: null, createdAt: ctx.now };
  await add(ctx, "notes", note);
  return { noteId: note.id };
};

handlers.updateNote = async (ctx, p) => {
  const note = await ctx.tx.get("notes", idOf(p.noteId));
  check(note, "note_not_found");
  const next = { ...note };
  if (p.archived !== undefined) next.archivedAt = bool(p.archived) ? ctx.now : null;
  if (p.convertedTo) {
    const c = p.convertedTo as { type: "obligation" | "payment"; id: string };
    next.convertedTo = { type: oneOf(c.type, ["obligation", "payment"] as const, "invalid_type"), id: idOf(c.id) };
    next.archivedAt = ctx.now;
  }
  if (p.text !== undefined) next.text = required(p.text, 2000, "text_required");
  await put(ctx, "notes", next);
  return { noteId: note.id };
};

handlers.addAttachment = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const ownerType = oneOf(p.ownerType, ["obligation", "payment", "party", "invoice"] as const, "invalid_owner");
  const storeFor = { obligation: "obligations", payment: "payments", party: "parties", invoice: "invoices" } as const;
  const ownerStore = storeFor[ownerType];
  const owner = (await ctx.tx.get(ownerStore, idOf(p.ownerId))) as { id: string; workspaceId: string; attachmentIds?: string[] } | undefined;
  check(owner && owner.workspaceId === ws.id, "owner_not_found");
  const data = p.data;
  check(typeof data === "string" && /^[A-Za-z0-9+/=]*$/.test(data), "invalid_attachment");
  const size = Math.floor((data.length * 3) / 4);
  check(size <= 5 * 1024 * 1024, "attachment_too_large");
  const att = {
    id: `att_${ctx.commandId}`,
    workspaceId: ws.id,
    ownerType,
    ownerId: owner.id,
    name: required(p.name, 200, "name_required"),
    mime: text(p.mime, 100) || "application/octet-stream",
    size,
    sha256: required(p.sha256, 64, "invalid_attachment"),
    data,
    createdAt: ctx.now,
  };
  await add(ctx, "attachments", att);
  if ("attachmentIds" in owner) await put(ctx, ownerStore, { ...owner, attachmentIds: [...(owner.attachmentIds ?? []), att.id] } as never);
  await audit(ctx, { workspaceId: ws.id, action: "attachment.add", entityType: ownerType, entityId: owner.id, after: { attachmentId: att.id, name: att.name, size } });
  return { attachmentId: att.id };
};

handlers.removeAttachment = async (ctx, p) => {
  const att = await ctx.tx.get("attachments", idOf(p.attachmentId));
  check(att, "attachment_not_found");
  await ctx.tx.delete("attachments", att.id);
  ctx.writes.push({ store: "attachments", value: { id: att.id }, deleted: true });
  await audit(ctx, { workspaceId: att.workspaceId, action: "attachment.remove", entityType: att.ownerType, entityId: att.ownerId, reason: text(p.reason, 300) || null, before: { id: att.id, name: att.name, sha256: att.sha256 } });
  return { attachmentId: att.id };
};

// ---------------------------------------------------------------- imports (CSV, legacy clinic)

export type ImportRecords = {
  parties: Party[];
  obligations: Obligation[];
  payments: Payment[];
  allocations: Allocation[];
  reminders?: ReminderLog[];
};

handlers.commitImport = async (ctx, p) => {
  const ws = await workspace(ctx, p.workspaceId);
  const source = oneOf(p.source, ["csv", "agrovet", "backup_merge"] as const, "invalid_source");
  const fileHash = required(p.fileHash, 128, "invalid_import");
  const batches = await ctx.tx.where("importBatches", "workspaceId", ws.id);
  if (!bool(p.allowReplay)) check(!batches.some((b) => b.fileHash === fileHash && b.state === "committed"), "already_imported");
  const records = p.records as ImportRecords;
  const batchId = `imp_${ctx.commandId}`;
  const created: ImportBatch["created"] = [];
  const today = todayOf(ctx, ws);
  const own = <T extends { workspaceId: string }>(r: T) => check(r.workspaceId === ws.id, "workspace_mismatch");
  for (const party of records.parties ?? []) {
    own(party);
    required(party.displayName, 120, "name_required");
    await add(ctx, "parties", { ...party, importBatchId: batchId });
    created.push({ store: "parties", id: party.id });
  }
  for (const ob of records.obligations ?? []) {
    own(ob);
    check(DIRECTIONS.includes(ob.direction) && isCurrency(ob.currency) && isPositiveMinor(ob.principal) && isISODate(ob.date) && ob.date <= today, "invalid_import_row", { id: ob.id });
    const pt = await ctx.tx.get("parties", ob.partyId);
    check(pt && pt.workspaceId === ws.id, "party_not_found", { id: ob.id });
    await add(ctx, "obligations", { ...ob, importBatchId: batchId });
    created.push({ store: "obligations", id: ob.id });
  }
  for (const pay of records.payments ?? []) {
    own(pay);
    const payParty = await ctx.tx.get("parties", pay.partyId);
    check(payParty && payParty.workspaceId === ws.id, "party_not_found", { id: pay.id });
    check(DIRECTIONS.includes(pay.direction) && isCurrency(pay.currency) && isPositiveMinor(pay.amount) && isISODate(pay.date) && pay.date <= today, "invalid_import_row", { id: pay.id });
    await add(ctx, "payments", { ...pay, importBatchId: batchId });
    created.push({ store: "payments", id: pay.id });
  }
  for (const a of records.allocations ?? []) {
    own(a);
    await add(ctx, "allocations", a);
    created.push({ store: "allocations", id: a.id });
  }
  for (const r of records.reminders ?? []) {
    own(r);
    const pt = await ctx.tx.get("parties", r.partyId);
    check(pt && pt.workspaceId === ws.id, "party_not_found", { id: r.id });
    await add(ctx, "reminders", r);
    created.push({ store: "reminders", id: r.id });
  }
  // Re-verify every invariant on the affected parties with the same ledger logic.
  const partyIds = new Set([
    ...(records.obligations ?? []).map((o) => o.partyId),
    ...(records.payments ?? []).map((x) => x.partyId),
    ...(records.allocations ?? []).map((x) => x.partyId),
  ]);
  for (const partyId of partyIds) {
    const l = await partyLedger(ctx, partyId);
    for (const ob of l.obligations) check(figures(l, ob).outstanding >= 0, "import_overallocated", { obligationId: ob.id });
    for (const pay of l.payments) {
      const f = paymentFigures(pay, l.allocations);
      check(f.unallocated >= 0, "import_overallocated", { paymentId: pay.id });
      // Same rule as recordPayment: an unallocated remainder must be an explicit advance.
      check(f.unallocated === 0 || pay.allowAdvance || pay.state !== "posted", "import_unallocated", { paymentId: pay.id });
    }
    for (const a of l.allocations.filter((x) => !x.reversedAt)) {
      const ob = l.obligations.find((o) => o.id === a.obligationId);
      const pay = l.payments.find((x) => x.id === a.paymentId);
      check(ob && pay && ob.direction === pay.direction && ob.currency === pay.currency && ob.state === "posted", "import_allocation_incompatible", { allocationId: a.id });
    }
  }
  const counts = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, (v as unknown[] | undefined)?.length ?? 0]));
  const batch: ImportBatch = {
    id: batchId,
    workspaceId: ws.id,
    source,
    fileName: text(p.fileName, 200),
    fileHash,
    created,
    counts,
    state: "committed",
    report: p.report ?? null,
    createdAt: ctx.now,
  };
  await add(ctx, "importBatches", batch);
  await audit(ctx, { workspaceId: ws.id, action: "import.commit", entityType: "importBatch", entityId: batchId, after: { source, fileHash, counts } });
  return { batchId, counts };
};

handlers.reverseImport = async (ctx, p) => {
  const batch = await ctx.tx.get("importBatches", idOf(p.batchId));
  check(batch && batch.state === "committed", "batch_not_found");
  await workspace(ctx, batch.workspaceId);
  const reason = required(p.reason, 300, "reason_required");
  const mine = new Set(batch.created.map((c) => c.id));
  const obligationIds = batch.created.filter((c) => c.store === "obligations").map((c) => c.id);
  // Refuse when payments outside this batch were allocated to imported debts.
  for (const id of obligationIds) {
    const foreign = (await ctx.tx.where("allocations", "obligationId", id)).filter((a) => !a.reversedAt && !mine.has(a.paymentId));
    check(!foreign.length, "import_in_use", { obligationId: id });
  }
  for (const c of batch.created.filter((c) => c.store === "payments")) {
    const pay = await ctx.tx.get("payments", c.id);
    if (pay && pay.state === "posted") {
      await put(ctx, "payments", { ...pay, state: "reversed", reversedAt: ctx.now, reversalReason: reason });
      for (const a of (await ctx.tx.where("allocations", "paymentId", pay.id)).filter((a) => !a.reversedAt)) await put(ctx, "allocations", { ...a, reversedAt: ctx.now });
    }
  }
  for (const id of obligationIds) {
    const ob = await ctx.tx.get("obligations", id);
    if (ob && ob.state !== "voided") {
      for (const adj of (await ctx.tx.where("adjustments", "obligationId", id)).filter((a) => !a.reversedAt)) await put(ctx, "adjustments", { ...adj, reversedAt: ctx.now, reversalReason: reason });
      await put(ctx, "obligations", { ...ob, state: "voided", voidedAt: ctx.now, voidReason: reason });
    }
  }
  for (const c of batch.created.filter((c) => c.store === "parties")) {
    const pt = await ctx.tx.get("parties", c.id);
    if (!pt) continue;
    const others = (await ctx.tx.where("obligations", "partyId", pt.id)).filter((o) => !mine.has(o.id) && o.state !== "voided");
    if (!others.length) await put(ctx, "parties", { ...pt, archivedAt: ctx.now });
  }
  await put(ctx, "importBatches", { ...batch, state: "reversed", reversedAt: ctx.now, reversalReason: reason });
  await audit(ctx, { workspaceId: batch.workspaceId, action: "import.reverse", entityType: "importBatch", entityId: batch.id, reason });
  return { batchId: batch.id };
};

// ---------------------------------------------------------------- runner

export const COMMAND_TYPES = Object.keys(handlers);

export async function execute<T = Record<string, unknown>>(store: Store, cmd: CommandInput, clock: () => Date = () => new Date()): Promise<CommandOutcome<T>> {
  const commandId = idOf(cmd.id, "invalid_command_id");
  const handler = handlers[cmd.type];
  check(handler, "unknown_command");
  return store.run("readwrite", async (tx) => {
    const done = await tx.get("commands", commandId);
    if (done) {
      check(done.type === cmd.type, "command_id_reused");
      return { result: done.result as T, replayed: true, writes: [] };
    }
    const at = clock();
    const ctx: Ctx = { tx, now: at.toISOString(), clock: at, actor: cmd.actor ?? "owner", commandId, writes: [], seq: 0 };
    const result = await handler(ctx, cmd.payload ?? {});
    await tx.add("commands", { id: commandId, type: cmd.type, at: ctx.now, result });
    return { result: result as T, replayed: false, writes: ctx.writes };
  });
}

/** Sorted helper for UIs and importers. */
export const byAllocationOrder = allocationOrder;
