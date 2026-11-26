// The balance link: the person's own figures, inside the link, nothing on a server.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeSnapshot, encodeSnapshot, makeSnapshot } from "../lib/core/balanceLink.ts";
import { buildIndex } from "../lib/core/ledger.ts";
import { loadLedger } from "../lib/core/restore.ts";
import { basic, DA, TODAY } from "./helpers.ts";

async function shop() {
  const h = await basic();
  const w = h.workspaceId;
  await h.run("createObligation", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01" });
  await h.run("recordPayment", { workspaceId: w, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(2_500), date: "2026-11-05" });
  await h.run("createObligation", { workspaceId: w, partyId: h.partyId, direction: "payable", currency: "DZD", principal: DA(700), date: "2026-11-06" });
  const { partyId: other } = await h.run("createParty", { workspaceId: w, displayName: "Autre client" });
  await h.run("createObligation", { workspaceId: w, partyId: other, direction: "receivable", currency: "DZD", principal: DA(99_999), date: "2026-11-02" });
  const data = await loadLedger(h.store);
  const idx = buildIndex(data, w);
  return { h, idx, ws: data.workspaces[0], party: idx.party.get(h.partyId)! };
}

test("balance link: the person's balance and lines, never another person's", async () => {
  const { idx, ws, party } = await shop();
  const s = makeSnapshot(idx, party, ws, TODAY, "fr");
  assert.equal(s.name, "Karim");
  assert.equal(s.parts.length, 1);
  assert.deepEqual([s.parts[0].owed, s.parts[0].owe], [DA(7_500), DA(700)]);
  assert.deepEqual(s.parts[0].r.map((r) => [r.k, r.a, r.b]), [["obligation", DA(10_000), DA(10_000)], ["payment", -DA(2_500), DA(7_500)]]);
  assert.ok(!JSON.stringify(s).includes("Autre client") && !JSON.stringify(s).includes(String(DA(99_999))));
});

test("balance link: it goes and comes back the same, short enough for a message", async () => {
  const { h, idx, ws, party } = await shop();
  for (let i = 0; i < 40; i++) await h.run("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(10), date: "2026-11-10" });
  const full = buildIndex(await loadLedger(h.store), h.workspaceId);
  const s = makeSnapshot(full, full.party.get(party.id)!, ws, TODAY, "ar", 20);
  assert.equal(s.parts[0].r.length, 20, "only the latest lines");
  const code = await encodeSnapshot(s);
  assert.ok(code.length < 1500, `${code.length} characters`);
  assert.match(code, /^z[A-Za-z0-9_-]+$/, "nothing a link would cut or the server would see");
  assert.deepEqual(await decodeSnapshot(code), s);
  void idx;
});

test("balance link: a cut, changed or made-up link shows nothing", async () => {
  const { idx, ws, party } = await shop();
  const code = await encodeSnapshot(makeSnapshot(idx, party, ws, TODAY, "en"));
  assert.equal(await decodeSnapshot(code.slice(0, code.length - 12)), null);
  assert.equal(await decodeSnapshot("z" + "A".repeat(40)), null);
  assert.equal(await decodeSnapshot("<script>"), null);
  const bad = { v: 1, shop: "x", name: "y", at: "2026-11-22", lang: "en", parts: [{ c: "DZD", owed: 1.5, owe: 0, r: [], p: [] }] };
  const raw = Buffer.from(JSON.stringify(bad)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(await decodeSnapshot("j" + raw), null, "an amount that is not whole minor units");
  for (const c of ["X", "", "ZZZ"]) {
    const odd = { ...bad, parts: [{ c, owed: 1, owe: 0, r: [], p: [] }] };
    const enc = Buffer.from(JSON.stringify(odd)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.equal(await decodeSnapshot("j" + enc), null, `currency "${c}"`);
  }
});

test("balance link: money paid ahead shows as the person's credit", async () => {
  const { h, ws } = await shop();
  const { partyId } = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Client d'avance" });
  await h.run("recordPayment", { workspaceId: h.workspaceId, partyId, direction: "receivable", currency: "DZD", amount: DA(3_000), date: "2026-11-10", allowAdvance: true });
  const idx = buildIndex(await loadLedger(h.store), h.workspaceId);
  const s = makeSnapshot(idx, idx.party.get(partyId)!, ws, TODAY, "fr");
  assert.deepEqual([s.parts[0].owed, s.parts[0].cr], [0, DA(3_000)]);
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(s)), s);
});
