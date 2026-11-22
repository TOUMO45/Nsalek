// IndexedDB adapter and backup/restore round trips.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openStore } from "../lib/storage/idb.ts";
import { createBackup, parseBackup, serializeBackup, validateLedger } from "../lib/core/backup.ts";
import { loadLedger, restoreBackup } from "../lib/core/restore.ts";
import { canonical } from "../lib/core/backup.ts";
import { buildIndex, figuresOf, partyBalance } from "../lib/core/ledger.ts";
import { computeTotals } from "../lib/core/backup.ts";
import { MemoryStore } from "../lib/core/store.ts";
import { basic, DA, harness, nextId, TODAY } from "./helpers.ts";

async function populated(store?: import("../lib/core/store.ts").Store) {
  const h = await basic(store);
  const { obligationId } = await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01", dueDate: "2026-11-10" });
  const p = await h.run("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(2_500), date: "2026-11-05" });
  await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "payable", currency: "EUR", principal: 12_345, date: "2026-11-02" });
  await h.run("addAttachment", { workspaceId: h.workspaceId, ownerType: "payment", ownerId: p.paymentId, name: "recu.png", mime: "image/png", data: "aGVsbG8gd29ybGQ=", sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" });
  return { ...h, obligationId };
}

test("IndexedDB adapter: commands persist across reopen and reject duplicate ids", async () => {
  const factory = new IDBFactory();
  const s1 = await openStore("t1", factory);
  const h = await populated(s1);
  s1.close();
  const s2 = await openStore("t1", factory);
  const data = await loadLedger(s2);
  const idx = buildIndex(data, h.workspaceId);
  assert.equal(figuresOf(idx, idx.obligation.get(h.obligationId)!).outstanding, DA(7_500));
  assert.equal(data.attachments.length, 1);
  // Idempotency survives a restart.
  const id = nextId();
  const h2 = harness(s2);
  await h2.raw("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(500) }, id);
  s2.close();
  const s3 = await openStore("t1", factory);
  const again = await harness(s3).raw("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(500) }, id);
  assert.equal(again.replayed, true);
  assert.equal((await loadLedger(s3)).payments.length, 2);
  s3.close();
});

test("IndexedDB adapter: a failing command rolls back every write", async () => {
  const store = await openStore("t2", new IDBFactory());
  const h = await basic(store);
  await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(100), date: TODAY });
  await assert.rejects(h.run("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(500) }), /overpayment/);
  const data = await loadLedger(store);
  assert.equal(data.payments.length, 0);
  assert.equal(data.audit.filter((a) => a.action === "payment.post").length, 0);
  store.close();
});

test("IndexedDB adapter: concurrent payments serialize (fixture L on the real adapter)", async () => {
  const store = await openStore("t3", new IDBFactory());
  const h = await basic(store);
  await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(6_000), date: TODAY });
  const pay = { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(5_000) };
  const r = await Promise.allSettled([h.run("recordPayment", pay), h.run("recordPayment", pay)]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  const data = await loadLedger(store);
  assert.equal(data.payments.length, 1);
  store.close();
});

test("backup round trip (encrypted): records, attachments and totals are identical after restore", async () => {
  const src = await populated();
  const original = await loadLedger(src.store);
  const text = serializeBackup(await createBackup(original, { passphrase: "correct horse", iterations: 1000 }));
  assert.ok(!text.includes("Karim"), "payload is encrypted");
  const file = parseBackup(text);
  assert.equal(file.manifest.counts.parties, 1);
  assert.equal(file.manifest.attachments.included, 1);

  const target = await openStore("t4", new IDBFactory());
  await assert.rejects(restoreBackup(target, file, { mode: "replace", passphrase: "wrong" }), /wrong_passphrase/);
  await restoreBackup(target, file, { mode: "replace", passphrase: "correct horse" });
  const restored = await loadLedger(target);
  for (const s of Object.keys(original) as (keyof typeof original)[]) {
    const sort = (l: { id: string }[]) => [...l].sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(canonical(sort(restored[s] as never)), canonical(sort(original[s] as never)), s);
  }
  assert.deepEqual(computeTotals(restored), computeTotals(original));
  assert.equal(validateLedger(restored).length, 0);
  target.close();
});

test("restore keeps a pre-restore snapshot; corrupt backups never touch active data", async () => {
  const src = await populated();
  const file = await createBackup(await loadLedger(src.store));
  const target = await populated(new MemoryStore());
  const before = await loadLedger(target.store);
  const tampered = JSON.parse(serializeBackup(file));
  tampered.payload.obligations[0].principal += 1;
  await assert.rejects(restoreBackup(target.store, parseBackup(JSON.stringify(tampered)), { mode: "replace" }), /integrity_failed/);
  assert.equal(canonical(await loadLedger(target.store)), canonical(before));
  await assert.rejects(Promise.resolve().then(() => parseBackup("{not json")), /not_a_backup/);
  const result = await restoreBackup(target.store, file, { mode: "replace" });
  const snap = await target.store.run("readonly", (tx) => tx.get("snapshots", result.snapshotId));
  assert.ok(snap && parseBackup(snap.backup).manifest.counts.parties === 1);
});

test("merge restore twice never double-counts", async () => {
  const src = await populated();
  const file = await createBackup(await loadLedger(src.store));
  const target = harness(new MemoryStore());
  const first = await restoreBackup(target.store, file, { mode: "merge" });
  const second = await restoreBackup(target.store, file, { mode: "merge" });
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
  assert.equal(second.conflicts.length, 0);
  const idx = buildIndex(await loadLedger(target.store), src.workspaceId);
  assert.equal(partyBalance(idx, src.partyId, TODAY).get("DZD")!.receivable, DA(7_500));
  assert.equal(idx.data.payments.length, 1);
});

test("validator flags orphaned and over-allocated records", async () => {
  const src = await populated();
  const data = await loadLedger(src.store);
  data.allocations[0].amount = DA(20_000);
  data.payments.push({ ...data.payments[0], id: "pay_orphan", partyId: "nobody" });
  const codes = validateLedger(data).map((i) => i.code);
  assert.ok(codes.includes("negative_outstanding"));
  assert.ok(codes.includes("overallocated_payment"));
  assert.ok(codes.includes("orphan_party"));
});

test("workspace-scoped backup excludes other workspaces", async () => {
  const h = await populated();
  const other = await h.run("createWorkspace", { name: "Other" });
  await h.run("createParty", { workspaceId: other.workspaceId, displayName: "Secret" });
  const file = await createBackup(await loadLedger(h.store), { workspaceIds: [h.workspaceId] });
  assert.ok(!serializeBackup(file).includes("Secret"));
  assert.equal(file.manifest.counts.workspaces, 1);
});
