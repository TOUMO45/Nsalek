// One-tap encrypted backup: the passphrase is typed once, the derived key stays on the device,
// and the file it produces must restore on another device with the passphrase alone.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openStore } from "../lib/storage/idb.ts";
import { MemoryStore } from "../lib/core/store.ts";
import { canonical, computeTotals, createBackup, openBackup, parseBackup, serializeBackup } from "../lib/core/backup.ts";
import { loadLedger, restoreBackup } from "../lib/core/restore.ts";
import { backupStatus, checkPassphrase, coversEverything, makeBackupKey, notebooksLost, quickBackup } from "../lib/core/quickBackup.ts";
import { genericNotification } from "../lib/core/messages.ts";
import { deliverBackup } from "../lib/ui/deliver.ts";
import { basic, DA, harness, NOW } from "./helpers.ts";

const FAST = 1000; // PBKDF2 iterations for tests
const PASS = "lait-cafe-2026";

async function shop() {
  const h = await basic();
  await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01" });
  await h.run("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(2_500), date: "2026-11-05" });
  return h;
}

test("quick backup: erase the phone, restore elsewhere with the passphrase only, 0 DA difference", async () => {
  const h = await shop();
  const before = await loadLedger(h.store);
  const key = await makeBackupKey(PASS, { iterations: FAST, now: NOW });
  const b = await quickBackup(before, key, { now: NOW });
  assert.equal(b.check.ok, true);
  const newPhone = new MemoryStore();
  await restoreBackup(newPhone, parseBackup(b.text), { mode: "replace", passphrase: PASS });
  const after = await loadLedger(newPhone);
  assert.equal(canonical(computeTotals(after, NOW)), canonical(computeTotals(before, NOW)));
  assert.equal(computeTotals(after, NOW)[0].receivable, DA(7_500));
  await assert.rejects(restoreBackup(new MemoryStore(), parseBackup(b.text), { mode: "replace", passphrase: "wrong-pass" }), /wrong_passphrase/);
});

test("quick backup: the file reveals no name, amount or passphrase, and two backups never share an IV", async () => {
  const h = await shop();
  const data = await loadLedger(h.store);
  const key = await makeBackupKey(PASS, { iterations: FAST, now: NOW });
  const a = await quickBackup(data, key, { now: NOW });
  const b = await quickBackup(data, key, { now: NOW });
  for (const secret of ["Karim", PASS, String(DA(7_500)), String(DA(10_000))]) assert.equal(a.text.includes(secret), false, secret);
  assert.notEqual(a.file.encryption!.iv, b.file.encryption!.iv);
});

test("quick backup: the file name uses .txt because Android browsers refuse to share .json", async () => {
  const h = await shop();
  const b = await quickBackup(await loadLedger(h.store), await makeBackupKey(PASS, { iterations: FAST, now: NOW }), { now: NOW });
  assert.match(b.name, /^nsalek-backup-2026-11-22-\d{4}\.txt$/);
});

test("quick backup: all real notebooks are included, the demo notebook is not", async () => {
  const h = await shop();
  const { workspaceId: second } = await h.run("createWorkspace", { name: "Deuxième" });
  const { workspaceId: demo } = await h.run("createWorkspace", { name: "Demo", demo: true });
  const b = await quickBackup(await loadLedger(h.store), await makeBackupKey(PASS, { iterations: FAST, now: NOW }), { now: NOW });
  assert.deepEqual([...b.file.scope.workspaceIds].sort(), [h.workspaceId, second].sort());
  assert.equal(b.file.scope.workspaceIds.includes(demo), false);
});

test("quick backup: the stored key cannot be exported and survives the IndexedDB round trip", async () => {
  const factory = new IDBFactory();
  const s1 = await openStore("qb", factory);
  const key = await makeBackupKey(PASS, { iterations: FAST, now: NOW });
  assert.equal(key.key.extractable, false);
  await s1.run("readwrite", async (tx) => tx.put("meta", { id: "app", schemaVersion: 1, deviceId: "d", activeWorkspaceId: null, backupKey: key }));
  s1.close();
  const s2 = await openStore("qb", factory);
  const stored = (await s2.run("readonly", (tx) => tx.get("meta", "app")))!.backupKey!;
  const h = await shop();
  const b = await quickBackup(await loadLedger(h.store), stored, { now: NOW });
  assert.equal((await openBackup(parseBackup(b.text), PASS)).parties[0].displayName, "Karim");
  s2.close();
});

test("quick backup: the user can check that they still remember the passphrase", async () => {
  const key = await makeBackupKey(PASS, { iterations: FAST, now: NOW });
  assert.equal(await checkPassphrase(key, PASS), true);
  assert.equal(await checkPassphrase(key, "lait-cafe-2025"), false);
});

test("quick backup: data that a restore would refuse is reported, not silently accepted", async () => {
  const h = await shop();
  const data = await loadLedger(h.store);
  data.parties = []; // the debts now point to nobody
  const b = await quickBackup(data, await makeBackupKey(PASS, { iterations: FAST, now: NOW }), { now: NOW });
  assert.equal(b.check.ok, false);
});

test("quick backup: a backup of only one notebook does not count as a full backup", async () => {
  const h = await shop();
  const { workspaceId: second } = await h.run("createWorkspace", { name: "Deuxième" });
  await h.run("createParty", { workspaceId: second, displayName: "Ali" });
  const data = await loadLedger(h.store);
  assert.equal(coversEverything(await createBackup(data, { workspaceIds: [h.workspaceId], now: NOW }), data), false);
  assert.equal(coversEverything(await createBackup(data, { now: NOW }), data), true);
});

test("restore: replacing with a one-notebook backup names the notebooks that would disappear", async () => {
  const h = await shop();
  await h.run("createWorkspace", { name: "Deuxième" });
  const data = await loadLedger(h.store);
  const file = parseBackup(serializeBackup(await createBackup(data, { workspaceIds: [h.workspaceId], now: NOW })));
  assert.deepEqual(notebooksLost(file, data), ["Deuxième"]);
  assert.deepEqual(notebooksLost(await createBackup(data, { now: NOW }), data), []);
});

// ---------------------------------------------------------------- reminders

const at = (iso: string) => new Date(iso);

test("backup reminder: nothing to lose means no reminder", async () => {
  const h = harness();
  await h.run("createWorkspace", { name: "Vide" });
  assert.equal(backupStatus(await loadLedger(h.store), null, NOW).level, "none");
  const { workspaceId: demo } = await h.run("createWorkspace", { name: "Demo", demo: true });
  await h.run("createParty", { workspaceId: demo, displayName: "Fictif" });
  assert.equal(backupStatus(await loadLedger(h.store), null, NOW).level, "none");
});

test("backup reminder: never backed up is due at once and urgent after 3 days or 10 changes", async () => {
  const h = await shop();
  const data = await loadLedger(h.store);
  assert.equal(backupStatus(data, null, NOW).level, "due");
  assert.equal(backupStatus(data, null, at("2026-11-25T10:00:01Z")).level, "urgent");
  for (let i = 0; i < 10; i++) await h.run("createParty", { workspaceId: h.workspaceId, displayName: `P${i}` });
  assert.equal(backupStatus(await loadLedger(h.store), null, NOW).level, "urgent");
});

test("backup reminder: an old backup is fine while nothing changed since", async () => {
  const h = await shop();
  const s = backupStatus(await loadLedger(h.store), "2026-11-22T10:00:01.000Z", at("2027-02-22T10:00:00Z"));
  assert.deepEqual([s.level, s.changes], ["ok", 0]);
});

test("backup reminder: unsaved changes become due after 3 days and urgent after 7", async () => {
  let now = NOW;
  const h = await basic(undefined, () => now);
  const saved = "2026-11-22T12:00:00.000Z";
  now = at("2026-11-22T13:00:00Z");
  await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(500), date: "2026-11-22" });
  const data = await loadLedger(h.store);
  assert.deepEqual(backupStatus(data, saved, at("2026-11-23T12:00:00Z")), { level: "ok", changes: 1, days: 1 });
  assert.equal(backupStatus(data, saved, at("2026-11-25T12:00:00Z")).level, "due");
  assert.equal(backupStatus(data, saved, at("2026-11-29T12:00:00Z")).level, "urgent");
});

test("backup reminder: many changes make it due the same day", async () => {
  let now = NOW;
  const h = await basic(undefined, () => now);
  now = at("2026-11-22T13:00:00Z");
  for (let i = 0; i < 20; i++) await h.run("createParty", { workspaceId: h.workspaceId, displayName: `P${i}` });
  assert.equal(backupStatus(await loadLedger(h.store), "2026-11-22T12:00:00.000Z", at("2026-11-22T14:00:00Z")).level, "due");
});

// ---------------------------------------------------------------- delivery

const err = (name: string) => Object.assign(new Error(name), { name });
function phone(share: () => Promise<void>, canShare = true) {
  const downloads: string[] = [];
  const shared: File[] = [];
  return {
    downloads,
    shared,
    deps: {
      nav: {
        canShare: () => canShare,
        share: async (d: { files?: File[] }) => {
          await share();
          shared.push(...(d.files ?? []));
        },
      },
      download: (name: string) => void downloads.push(name),
    },
  };
}

test("delivery: the share sheet receives a text file", async () => {
  const p = phone(async () => {});
  assert.equal(await deliverBackup("b.txt", "{}", "share", p.deps), "shared");
  assert.deepEqual([p.shared[0].name, p.shared[0].type, await p.shared[0].text()], ["b.txt", "text/plain", "{}"]);
  assert.equal(p.downloads.length, 0);
});

test("delivery: closing the share sheet is not a backup", async () => {
  const p = phone(async () => {
    throw err("AbortError");
  });
  assert.equal(await deliverBackup("b.txt", "{}", "share", p.deps), "cancelled");
  assert.equal(p.downloads.length, 0);
});

test("delivery: when the browser wants a fresh tap, the prepared file is kept for it", async () => {
  const p = phone(async () => {
    throw err("NotAllowedError");
  });
  assert.equal(await deliverBackup("b.txt", "{}", "share", p.deps), "tap_again");
});

test("delivery: without a share sheet, or when it breaks, the file is downloaded", async () => {
  const none = phone(async () => {}, false);
  assert.equal(await deliverBackup("b.txt", "{}", "share", none.deps), "downloaded");
  const broken = phone(async () => {
    throw err("DataError");
  });
  assert.equal(await deliverBackup("b.txt", "{}", "share", broken.deps), "downloaded");
  const chosen = phone(async () => {});
  assert.equal(await deliverBackup("b.txt", "{}", "download", chosen.deps), "downloaded");
  assert.deepEqual([none.downloads, broken.downloads, chosen.downloads], [["b.txt"], ["b.txt"], ["b.txt"]]);
});

test("daily notification: an urgent backup is mentioned, without names or amounts", () => {
  assert.equal(genericNotification("fr", 2).body.includes("sauvegarde"), false);
  assert.match(genericNotification("fr", 2, true).body, /2 élément.*sauvegarde/);
  assert.match(genericNotification("ar", 0, true).body, /^بياناتك بدون نسخة/);
  assert.equal(/\d/.test(genericNotification("en", 0, true).body), false);
});
