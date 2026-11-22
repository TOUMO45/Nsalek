// Minimum financial fixtures A–L from the master prompt (§13).
import test from "node:test";
import assert from "node:assert/strict";
import { figuresOf, netPosition, partyBalance, workspaceTotals } from "../lib/core/ledger.ts";
import { splitAmount } from "../lib/core/installments.ts";
import { overdueList, reminderQueue, dailyActions } from "../lib/core/collections.ts";
import { periodReport } from "../lib/core/reports.ts";
import { defaultSettings } from "../lib/core/commands.ts";
import { basic, DA, harness, nextId, TODAY } from "./helpers.ts";

const debt = (workspaceId: string, partyId: string, direction: string, amount: number, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  partyId,
  direction,
  currency: "DZD",
  principal: DA(amount),
  date: "2026-11-01",
  ...extra,
});
const pay = (workspaceId: string, partyId: string, direction: string, amount: number, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  partyId,
  direction,
  currency: "DZD",
  amount: DA(amount),
  date: "2026-11-10",
  method: "cash",
  ...extra,
});

async function fixtureA() {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 10_000));
  await h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 2_500));
  const second = await h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 1_500));
  return { ...h, obligationId, secondPaymentId: second.paymentId };
}

test("A: receivable 10,000 DZD, repayments 2,500 and 1,500 → 6,000 due", async () => {
  const h = await fixtureA();
  const idx = await h.index(h.workspaceId);
  assert.equal(figuresOf(idx, idx.obligation.get(h.obligationId)!).outstanding, DA(6_000));
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(6_000));
});

test("B: payable 8,000, repayment paid 3,000 → 5,000 owed", async () => {
  const h = await basic();
  await h.run("createObligation", debt(h.workspaceId, h.partyId, "payable", 8_000));
  await h.run("recordPayment", pay(h.workspaceId, h.partyId, "payable", 3_000));
  const b = partyBalance(await h.index(h.workspaceId), h.partyId, TODAY).get("DZD")!;
  assert.equal(b.payable, DA(5_000));
  assert.equal(b.receivable, 0);
});

test("C: same party has A and B → 6,000 receivable and 5,000 payable, optional net 1,000, nothing settled silently", async () => {
  const h = await fixtureA();
  await h.run("createObligation", debt(h.workspaceId, h.partyId, "payable", 8_000));
  await h.run("recordPayment", pay(h.workspaceId, h.partyId, "payable", 3_000));
  const idx = await h.index(h.workspaceId);
  const b = partyBalance(idx, h.partyId, TODAY).get("DZD")!;
  assert.equal(b.receivable, DA(6_000));
  assert.equal(b.payable, DA(5_000));
  assert.equal(netPosition(b), DA(1_000));
  assert.equal(idx.data.adjustments.length, 0, "no netting was recorded");
  const totals = workspaceTotals(idx, TODAY).get("DZD")!;
  assert.equal(totals.receivable, DA(6_000));
  assert.equal(totals.payable, DA(5_000));
});

test("C2: netting is an explicit operation and is reversible", async () => {
  const h = await fixtureA();
  await h.run("createObligation", debt(h.workspaceId, h.partyId, "payable", 5_000));
  await assert.rejects(h.run("netBalances", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(5_001), reason: "x" }), /netting_exceeds/);
  const { nettingId } = await h.run("netBalances", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(5_000), reason: "agreed offset" });
  let b = partyBalance(await h.index(h.workspaceId), h.partyId, TODAY).get("DZD")!;
  assert.equal(b.receivable, DA(1_000));
  assert.equal(b.payable, 0);
  const idx = await h.index(h.workspaceId);
  const one = idx.data.adjustments.find((a) => a.nettingId === nettingId)!;
  await h.run("reverseAdjustment", { adjustmentId: one.id, reason: "mistake" });
  b = partyBalance(await h.index(h.workspaceId), h.partyId, TODAY).get("DZD")!;
  assert.equal(b.receivable, DA(6_000));
  assert.equal(b.payable, DA(5_000));
});

test("D: 10,000 in three installments → 3,333.33 + 3,333.33 + 3,333.34", async () => {
  assert.deepEqual(splitAmount(DA(10_000), 3), [333333, 333333, 333334]);
  const h = await basic();
  const { obligationId } = await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 10_000));
  const { installmentPlanId } = await h.run("createInstallmentPlan", { obligationId, frequency: "monthly", count: 3, startDate: "2026-12-31" });
  const idx = await h.index(h.workspaceId);
  const plan = idx.data.installmentPlans.find((p) => p.id === installmentPlanId)!;
  assert.deepEqual(plan.items.map((i) => i.amount), [333333, 333333, 333334]);
  assert.deepEqual(plan.items.map((i) => i.dueDate), ["2026-12-31", "2027-01-31", "2027-02-28"]);
  assert.equal(plan.items.reduce((n, i) => n + i.amount, 0), DA(10_000));
});

test("E: retrying the same payment command posts exactly once", async () => {
  const h = await basic();
  await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 10_000));
  const id = nextId();
  const first = await h.raw("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 2_500), id);
  const again = await h.raw("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 2_500), id);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.result.paymentId, first.result.paymentId);
  const idx = await h.index(h.workspaceId);
  assert.equal(idx.data.payments.length, 1);
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(7_500));
  await assert.rejects(h.raw("createParty", { workspaceId: h.workspaceId, displayName: "Other" }, id), /command_id_reused/);
});

test("F: reversing the 1,500 payment from A → 7,500 due, history kept", async () => {
  const h = await fixtureA();
  await assert.rejects(h.run("reversePayment", { paymentId: h.secondPaymentId }), /reason_required/);
  await h.run("reversePayment", { paymentId: h.secondPaymentId, reason: "duplicate entry" });
  const idx = await h.index(h.workspaceId);
  assert.equal(figuresOf(idx, idx.obligation.get(h.obligationId)!).outstanding, DA(7_500));
  const reversed = idx.payment.get(h.secondPaymentId)!;
  assert.equal(reversed.state, "reversed");
  assert.equal(idx.data.payments.length, 2);
  assert.ok(idx.data.audit.some((a) => a.action === "payment.reverse" && a.reason === "duplicate entry"));
  await assert.rejects(h.run("reversePayment", { paymentId: h.secondPaymentId, reason: "again" }), /already_reversed/);
});

test("G: paying 7,000 against 6,000 is rejected, or explicitly kept as a 1,000 advance", async () => {
  const h = await fixtureA();
  await assert.rejects(h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 7_000)), /overpayment/);
  const r = await h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 7_000, { allowAdvance: true }));
  assert.equal(r.unallocated, DA(1_000));
  const idx = await h.index(h.workspaceId);
  const b = partyBalance(idx, h.partyId, TODAY).get("DZD")!;
  assert.equal(b.receivable, 0);
  assert.equal(b.advanceReceived, DA(1_000));
  assert.equal(figuresOf(idx, idx.obligation.get(h.obligationId)!).outstanding, 0, "never negative");
  // The advance can later be applied to a new debt.
  const { obligationId } = await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 3_000, { date: TODAY }));
  await h.run("applyAdvance", { paymentId: r.paymentId });
  const idx2 = await h.index(h.workspaceId);
  assert.equal(figuresOf(idx2, idx2.obligation.get(obligationId)!).outstanding, DA(2_000));
  assert.equal(partyBalance(idx2, h.partyId, TODAY).get("DZD")!.advanceReceived, 0);
});

test("H: DZD and EUR balances stay separate and cannot be cross-allocated", async () => {
  const h = await basic();
  const dzd = await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 10_000));
  await h.run("createObligation", { ...debt(h.workspaceId, h.partyId, "receivable", 0), currency: "EUR", principal: 5000 });
  await assert.rejects(
    h.run("recordPayment", { ...pay(h.workspaceId, h.partyId, "receivable", 0), currency: "EUR", amount: 1000, allocations: [{ obligationId: dzd.obligationId, amount: 1000 }] }),
    /allocation_incompatible/,
  );
  await h.run("recordPayment", { ...pay(h.workspaceId, h.partyId, "receivable", 0), currency: "EUR", amount: 1000 });
  const bal = partyBalance(await h.index(h.workspaceId), h.partyId, TODAY);
  assert.equal(bal.get("DZD")!.receivable, DA(10_000));
  assert.equal(bal.get("EUR")!.receivable, 4000);
});

test("I: a past-due debt fully repaid is absent from overdue lists and reminder queues", async () => {
  const h = await basic();
  await h.run("createObligation", debt(h.workspaceId, h.partyId, "receivable", 1_000, { dueDate: "2026-11-05" }));
  let idx = await h.index(h.workspaceId);
  assert.equal(overdueList(idx, TODAY).length, 1);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 1);
  await h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 1_000));
  idx = await h.index(h.workspaceId);
  assert.equal(overdueList(idx, TODAY).length, 0);
  assert.equal(reminderQueue(idx, TODAY, defaultSettings()).length, 0);
  assert.equal(dailyActions(idx, TODAY).length, 0);
  await assert.rejects(h.run("logReminder", { workspaceId: h.workspaceId, partyId: h.partyId, channel: "sms", message: "x" }), /nothing_due/);
});

test("J: a monthly recurring debt generates once per period; installments never duplicate principal", async () => {
  const h = await basic();
  await h.run("createRecurringPlan", {
    workspaceId: h.workspaceId,
    partyId: h.partyId,
    direction: "receivable",
    currency: "DZD",
    amount: DA(2_000),
    description: "Loyer",
    frequency: "monthly",
    startDate: "2026-09-30",
  });
  const first = await h.run("generateRecurring", { workspaceId: h.workspaceId });
  const second = await h.run("generateRecurring", { workspaceId: h.workspaceId });
  // Sep 30 and Oct 30 are due; Nov 30 is after today (Nov 22).
  assert.equal(first.created.length, 2);
  assert.equal(second.created.length, 0);
  let idx = await h.index(h.workspaceId);
  const periods = idx.data.obligations.map((o) => o.periodKey).sort();
  assert.deepEqual(periods, ["2026-09", "2026-10"]);
  assert.equal(new Set(periods).size, periods.length);
  // Installments describe an existing debt and never add principal.
  const target = idx.data.obligations[0];
  const before = workspaceTotals(idx, TODAY).get("DZD")!.receivable;
  await h.run("createInstallmentPlan", { obligationId: target.id, frequency: "weekly", count: 4, startDate: TODAY });
  await h.run("createInstallmentPlan", { obligationId: target.id, frequency: "weekly", count: 2, startDate: TODAY, reason: "reschedule" });
  idx = await h.index(h.workspaceId);
  assert.equal(workspaceTotals(idx, TODAY).get("DZD")!.receivable, before);
  assert.deepEqual(idx.data.installmentPlans.map((p) => p.state).sort(), ["active", "superseded"]);
});

test("K: creating an invoice, then recording payment, does not double-count the sale", async () => {
  const h = await basic();
  const { invoiceId } = await h.run("saveInvoiceDraft", {
    workspaceId: h.workspaceId,
    partyId: h.partyId,
    date: "2026-11-15",
    lines: [
      { description: "Ciment", quantityMilli: 10_000, unitPrice: DA(850), discountBps: 0, taxBps: 0 },
      { description: "Transport", quantityMilli: 1_000, unitPrice: DA(1_500), discountBps: 0, taxBps: 0 },
    ],
  });
  const posted = await h.run("postInvoice", { invoiceId });
  await h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 4_000, { date: "2026-11-20" }));
  const idx = await h.index(h.workspaceId);
  const report = periodReport(idx, "2026-11-01", "2026-11-30").get("DZD")!;
  assert.equal(report.newReceivables, DA(10_000), "one sale of 10,000");
  assert.equal(report.cashReceived, DA(4_000));
  assert.equal(idx.data.obligations.length, 1);
  assert.equal(partyBalance(idx, h.partyId, TODAY).get("DZD")!.receivable, DA(6_000));
  assert.equal(idx.data.invoices[0].number, "F-00001");
  assert.equal(idx.data.invoices[0].obligationId, posted.obligationId);
  await assert.rejects(h.run("postInvoice", { invoiceId }), /not_draft/);
});

test("L: two concurrent payments cannot allocate more than the remaining debt", async () => {
  const h = await fixtureA(); // 6,000 remaining
  const results = await Promise.allSettled([
    h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 5_000)),
    h.run("recordPayment", pay(h.workspaceId, h.partyId, "receivable", 5_000)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /overpayment/);
  const idx = await h.index(h.workspaceId);
  const ob = idx.obligation.get(h.obligationId)!;
  assert.equal(figuresOf(idx, ob).outstanding, DA(1_000));
});

test("harness sanity: a second workspace is isolated", async () => {
  const h = harness();
  const a = await h.run("createWorkspace", { name: "A" });
  const b = await h.run("createWorkspace", { name: "B" });
  const pa = await h.run("createParty", { workspaceId: a.workspaceId, displayName: "X" });
  await h.run("createObligation", debt(a.workspaceId, pa.partyId, "receivable", 100));
  await assert.rejects(h.run("createObligation", debt(b.workspaceId, pa.partyId, "receivable", 100)), /party_not_found/);
  assert.equal((await h.index(b.workspaceId)).obligation.size, 0);
});
