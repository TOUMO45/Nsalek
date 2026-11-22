// Agrovet clinic importer: dry-run plan, reconciliation, privacy defaults, commit and reversal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agrovetCommitPayload, planAgrovetImport, WITHHELD_REMINDER_TEXT, type AgrovetImportOptions, type AgrovetImportPlan } from "../lib/migration/agrovet.ts";
import { validateLedger } from "../lib/core/backup.ts";
import { figuresOf, partyBalance, workspaceTotals } from "../lib/core/ledger.ts";
import { harness, loadAll, NOW, TODAY, type R } from "./helpers.ts";

const FIXTURE_URL = new URL("./fixtures/agrovet-sample.json", import.meta.url);
const fixture = (): R => JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
const WS = "ws_migration";
const plan = (source: unknown, extra: Partial<AgrovetImportOptions> = {}) => planAgrovetImport(source, { workspaceId: WS, now: NOW, today: TODAY, ...extra });

// Text that must never leave the export unless the user opts in.
const SENSITIVE = ["SYNTH-", "TestMed", "sheep", "goat", "cow", "camel", "animalQuantity", "unitPrice", "veterinary", "medicine"];
const leaks = (text: string) => SENSITIVE.filter((s) => text.toLowerCase().includes(s.toLowerCase()));

const codes = (p: AgrovetImportPlan, code: string) => p.report.review.filter((r) => r.code === code);
/** Net receivable of a party, comparable to Agrovet's cached client balance. */
const netOf = (...args: Parameters<typeof partyBalance>) => {
  const b = partyBalance(...args).get("DZD");
  return (b?.receivable ?? 0) - (b?.advanceReceived ?? 0);
};

test("clean fixture: counts and totals reconcile with Agrovet cached figures", async () => {
  const src = fixture();
  const p = await plan(src);
  const { counts, totals } = p.report;
  assert.equal(p.report.ready, true);
  assert.equal(p.report.blocking, 0);
  assert.deepEqual(p.report.mismatches, []);
  assert.equal(counts.clients.imported, 5);
  assert.equal(counts.debts.imported, 5);
  assert.equal(counts.payments.imported, 4);
  assert.equal(counts.allocations.imported, 5);
  assert.equal(counts.reminders.imported, 2);
  assert.equal(counts.medicines.imported, 0);
  assert.deepEqual(counts.medicines.skipped, { not_imported: 3 });
  for (const c of [counts.clients, counts.debts, counts.payments, counts.allocations, counts.reminders, counts.medicines]) {
    const skipped = Object.values(c.skipped).reduce((n, x) => n + x, 0);
    assert.equal(c.source, c.imported + skipped + c.orphaned);
  }
  assert.deepEqual(totals.debt, { cached: 1_870_000, imported: 1_870_000, openingBalances: 0, difference: 0, matches: true });
  assert.equal(totals.paid.cached, 1_070_000);
  assert.equal(totals.paid.imported, 1_070_000);
  assert.equal(totals.paid.matches, true);
  assert.equal(totals.balance.cached, 800_000);
  assert.equal(totals.balance.outstanding, 800_000);
  assert.equal(totals.balance.advances, 0);
  assert.equal(totals.balance.matches, true);
  assert.equal(p.report.followUpDates.mapped, 5);
  assert.equal(p.records.payments.filter((x) => x.allowAdvance).length, 0);
  // Deterministic ids and legacy references.
  assert.equal(p.idMap.clients.agc001, "ag_c_agc001");
  assert.equal(p.idMap.debts.agd001, "ag_d_agd001");
  assert.equal(p.idMap.payments.agp001, "ag_p_agp001");
  assert.deepEqual(p.records.allocations.filter((a) => a.paymentId === "ag_p_agp001").map((a) => a.id), ["ag_a_agp001_1", "ag_a_agp001_2"]);
  assert.deepEqual(p.records.parties[0].legacy, { system: "agrovet", collection: "clients", id: "agc001" });
  assert.equal(p.records.parties[0].phones[0], "+213550000001");
  // Pure and deterministic: same input → same plan, input untouched.
  assert.deepEqual(src, fixture());
  assert.deepEqual(await plan(fixture()), p);
  assert.equal((await plan(JSON.stringify(src))).fileHash, p.fileHash, "hash ignores formatting");
});

test("reminderDate becomes remindOn, never a due date; reminders are opened_for_sharing", async () => {
  const p = await plan(fixture());
  const d1 = p.records.obligations.find((o) => o.id === "ag_d_agd001")!;
  assert.equal(d1.remindOn, "2026-09-15");
  assert.equal(d1.dueDate, null);
  assert.equal(d1.kind, "service");
  assert.equal(d1.description, "Agrovet 2026-09-01");
  assert.ok(p.records.obligations.every((o) => o.dueDate === null));
  for (const r of p.records.reminders) {
    assert.equal(r.status, "opened_for_sharing");
    assert.deepEqual(r.history.map((h) => h.status), ["opened_for_sharing"]);
    assert.equal(r.channel, "sms");
    assert.equal(r.message, WITHHELD_REMINDER_TEXT);
  }
  assert.deepEqual(p.records.reminders.find((r) => r.id === "ag_r_agr001")!.amounts, [{ currency: "DZD", amount: 400_000 }]);
});

test("deleted debt without payments is skipped as voided and counted", async () => {
  const p = await plan(fixture());
  assert.equal(p.records.obligations.some((o) => o.legacy?.id === "agd003"), false);
  assert.equal(p.idMap.debts.agd003, undefined);
  assert.equal(p.report.counts.debts.skipped.voided, 1);
  assert.equal(codes(p, "debt_voided_skipped")[0].id, "agd003");
});

test("archived (hidden) debt with a payment is imported as live and its balance is correct", async () => {
  const p = await plan(fixture());
  const ob = p.records.obligations.find((o) => o.id === "ag_d_agd005")!;
  assert.ok(ob, "archived debt imported");
  assert.equal(ob.state, "posted");
  assert.ok(ob.tags.includes("agrovet:archived"));
  assert.ok(codes(p, "debt_archived_imported").some((r) => r.id === "agd005"));
  const h = harness();
  const { workspaceId } = await h.run("createWorkspace", { name: "Clinic import", workspaceId: WS });
  await h.run("commitImport", agrovetCommitPayload(p, "agrovet-sample.json"));
  const idx = await h.index(workspaceId);
  assert.equal(figuresOf(idx, idx.obligation.get("ag_d_agd005")!).outstanding, 300_000);
  assert.equal(figuresOf(idx, idx.obligation.get("ag_d_agd005")!).paid, 200_000);
  assert.equal(netOf(idx, "ag_c_agc003", TODAY), 300_000);
});

test("a debt flagged deleted but holding payments is kept and flagged for review", async () => {
  const src = fixture();
  src.debts.find((d: R) => d.id === "agd005").deletedAt = "2026-09-02T00:00:00.000Z";
  const p = await plan(src);
  assert.ok(p.idMap.debts.agd005);
  assert.equal(codes(p, "debt_deleted_with_payments")[0].id, "agd005");
});

test("orphan allocation goes to review and does not inflate payments", async () => {
  const src = fixture();
  src.payments.find((x: R) => x.id === "agp004").allocations[0].debtId = "agd999";
  const p = await plan(src);
  assert.equal(p.records.allocations.some((a) => a.paymentId === "ag_p_agp004"), false);
  assert.equal(p.report.counts.allocations.orphaned, 1);
  assert.equal(codes(p, "allocation_orphan")[0].detail?.reason, "debt_missing");
  const pay = p.records.payments.find((x) => x.id === "ag_p_agp004")!;
  assert.equal(pay.amount, 50_000, "payment amount unchanged");
  assert.equal(pay.allowAdvance, true);
  assert.equal(codes(p, "payment_unallocated_advance")[0].amount, 50_000);
  assert.equal(p.report.totals.paid.imported, 1_020_000, "only real allocations are counted");
  assert.equal(p.report.totals.paid.orphaned, 50_000);
  assert.equal(p.report.totals.paid.matches, false);
  assert.equal(p.report.totals.balance.outstanding, 850_000);
  assert.equal(p.report.totals.balance.advances, 50_000);
  const ob = p.records.obligations.find((o) => o.id === "ag_d_agd002")!;
  assert.equal(p.records.allocations.filter((a) => a.obligationId === ob.id).reduce((n, a) => n + a.amount, 0), 100_000);
  assert.ok(codes(p, "debt_paid_cache_mismatch").some((r) => r.id === "agd002"));
});

test("allocation to another client's debt, or to a voided debt, is an orphan", async () => {
  const src = fixture();
  src.payments.find((x: R) => x.id === "agp004").allocations[0].debtId = "agd004";
  src.payments.find((x: R) => x.id === "agp002").allocations[0].debtId = "agd003";
  const p = await plan(src);
  const reasons = codes(p, "allocation_orphan").map((r) => r.detail?.reason).sort();
  assert.deepEqual(reasons, ["debt_skipped", "other_client"]);
  assert.equal(p.report.counts.allocations.orphaned, 2);
  assert.equal(p.records.allocations.length, 3);
});

test("payment without a known client is an orphan and is skipped", async () => {
  const src = fixture();
  src.payments.push({ id: "agp099", clientId: "agc999", date: "2026-11-01", amount: 1000, paymentMethod: "cash", notes: "", allocations: [{ debtId: "agd001", amount: 1000 }], createdAt: "2026-11-01T10:00:00.000Z" });
  const p = await plan(src);
  assert.equal(p.idMap.payments.agp099, undefined);
  assert.equal(p.report.counts.payments.orphaned, 1);
  assert.equal(p.report.counts.allocations.skipped.payment_skipped, 1);
  assert.equal(codes(p, "payment_client_missing")[0].id, "agp099");
  assert.equal(p.report.totals.paid.imported, 1_070_000);
});

test("by default no medicine, species, notes or reminder text appears anywhere in the records", async () => {
  const p = await plan(fixture());
  assert.deepEqual(leaks(JSON.stringify(p.records)), []);
  assert.deepEqual(leaks(JSON.stringify(p.report)).filter((s) => !["veterinary", "medicine"].includes(s)), [], "report holds counts, never content");
  assert.ok(p.records.obligations.every((o) => o.extension === undefined));
  assert.ok(p.records.parties.every((x) => x.notes === ""));
  assert.ok(p.records.payments.every((x) => x.note === ""));
  assert.deepEqual(p.report.withheld, {
    clientNotes: 2,
    debtNotes: 2,
    paymentNotes: 1,
    reminderMessages: 2,
    veterinaryDetails: 5,
    medicineItems: 6,
    medicineCatalog: 3,
  });
});

test("opt-in puts veterinary details only under extension.veterinary", async () => {
  const p = await plan(fixture(), { includeVeterinaryDetails: true });
  const d4 = p.records.obligations.find((o) => o.id === "ag_d_agd004")!;
  assert.deepEqual(d4.extension, { veterinary: { species: "cow", animalQuantity: 2, unitPrice: 200_000, medicines: ["TestMed Alpha 10ml", "TestMed Beta 5ml"] } });
  assert.equal(d4.description, "Agrovet 2026-11-01");
  const stripped = { ...p.records, obligations: p.records.obligations.map((o) => ({ ...o, extension: undefined })) };
  assert.deepEqual(leaks(JSON.stringify(stripped)), []);
  assert.equal(p.report.included.veterinaryDetails, 5);
  assert.equal(p.report.withheld.veterinaryDetails, 0);
  assert.equal(p.report.withheld.debtNotes, 2, "debt notes are never copied");

  const withNotes = await plan(fixture(), { includeClientNotes: true });
  assert.match(withNotes.records.parties.find((x) => x.id === "ag_c_agc001")!.notes, /SYNTH-CLIENT-NOTE-1/);
  const noParties = { ...withNotes.records, parties: withNotes.records.parties.map((x) => ({ ...x, notes: "" })) };
  assert.deepEqual(leaks(JSON.stringify(noParties)), []);
  assert.equal(withNotes.report.included.clientNotes, 2);
});

test("client with a balance but no importable debt → one opening balance, never duplicated with history", async () => {
  const src = fixture();
  // Beta's only remaining debt row is the voided one; Alpha's cached balance is wrong but she has debts.
  src.debts = src.debts.filter((d: R) => d.id !== "agd004");
  src.clients.find((c: R) => c.id === "agc001").balance = 123_456;
  const p = await plan(src);
  const beta = p.records.obligations.filter((o) => o.partyId === "ag_c_agc002");
  assert.equal(beta.length, 1);
  assert.equal(beta[0].kind, "opening_balance");
  assert.equal(beta[0].principal, 400_000);
  assert.equal(beta[0].date, "2026-11-01", "dated at the last debt date");
  assert.equal(p.idMap.openingBalances.agc002, "ag_ob_agc002");
  assert.deepEqual(p.report.openingBalances.map((o) => [o.clientId, o.amount]), [["agc002", 400_000]]);
  assert.equal(p.report.counts.openingBalances, 1);
  // Alpha has historical debts: no opening balance, the cache mismatch goes to review instead.
  assert.equal(p.records.obligations.filter((o) => o.partyId === "ag_c_agc001" && o.kind === "opening_balance").length, 0);
  assert.deepEqual(p.report.mismatches.map((m) => [m.clientId, m.cachedBalance, m.computedBalance]), [["agc001", 123_456, 100_000]]);
  // Each client has either historical debts or an opening balance, never both.
  for (const party of p.records.parties) {
    const kinds = new Set(p.records.obligations.filter((o) => o.partyId === party.id).map((o) => o.kind === "opening_balance"));
    assert.ok(kinds.size <= 1, party.id);
  }
  // Payments of an opening-balance client are already netted in the balance: not imported twice.
  const src2 = fixture();
  src2.debts = src2.debts.filter((d: R) => d.clientId !== "agc003");
  const p2 = await plan(src2);
  assert.equal(p2.records.obligations.find((o) => o.partyId === "ag_c_agc003")!.principal, 300_000);
  assert.equal(p2.idMap.payments.agp002, undefined);
  assert.equal(p2.report.counts.payments.skipped.covered_by_opening_balance, 1);
  assert.equal(p2.report.openingBalances[0].coveredAmount, 200_000);
  assert.equal(p2.report.totals.balance.matches, true);
});

test("commit through commitImport: balances equal Agrovet cached balances, ledger valid, replay refused", async () => {
  const src = fixture();
  const p = await plan(src);
  const h = harness();
  const { workspaceId } = await h.run("createWorkspace", { name: "Clinic import", workspaceId: WS });
  const { batchId, counts } = await h.run("commitImport", agrovetCommitPayload(p, "agrovet-sample.json"));
  assert.deepEqual(counts, { parties: 5, obligations: 5, payments: 4, allocations: 5, reminders: 2 });
  const idx = await h.index(workspaceId);
  for (const c of src.clients) assert.equal(netOf(idx, p.idMap.clients[c.id], TODAY), c.balance, c.id);
  assert.equal(workspaceTotals(idx, TODAY).get("DZD")!.receivable, 800_000);
  assert.ok(idx.data.obligations.every((o) => o.importBatchId === batchId));
  assert.ok(idx.data.importBatches[0].report, "review report stored with the batch");
  assert.deepEqual(validateLedger(await loadAll(h.store)), []);

  // Same file again → refused by hash; forcing a replay still collides on deterministic ids.
  await assert.rejects(h.run("commitImport", agrovetCommitPayload(p, "agrovet-sample.json")), /already_imported/);
  await assert.rejects(h.run("commitImport", { ...agrovetCommitPayload(p, "copy.json"), allowReplay: true }), /exists/);
  assert.equal((await loadAll(h.store)).payments.length, 4, "failed commits wrote nothing");
});

test("reverseImport returns workspace receivables to zero and keeps the ledger valid", async () => {
  const p = await plan(fixture());
  const h = harness();
  const { workspaceId } = await h.run("createWorkspace", { name: "Clinic import", workspaceId: WS });
  const { batchId } = await h.run("commitImport", agrovetCommitPayload(p, "agrovet-sample.json"));
  await h.run("reverseImport", { batchId, reason: "test rollback" });
  const idx = await h.index(workspaceId);
  const t = workspaceTotals(idx, TODAY).get("DZD");
  assert.equal(t?.receivable ?? 0, 0);
  assert.equal(t?.advanceReceived ?? 0, 0);
  assert.ok(idx.data.obligations.every((o) => o.state === "voided"));
  assert.ok(idx.data.payments.every((x) => x.state === "reversed"));
  assert.deepEqual(validateLedger(await loadAll(h.store)), []);

  // A deliberate re-import after reversal needs a fresh id prefix (old rows stay as history).
  const again = await plan(fixture(), { idPrefix: "ag2" });
  await h.run("commitImport", agrovetCommitPayload(again, "agrovet-sample.json"));
  const idx2 = await h.index(workspaceId);
  assert.equal(workspaceTotals(idx2, TODAY).get("DZD")!.receivable, 800_000);
  assert.deepEqual(validateLedger(await loadAll(h.store)), []);
});

test("rejects malformed exports and invalid options", async () => {
  await assert.rejects(plan("{not json"), /invalid_json/);
  await assert.rejects(plan({ clients: [] }), /invalid_agrovet_export/);
  await assert.rejects(plan(fixture(), { idPrefix: "bad prefix" }), /invalid_id_prefix/);
  await assert.rejects(planAgrovetImport(fixture(), { workspaceId: "" }), /invalid_id/);
  const src = fixture();
  src.debts[1].date = "2027-01-01";
  const p = await plan(src);
  assert.equal(p.report.counts.debts.skipped.future_date, 1);
  assert.equal(codes(p, "allocation_orphan").length, 2, "allocations to the skipped debt are orphans");
});

test("the importer never reaches the network or a database", () => {
  const code = readFileSync(new URL("../lib/migration/agrovet.ts", import.meta.url), "utf8");
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|indexedDB|firebase|firestore\.|from ["']node:/i);
});
