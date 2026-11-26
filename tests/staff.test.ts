// Staff mode: an employee records, the owner corrects. Enforced by the command engine, read from the
// phone's own settings inside each command's transaction.
import test from "node:test";
import assert from "node:assert/strict";
import { loadLedger } from "../lib/core/restore.ts";
import { STAFF_COMMANDS } from "../lib/core/staff.ts";
import { basic, DA } from "./helpers.ts";

async function shopWithStaff() {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(1_000), date: "2026-11-01" });
  await h.store.run("readwrite", async (tx) => tx.put("meta", { id: "app", schemaVersion: 1, deviceId: "d", activeWorkspaceId: h.workspaceId, staffMode: true }));
  return { ...h, obligationId };
}

test("staff: records people, debts, repayments, cash and reminders, marked as staff", async () => {
  const h = await shopWithStaff();
  const w = h.workspaceId;
  const { partyId } = await h.run("createParty", { workspaceId: w, displayName: "Nouveau client" });
  await h.run("createObligation", { workspaceId: w, partyId, direction: "receivable", currency: "DZD", principal: DA(500), date: "2026-11-22" });
  await h.run("recordPayment", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(200), date: "2026-11-22" });
  await h.run("addCashEntry", { workspaceId: w, kind: "sale", amount: DA(300) });
  const data = await loadLedger(h.store);
  const mine = data.audit.filter((e) => e.actor === "staff").map((e) => e.action);
  assert.ok(mine.includes("party.create") && mine.includes("payment.post") && mine.includes("cash.add"), mine.join(","));
  assert.equal(data.obligations.find((o) => o.partyId === partyId)!.createdBy, "staff");
});

test("staff: corrections, cancellations, merges, imports, settings and notebooks are refused", async () => {
  const h = await shopWithStaff();
  const w = h.workspaceId;
  const refused: [string, Record<string, unknown>][] = [
    ["voidObligation", { obligationId: h.obligationId, reason: "x" }],
    ["adjustObligation", { obligationId: h.obligationId, type: "waiver", amount: DA(100), reason: "x" }],
    ["replaceObligation", { obligationId: h.obligationId, changes: { principal: DA(1) }, reason: "x" }],
    ["updateParty", { partyId: h.partyId, changes: { displayName: "Autre" } }],
    ["archiveParty", { partyId: h.partyId, archived: true }],
    ["mergeParties", { keepId: h.partyId, mergeId: h.partyId }],
    ["updateWorkspace", { workspaceId: w, changes: { name: "x" } }],
    ["createWorkspace", { name: "x" }],
    ["archiveWorkspace", { workspaceId: w }],
    ["reverseImport", { batchId: "x" }],
    ["voidCashEntry", { cashEntryId: "x", reason: "x" }],
    ["netBalances", { workspaceId: w, partyId: h.partyId }],
  ];
  for (const [type, payload] of refused) await assert.rejects(h.run(type, payload), /staff_not_allowed/, type);
  // Nothing changed.
  const data = await loadLedger(h.store);
  assert.equal(data.obligations[0].state, "posted");
  assert.equal(data.parties[0].displayName, "Karim");
});

test("staff: saying 'owner' does not get round it; leaving staff mode gives everything back", async () => {
  const h = await shopWithStaff();
  const { execute } = await import("../lib/core/commands.ts");
  await assert.rejects(execute(h.store, { id: "cmd_owner_claim", type: "voidObligation", payload: { obligationId: h.obligationId, reason: "x" }, actor: "owner" }), /staff_not_allowed/);
  await h.store.run("readwrite", async (tx) => tx.put("meta", { ...(await tx.get("meta", "app"))!, staffMode: false }));
  await h.run("voidObligation", { obligationId: h.obligationId, reason: "typed twice" });
  assert.equal((await loadLedger(h.store)).obligations[0].state, "voided");
});

test("staff: the list of what staff may do holds no correction or removal", () => {
  for (const c of STAFF_COMMANDS) assert.doesNotMatch(c, /void|reverse|adjust|replace|merge|archive|remove|delete|import|workspace|net|update(?!Reminder)/i, c);
});
