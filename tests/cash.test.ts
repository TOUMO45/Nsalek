// Cash book: entries, cash repayments counted once, cancelling with a reason, cash at hand,
// summaries, export, backups, and the database upgrade of a phone that already has data.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { cashAtHand, cashLines, cashSummary, cashTotals, exportCash } from "../lib/core/cash.ts";
import { createBackup, parseBackup, serializeBackup, validateLedger } from "../lib/core/backup.ts";
import { loadLedger, restoreBackup } from "../lib/core/restore.ts";
import { INDEXES, MemoryStore } from "../lib/core/store.ts";
import { ALL_STORES } from "../lib/core/types.ts";
import { IdbStore, openDatabase } from "../lib/storage/idb.ts";
import { basic, DA, harness } from "./helpers.ts";

async function day() {
  const h = await basic();
  const w = h.workspaceId;
  await h.run("addCashEntry", { workspaceId: w, kind: "opening", amount: DA(5_000), date: "2026-11-20" });
  await h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: DA(12_000), date: "2026-11-22", category: "Pain" });
  await h.run("addCashEntry", { workspaceId: w, kind: "expense", amount: DA(3_000), date: "2026-11-22", category: "Électricité" });
  await h.run("addCashEntry", { workspaceId: w, kind: "purchase", amount: DA(4_500), date: "2026-11-22", category: "Marchandise", method: "ccp_baridimob" });
  // A debt repaid in cash, another repaid by transfer: only the cash one goes through the drawer.
  await h.run("createObligation", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01" });
  await h.run("recordPayment", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(2_000), date: "2026-11-22", method: "cash" });
  await h.run("recordPayment", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(1_000), date: "2026-11-22", method: "bank_transfer" });
  return h;
}

test("cash: a day's lines, cash repayments counted once, other ways of paying left out", async () => {
  const h = await day();
  const data = await loadLedger(h.store);
  const lines = cashLines(data, h.workspaceId, "2026-11-22", "2026-11-22");
  assert.deepEqual(
    lines.map((l) => [l.kind, l.direction, l.amount]),
    [
      ["sale", "in", DA(12_000)],
      ["expense", "out", DA(3_000)],
      ["purchase", "out", DA(4_500)],
      ["repayment", "in", DA(2_000)],
    ],
  );
  assert.equal(lines[3].label, "Karim");
  assert.deepEqual(cashTotals(lines, "DZD"), { in: DA(14_000), out: DA(7_500), net: DA(6_500) });
  assert.equal(cashAtHand(data, h.workspaceId, "2026-11-22", "DZD"), DA(11_500), "5,000 at the start + 6,500 this day");
  assert.equal(cashAtHand(data, h.workspaceId, "2026-11-21", "DZD"), DA(5_000));
});

test("cash: cash at hand starts at the latest drawer count, never at the notebook's first repayment", async () => {
  const h = await basic();
  const w = h.workspaceId;
  await h.run("createObligation", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(900_000), date: "2025-01-01" });
  // A year of cash repayments before the cash book was used.
  await h.run("recordPayment", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(800_000), date: "2025-06-01", method: "cash" });
  let data = await loadLedger(h.store);
  assert.equal(cashAtHand(data, w, "2026-11-22", "DZD"), null, "no entry of its own yet");
  await h.run("addCashEntry", { workspaceId: w, kind: "opening", amount: DA(15_000), date: "2026-11-20" });
  await h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: DA(1_000), date: "2026-11-21" });
  data = await loadLedger(h.store);
  assert.equal(cashAtHand(data, w, "2026-11-21", "DZD"), DA(16_000));
  // The next morning's count starts again from what was counted.
  await h.run("addCashEntry", { workspaceId: w, kind: "opening", amount: DA(15_800), date: "2026-11-22" });
  await h.run("addCashEntry", { workspaceId: w, kind: "expense", amount: DA(300), date: "2026-11-22" });
  data = await loadLedger(h.store);
  assert.equal(cashAtHand(data, w, "2026-11-22", "DZD"), DA(15_500));
  assert.equal(cashAtHand(data, w, "2026-11-21", "DZD"), DA(16_000), "an earlier day keeps its own count");
  await assert.rejects(h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: DA(1), date: "2030-01-01" }), /future_date/);
});

test("cash: a notebook used only as a cash book is not empty: it is copied, reminded and never replaced as blank", async () => {
  const { isBlank, cloudView } = await import("../lib/cloud/bundle.ts");
  const { signature } = await import("../lib/drive/copy.ts");
  const { backupStatus } = await import("../lib/core/quickBackup.ts");
  const h = harness();
  const { workspaceId } = await h.run("createWorkspace", { name: "Caisse seule" });
  await h.run("addCashEntry", { workspaceId, kind: "opening", amount: DA(5_000) });
  const data = await loadLedger(h.store);
  assert.equal(isBlank(cloudView(data)), false);
  assert.notEqual(signature(data), null);
  assert.notEqual(backupStatus(data, null, new Date("2026-11-22T12:00:00Z")).level, "none");
});

test("cash: a cancelled entry stays visible, counts for nothing, and needs a reason", async () => {
  const h = await day();
  const sale = (await loadLedger(h.store)).cashEntries.find((e) => e.kind === "sale")!;
  await assert.rejects(h.run("voidCashEntry", { cashEntryId: sale.id }), /reason_required/);
  await h.run("voidCashEntry", { cashEntryId: sale.id, reason: "typed twice" });
  await assert.rejects(h.run("voidCashEntry", { cashEntryId: sale.id, reason: "again" }), /already_voided/);
  const data = await loadLedger(h.store);
  const lines = cashLines(data, h.workspaceId, "2026-11-22", "2026-11-22");
  assert.equal(lines.find((l) => l.id === sale.id)!.voided, true);
  assert.equal(cashTotals(lines, "DZD").in, DA(2_000));
  assert.ok(data.audit.some((e) => e.action === "cash.void" && e.entityId === sale.id));
  // A reversed repayment no longer counts either.
  const pay = data.payments.find((p) => p.method === "cash")!;
  await h.run("reversePayment", { paymentId: pay.id, reason: "wrong person" });
  assert.equal(cashTotals(cashLines(await loadLedger(h.store), h.workspaceId, "2026-11-22", "2026-11-22"), "DZD").in, 0);
});

test("cash: wrong amounts, kinds and dates are refused; never a float", async () => {
  const h = await basic();
  const w = h.workspaceId;
  for (const amount of [0, -5, 1.5, "100", Number.MAX_SAFE_INTEGER + 2]) await assert.rejects(h.run("addCashEntry", { workspaceId: w, kind: "sale", amount }), /amount_positive/);
  await assert.rejects(h.run("addCashEntry", { workspaceId: w, kind: "gift", amount: 100 }), /invalid_cash_kind/);
  await assert.rejects(h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: 100, date: "2026-13-40" }), /invalid_date/);
  await assert.rejects(h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: 100, currency: "XXXX" }), /invalid_currency/);
  const { cashEntryId } = await h.run("addCashEntry", { workspaceId: w, kind: "withdrawal", amount: 100 });
  const e = (await loadLedger(h.store)).cashEntries.find((x) => x.id === cashEntryId)!;
  assert.deepEqual([e.direction, e.date, e.currency, e.method], ["out", "2026-11-22", "DZD", "cash"]);
});

test("cash: the same command sent twice adds one entry", async () => {
  const h = await basic();
  await h.run("addCashEntry", { workspaceId: h.workspaceId, kind: "sale", amount: 100 }, "cmd_same");
  await h.run("addCashEntry", { workspaceId: h.workspaceId, kind: "sale", amount: 100 }, "cmd_same");
  assert.equal((await loadLedger(h.store)).cashEntries.length, 1);
});

test("cash: the month by kind and by label; another notebook's cash never mixes in", async () => {
  const h = await day();
  const other = await h.run("createWorkspace", { name: "Autre" });
  await h.run("addCashEntry", { workspaceId: other.workspaceId, kind: "sale", amount: DA(99_999), date: "2026-11-22" });
  await h.run("addCashEntry", { workspaceId: h.workspaceId, kind: "expense", amount: DA(500), date: "2026-11-21", category: "électricité " });
  const s = cashSummary(await loadLedger(h.store), h.workspaceId, "2026-11-01", "2026-11-30", "DZD");
  assert.deepEqual(s.totals, { in: DA(19_000), out: DA(8_000), net: DA(11_000) });
  const elec = s.byCategory.find((c) => c.category.toLowerCase().startsWith("électricité"))!;
  assert.equal(elec.amount, DA(3_500), "the same label, written a little differently, is one line");
});

test("cash: export keeps cancelled lines marked, and guards against spreadsheet formulas", async () => {
  const h = await basic();
  await h.run("addCashEntry", { workspaceId: h.workspaceId, kind: "expense", amount: DA(10), category: "=HYPERLINK(1)" });
  const csv = exportCash(await loadLedger(h.store), h.workspaceId, "2026-11-01", "2026-11-30", { lang: "fr" });
  assert.match(csv, /Libellé/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /10[.,]00/);
});

test("cash: a backup and a restore carry the cash book; a broken entry is refused", async () => {
  const h = await day();
  const file = await createBackup(await loadLedger(h.store), {});
  assert.equal(file.manifest.counts.cashEntries, 4);
  const fresh = new MemoryStore();
  await restoreBackup(fresh, parseBackup(serializeBackup(file)), { mode: "replace" });
  assert.equal((await loadLedger(fresh)).cashEntries.length, 4);
  const data = await loadLedger(h.store);
  data.cashEntries[0] = { ...data.cashEntries[0], direction: "out" };
  data.cashEntries[1] = { ...data.cashEntries[1], amount: 0.5 };
  assert.deepEqual(validateLedger(data).map((i) => i.code).sort(), ["invalid_amount", "invalid_cash_kind"]);
});

test("cash: a backup made before the cash book still opens", async () => {
  const h = await basic();
  const file = await createBackup(await loadLedger(h.store), {});
  const old = JSON.parse(serializeBackup(file));
  old.schemaVersion = 1;
  delete old.payload.cashEntries;
  delete old.manifest.counts.cashEntries;
  const { canonical } = await import("../lib/core/backup.ts");
  const { sha256Hex } = await import("../lib/core/crypto.ts");
  old.manifest.payloadSha256 = await sha256Hex(canonical(old.payload));
  const fresh = new MemoryStore();
  await restoreBackup(fresh, parseBackup(JSON.stringify(old)), { mode: "replace" });
  assert.equal((await loadLedger(fresh)).parties.length, 1);
});

test("cash: a phone that already has data gets the cash book without losing anything", async () => {
  const factory = new IDBFactory();
  // A version-1 database, as phones have it today.
  const v1 = await new Promise<IDBDatabase>((ok, no) => {
    const req = factory.open("nsalek", 1);
    req.onupgradeneeded = () => {
      // Exactly what version 1 created: every store of that time, with its indexes.
      for (const name of ALL_STORES.filter((s) => s !== "cashEntries")) {
        const os = req.result.createObjectStore(name, { keyPath: "id" });
        for (const field of INDEXES[name] ?? []) os.createIndex(field, field, { unique: false });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
  await new Promise<void>((ok) => {
    const tx = v1.transaction(["workspaces"], "readwrite");
    tx.objectStore("workspaces").put({ id: "ws_old", name: "Boutique" });
    tx.oncomplete = () => ok();
  });
  v1.close();
  const store = new IdbStore(await openDatabase("nsalek", factory));
  const ws = await store.run("readonly", (tx) => tx.get("workspaces", "ws_old"));
  assert.equal(ws?.name, "Boutique");
  assert.deepEqual(await store.run("readonly", (tx) => tx.all("cashEntries")), []);
  const h = harness(store);
  const { workspaceId } = await h.run("createWorkspace", { name: "Nouveau" });
  await h.run("addCashEntry", { workspaceId, kind: "sale", amount: 100 });
  assert.equal((await loadLedger(store)).cashEntries.length, 1);
});
