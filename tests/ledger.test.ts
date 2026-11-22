// Corrections, statements, search, collections and business documents.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStatement, figuresOf, obligationStatus, partyBalance, partyEffects, searchParties } from "../lib/core/ledger.ts";
import { agingReport, dailyActions, inQuietHours, promiseState, reminderQueue } from "../lib/core/collections.ts";
import { defaultSettings } from "../lib/core/commands.ts";
import { installmentProgress } from "../lib/core/installments.ts";
import { invoiceTotals, lineTotals, parseQuantity } from "../lib/core/invoice.ts";
import { periodReport } from "../lib/core/reports.ts";
import { basic, DA, TODAY } from "./helpers.ts";

const rec = (h: { workspaceId: string; partyId: string }, amount: number, extra: Record<string, unknown> = {}) => ({
  workspaceId: h.workspaceId,
  partyId: h.partyId,
  direction: "receivable",
  currency: "DZD",
  principal: DA(amount),
  date: "2026-10-01",
  ...extra,
});
const got = (h: { workspaceId: string; partyId: string }, amount: number, extra: Record<string, unknown> = {}) => ({
  workspaceId: h.workspaceId,
  partyId: h.partyId,
  direction: "receivable",
  currency: "DZD",
  amount: DA(amount),
  date: "2026-11-01",
  ...extra,
});

test("a person needs only a display name; duplicates warn; phones normalize", async () => {
  const h = await basic();
  await assert.rejects(h.run("createParty", { workspaceId: h.workspaceId, displayName: "  " }), /name_required/);
  await assert.rejects(h.run("createParty", { workspaceId: h.workspaceId, displayName: "karim" }), /possible_duplicate/);
  const { partyId } = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Karim", allowDuplicate: true, phones: ["0661 00 00 01"] });
  const idx = await h.index(h.workspaceId);
  assert.deepEqual(idx.party.get(partyId)!.phones, ["+213661000001"]);
  await assert.rejects(h.run("createParty", { workspaceId: h.workspaceId, displayName: "Autre", phones: ["+213661000001"] }), /possible_duplicate/);
});

test("posted amounts are immutable: void needs no payments, replace links both, adjustments need reasons", async () => {
  const h = await basic();
  const a = await h.run("createObligation", rec(h, 1000));
  await h.run("recordPayment", got(h, 100));
  await assert.rejects(h.run("voidObligation", { obligationId: a.obligationId, reason: "x" }), /void_has_payments/);
  await assert.rejects(h.run("adjustObligation", { obligationId: a.obligationId, type: "decrease", amount: DA(901), reason: "x" }), /adjustment_exceeds_outstanding/);
  await assert.rejects(h.run("adjustObligation", { obligationId: a.obligationId, type: "waiver", amount: DA(100) }), /reason_required/);
  await h.run("adjustObligation", { obligationId: a.obligationId, type: "waiver", amount: DA(400), reason: "goodwill", date: "2026-11-02" });
  let idx = await h.index(h.workspaceId);
  let f = figuresOf(idx, idx.obligation.get(a.obligationId)!);
  assert.equal(f.outstanding, DA(500));
  assert.equal(f.waived, DA(400));
  assert.equal(f.paid, DA(100));
  assert.equal(obligationStatus(idx.obligation.get(a.obligationId)!, f), "partly_paid");

  const b = await h.run("createObligation", rec(h, 300, { description: "typo" }));
  const r = await h.run("replaceObligation", { obligationId: b.obligationId, reason: "wrong amount", changes: { principal: DA(350) } });
  idx = await h.index(h.workspaceId);
  assert.equal(idx.obligation.get(b.obligationId)!.state, "voided");
  assert.equal(idx.obligation.get(b.obligationId)!.replacedById, r.obligationId);
  assert.equal(idx.obligation.get(r.obligationId)!.replacesId, b.obligationId);
  f = figuresOf(idx, idx.obligation.get(r.obligationId)!);
  assert.equal(f.outstanding, DA(350));
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(850));
});

test("future dates and due dates before the debt date are rejected", async () => {
  const h = await basic();
  await assert.rejects(h.run("createObligation", rec(h, 10, { date: "2026-11-23" })), /future_date/);
  await assert.rejects(h.run("createObligation", rec(h, 10, { dueDate: "2026-09-01" })), /due_before_date/);
  await assert.rejects(h.run("createObligation", rec(h, 10, { currency: "XXX" })), /invalid_currency/);
  await assert.rejects(h.run("createObligation", rec(h, 10, { principal: 1.5 })), /amount_positive/);
});

test("drafts are excluded from balances until posted", async () => {
  const h = await basic();
  const d = await h.run("createObligation", rec(h, 500, { draft: true }));
  let idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, h.partyId, TODAY).size, 0);
  await h.run("updateDraft", { obligationId: d.obligationId, changes: { principal: DA(600) } });
  await h.run("postDraft", { obligationId: d.obligationId });
  idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(600));
  await assert.rejects(h.run("updateDraft", { obligationId: d.obligationId, changes: { principal: 1 } }), /not_draft/);
});

test("credit limit warns and accepts an explicit, recorded override", async () => {
  const h = await basic();
  await h.run("updateParty", { partyId: h.partyId, changes: { creditLimits: { DZD: DA(1000) } } });
  await h.run("createObligation", rec(h, 800));
  await assert.rejects(h.run("createObligation", rec(h, 300)), /credit_limit/);
  const { obligationId } = await h.run("createObligation", rec(h, 300, { creditOverrideReason: "regular client" }));
  const idx = await h.index(h.workspaceId);
  assert.equal(idx.obligation.get(obligationId)!.creditOverrideReason, "regular client");
});

test("manual allocation preview can be adjusted; oldest due first by default", async () => {
  const h = await basic();
  const old = await h.run("createObligation", rec(h, 100, { date: "2026-09-01", dueDate: "2026-09-10" }));
  const young = await h.run("createObligation", rec(h, 100, { date: "2026-08-01", dueDate: "2026-12-01" }));
  const auto = await h.run("recordPayment", got(h, 150));
  assert.deepEqual(auto.allocations, [
    { obligationId: old.obligationId, amount: DA(100) },
    { obligationId: young.obligationId, amount: DA(50) },
  ]);
  await assert.rejects(h.run("recordPayment", got(h, 60, { allocations: [{ obligationId: young.obligationId, amount: DA(60) }] })), /allocation_exceeds_outstanding/);
  await assert.rejects(h.run("recordPayment", got(h, 40, { allocations: [{ obligationId: young.obligationId, amount: DA(50) }] })), /allocations_exceed_payment/);
  await assert.rejects(h.run("recordPayment", { ...got(h, 10), direction: "payable", allocations: [{ obligationId: young.obligationId, amount: DA(10) }] }), /allocation_incompatible/);
});

test("statement: opening + movements = closing, and closing equals derived outstanding", async () => {
  const h = await basic();
  await h.run("createObligation", rec(h, 1000, { date: "2026-09-15" }));
  await h.run("recordPayment", got(h, 200, { date: "2026-09-20" }));
  const b = await h.run("createObligation", rec(h, 500, { date: "2026-10-10" }));
  await h.run("adjustObligation", { obligationId: b.obligationId, type: "increase", amount: DA(50), reason: "late fee", date: "2026-10-15" });
  await h.run("recordPayment", got(h, 300, { date: "2026-10-20" }));
  await h.run("createObligation", { ...rec(h, 70, { date: "2026-10-05" }), direction: "payable" });
  const idx = await h.index(h.workspaceId);
  const st = buildStatement(idx, h.partyId, "DZD", "2026-10-01", TODAY);
  const r = st.sections.find((s) => s.direction === "receivable")!;
  assert.equal(r.opening, DA(800));
  assert.equal(r.rows.length, 3);
  assert.equal(r.closing, r.opening + r.increases - r.decreases);
  assert.equal(r.closing, partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable);
  assert.equal(st.sections.find((s) => s.direction === "payable")!.closing, DA(70));
  const total = partyEffects(idx, h.partyId).filter((e) => e.direction === "receivable").reduce((n, e) => n + e.delta, 0);
  assert.equal(total, DA(1050));
});

test("search by name, normalized phone, amount, reference; filters by direction and due", async () => {
  const h = await basic();
  const p2 = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Société Benali", kind: "organization", phones: ["0770 11 22 33"] });
  await h.run("createObligation", rec(h, 1250, { reference: "BL-778", dueDate: "2026-10-05" }));
  await h.run("createObligation", { ...rec({ ...h, partyId: p2.partyId }, 90), direction: "payable" });
  const idx = await h.index(h.workspaceId);
  const ids = (q: string, f = {}) => searchParties(idx, q, f, TODAY).map((m) => m.party.id);
  assert.deepEqual(ids("societe"), [p2.partyId]);
  assert.deepEqual(ids("+213770112233"), [p2.partyId]);
  assert.deepEqual(ids("1250"), [h.partyId]);
  assert.deepEqual(ids("bl-778"), [h.partyId]);
  assert.deepEqual(ids("", { direction: "payable" }), [p2.partyId]);
  assert.deepEqual(ids("", { due: "overdue" }), [h.partyId]);
});

test("aging buckets use whole local days; boundaries are inclusive", async () => {
  const h = await basic();
  for (const due of ["2026-11-22", "2026-11-21", "2026-11-15", "2026-11-14", "2026-10-23", "2026-08-01"]) await h.run("createObligation", rec(h, 10, { date: "2026-07-01", dueDate: due }));
  await h.run("createObligation", rec(h, 10));
  const idx = await h.index(h.workspaceId);
  const r = agingReport(idx, TODAY, defaultSettings(), "receivable").get("DZD")!;
  assert.equal(r.notDue.count, 1);
  assert.equal(r.noDueDate.count, 1);
  assert.deepEqual(r.buckets.map((b) => [b.key, b.count]), [["1-7", 2], ["8-30", 2], ["31-60", 0], ["61-90", 0], ["91+", 1]]);
});

test("promises never reduce a debt; kept when paid by the promised date; broken after", async () => {
  const h = await basic();
  await h.run("createObligation", rec(h, 1000, { dueDate: "2026-11-01" }));
  const { promiseId } = await h.run("createPromise", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(400), promisedDate: TODAY });
  let idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(1000));
  const pr = idx.data.promises.find((p) => p.id === promiseId)!;
  assert.equal(promiseState(pr, idx, TODAY).state, "due_today");
  assert.equal(dailyActions(idx, TODAY)[0].kind, "promise_due");
  assert.equal(promiseState(pr, idx, "2026-11-23").state, "broken");
  await h.run("recordPayment", got(h, 400, { date: TODAY }));
  idx = await h.index(h.workspaceId);
  assert.equal(promiseState(pr, idx, "2026-11-23").state, "kept");
});

test("reminder queue: disputes and snoozes pause collection; frequency is capped; statuses are honest", async () => {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", rec(h, 1000, { dueDate: "2026-11-01" }));
  let idx = await h.index(h.workspaceId);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 1);
  await h.run("setDispute", { obligationId, disputed: true, note: "contests amount" });
  idx = await h.index(h.workspaceId);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 0);
  await h.run("setDispute", { obligationId, disputed: false });
  await h.run("snoozeParty", { partyId: h.partyId, until: "2026-11-30" });
  idx = await h.index(h.workspaceId);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 0);
  await h.run("snoozeParty", { partyId: h.partyId, until: null });
  await assert.rejects(
    h.run("logReminder", { workspaceId: h.workspaceId, partyId: h.partyId, channel: "whatsapp", message: "x", expectedAmounts: [{ currency: "DZD", amount: 1 }] }),
    /balance_changed/,
  );
  const { reminderId } = await h.run("logReminder", { workspaceId: h.workspaceId, partyId: h.partyId, channel: "whatsapp", message: "Rappel", status: "opened_for_sharing" });
  await assert.rejects(h.run("updateReminderStatus", { reminderId, status: "delivered" }), /no_provider_evidence/);
  await h.run("updateReminderStatus", { reminderId, status: "marked_sent" });
  idx = await h.index(h.workspaceId);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 0, "reminded today, cap 3 days");
  assert.equal(reminderQueue(idx, "2026-11-25", defaultSettings()).length, 1);
  assert.deepEqual(idx.data.reminders[0].history.map((x) => x.status), ["opened_for_sharing", "marked_sent"]);
});

test("installment progress waterfall: partial, early and missed payments", async () => {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", rec(h, 900, { date: "2026-10-01" }));
  await h.run("recordPayment", got(h, 100, { date: "2026-10-02" }));
  const { installmentPlanId } = await h.run("createInstallmentPlan", { obligationId, frequency: "monthly", count: 4, startDate: "2026-10-31" });
  await h.run("recordPayment", got(h, 250, { date: "2026-11-05" }));
  const idx = await h.index(h.workspaceId);
  const plan = idx.data.installmentPlans.find((p) => p.id === installmentPlanId)!;
  assert.equal(plan.total, DA(800));
  const prog = installmentProgress(plan, figuresOf(idx, idx.obligation.get(obligationId)!).settled, TODAY);
  assert.deepEqual(prog.map((p) => [p.dueDate, p.state, p.remaining]), [
    ["2026-10-31", "paid", 0],
    ["2026-11-30", "partly_paid", DA(150)],
    ["2026-12-31", "upcoming", DA(200)],
    ["2027-01-31", "upcoming", DA(200)],
  ]);
  assert.equal(installmentProgress(plan, figuresOf(idx, idx.obligation.get(obligationId)!).settled, "2026-12-01")[1].state, "missed");
  await assert.rejects(h.run("createInstallmentPlan", { obligationId, frequency: "custom", items: [{ dueDate: "2026-12-01", amount: DA(100) }] }), /installment_sum/);
});

test("merge moves history to the target with preview-able audit and keeps balances", async () => {
  const h = await basic();
  const dup = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Karim B.", phones: ["0550000000"] });
  await h.run("createObligation", rec(h, 100));
  await h.run("createObligation", rec({ ...h, partyId: dup.partyId }, 200));
  await h.run("mergeParties", { sourceId: dup.partyId, targetId: h.partyId, reason: "same person" });
  const idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(300));
  assert.equal(idx.party.get(dup.partyId)!.mergedIntoId, h.partyId);
  assert.ok(idx.party.get(h.partyId)!.phones.includes("+213550000000"));
});

test("invoice line math: quantities in thousandths, discounts and configured taxes, half-up per line", () => {
  assert.equal(parseQuantity("2,5"), 2500);
  assert.equal(parseQuantity("0"), null);
  assert.deepEqual(lineTotals({ description: "x", quantityMilli: 2500, unitPrice: 333, discountBps: 1000, taxBps: 1900 }), { gross: 833, discount: 83, net: 750, tax: 143, total: 893 });
  assert.deepEqual(invoiceTotals([{ description: "a", quantityMilli: 1000, unitPrice: 10000, discountBps: 0, taxBps: 0 }]), { subtotal: 10000, discount: 0, tax: 0, total: 10000 });
});

test("taxes on invoices only when configured", async () => {
  const h = await basic();
  await assert.rejects(
    h.run("saveInvoiceDraft", { workspaceId: h.workspaceId, partyId: h.partyId, lines: [{ description: "x", quantityMilli: 1000, unitPrice: 100, discountBps: 0, taxBps: 1900 }] }),
    /tax_not_configured/,
  );
});

test("reports separate cash, waivers and new debts", async () => {
  const h = await basic();
  const a = await h.run("createObligation", rec(h, 1000, { date: "2026-11-02" }));
  await h.run("recordPayment", got(h, 300, { date: "2026-11-03", method: "ccp_baridimob" }));
  await h.run("adjustObligation", { obligationId: a.obligationId, type: "write_off", amount: DA(100), reason: "uncollectable", date: "2026-11-04" });
  const r = periodReport(await h.index(h.workspaceId), "2026-11-01", TODAY).get("DZD")!;
  assert.equal(r.newReceivables, DA(1000));
  assert.equal(r.cashReceived, DA(300));
  assert.equal(r.receivedByMethod.ccp_baridimob, DA(300));
  assert.equal(r.waivedReceivable, DA(100));
});

test("quiet hours wrap past midnight", () => {
  assert.ok(inQuietHours("22:00", { start: "21:00", end: "08:00" }));
  assert.ok(inQuietHours("07:59", { start: "21:00", end: "08:00" }));
  assert.ok(!inQuietHours("08:00", { start: "21:00", end: "08:00" }));
  assert.ok(inQuietHours("13:00", { start: "12:00", end: "14:00" }));
});

test("storage failure leaves data unchanged and reports the error", async () => {
  const h = await basic();
  (h.store as unknown as { failNextCommit: Error }).failNextCommit = new Error("QuotaExceededError");
  await assert.rejects(h.run("createObligation", rec(h, 10)), /QuotaExceededError/);
  const idx = await h.index(h.workspaceId);
  assert.equal(idx.obligation.size, 0);
});
