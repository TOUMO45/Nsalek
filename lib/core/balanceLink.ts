// A link that shows a person their own balance, without any server: the figures travel inside the
// link, after "#", which the browser never sends anywhere. It is a picture of one day, not a live
// view, and it holds only this person's lines.
import { buildStatement, partyBalance, type LedgerIndex } from "./ledger.ts";
import { isCurrency, type Lang } from "./money.ts";
import type { ISODate, Party, Workspace } from "./types.ts";

export type BalanceRow = { d: ISODate; k: string; a: number; b: number };
/** owed / owe: what the person owes the shop / the shop owes them; cr / cp: money paid ahead, not used yet (the person's credit with the shop / the shop's with them). */
export type BalancePart = { c: string; owed: number; owe: number; cr?: number; cp?: number; r: BalanceRow[]; p: BalanceRow[] };
export type BalanceSnapshot = { v: 1; shop: string; name: string; at: ISODate; lang: Lang; parts: BalancePart[] };

/** The person's balance per currency and their latest lines (each side), as of `today`. */
export function makeSnapshot(idx: LedgerIndex, party: Party, ws: Workspace, today: ISODate, lang: Lang, maxRows = 20): BalanceSnapshot {
  const parts: BalancePart[] = [];
  for (const [c, b] of partyBalance(idx, party.id, today)) {
    const st = buildStatement(idx, party.id, c, "0000-01-01", today);
    const rows = (dir: "receivable" | "payable") =>
      (st.sections.find((s) => s.direction === dir)?.rows ?? []).slice(-maxRows).map((r) => ({ d: r.date, k: r.kind, a: r.delta, b: r.balance }));
    const part = { c, owed: b.receivable, owe: b.payable, cr: b.advanceReceived, cp: b.advancePaid, r: rows("receivable"), p: rows("payable") };
    if (part.owed || part.owe || part.cr || part.cp || part.r.length || part.p.length) parts.push(part);
  }
  return { v: 1, shop: (ws.business?.name || ws.name).slice(0, 80), name: party.displayName.slice(0, 120), at: today, lang, parts };
}

async function through(bytes: Uint8Array<ArrayBuffer>, stream: GenericTransformStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>)).arrayBuffer());
}

const toB64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

/** "z" + gzip, or "j" + plain JSON where the browser cannot compress. */
export async function encodeSnapshot(s: BalanceSnapshot): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(s)) as Uint8Array<ArrayBuffer>;
  if (typeof CompressionStream === "undefined") return "j" + toB64url(raw);
  return "z" + toB64url(await through(raw, new CompressionStream("gzip")));
}

const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const rowOk = (r: unknown) => {
  const x = r as BalanceRow;
  return !!x && date(x.d) && str(x.k, 20) && int(x.a) && int(x.b);
};

/** null for anything that is not a well-formed snapshot: a link cut by an app, or made up. */
export async function decodeSnapshot(code: string): Promise<BalanceSnapshot | null> {
  if (!/^[zj][A-Za-z0-9_-]{4,20000}$/.test(code)) return null;
  try {
    let bytes = fromB64url(code.slice(1));
    if (code[0] === "z") bytes = await through(bytes, new DecompressionStream("gzip"));
    const s = JSON.parse(new TextDecoder().decode(bytes)) as BalanceSnapshot;
    const ok =
      s?.v === 1 &&
      str(s.shop, 80) &&
      str(s.name, 120) &&
      date(s.at) &&
      ["ar", "fr", "en"].includes(s.lang) &&
      Array.isArray(s.parts) &&
      s.parts.length <= 10 &&
      s.parts.every(
        (p) =>
          typeof p.c === "string" &&
          isCurrency(p.c) &&
          int(p.owed) &&
          int(p.owe) &&
          (p.cr === undefined || int(p.cr)) &&
          (p.cp === undefined || int(p.cp)) &&
          Array.isArray(p.r) &&
          Array.isArray(p.p) &&
          p.r.length <= 50 &&
          p.p.length <= 50 &&
          p.r.every(rowOk) &&
          p.p.every(rowOk),
      );
    return ok ? s : null;
  } catch {
    return null;
  }
}

export const balanceUrl = (origin: string, code: string) => `${origin}/#/b/${code}`;
