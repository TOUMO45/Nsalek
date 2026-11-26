// Contacts from the phone: a .vcf file (every phone's contacts app can export one), or the
// browser's contact picker (Chrome on Android). Read only; nothing is sent anywhere.
import { normalizePhone, normalizeText, phoneKey } from "./text.ts";
import type { Party } from "./types.ts";

export type Contact = { name: string; phones: string[]; email: string };

/** Quoted-printable bytes (older Android exports) read as UTF-8. */
function fromQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const unescape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** All contacts of a vCard file (versions 2.1, 3.0 and 4.0), in file order. */
export function parseVcf(text: string): Contact[] {
  // Unfold: a line that starts with a space or a tab continues the previous one; in quoted-
  // printable, a line ending with "=" continues on the next.
  const raw = text.replace(/\r\n|\r/g, "\n");
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const last = lines.length - 1;
    if (last >= 0 && /^[ \t]/.test(line)) lines[last] += line.slice(1);
    else if (last >= 0 && /ENCODING=QUOTED-PRINTABLE/i.test(lines[last]) && lines[last].endsWith("=")) lines[last] = lines[last].slice(0, -1) + line;
    else lines.push(line);
  }
  const out: Contact[] = [];
  let cur: { fn: string; n: string; phones: string[]; email: string } | null = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const params = head.split(";");
    const key = params[0].replace(/^item\d+\./i, "").toUpperCase();
    let value = line.slice(colon + 1);
    if (params.some((p) => /^ENCODING=QUOTED-PRINTABLE$/i.test(p))) value = fromQuotedPrintable(value);
    if (key === "BEGIN" && value.trim().toUpperCase() === "VCARD") cur = { fn: "", n: "", phones: [], email: "" };
    else if (!cur) continue;
    else if (key === "END") {
      const name = cur.fn || cur.n;
      if (name || cur.phones.length) out.push({ name: name.slice(0, 120), phones: [...new Set(cur.phones)].slice(0, 5), email: cur.email });
      cur = null;
    } else if (key === "FN") cur.fn = unescape(value);
    else if (key === "N" && !cur.n) {
      // Family;Given;Middle;Prefix;Suffix → "Given Middle Family"
      const [family = "", given = "", middle = ""] = value.split(/(?<!\\);/).map(unescape);
      cur.n = [given, middle, family].filter(Boolean).join(" ");
    } else if (key === "TEL") {
      const tel = unescape(value).replace(/^tel:/i, "");
      if (tel) cur.phones.push(tel);
    } else if (key === "EMAIL" && !cur.email) cur.email = unescape(value);
  }
  return out;
}

/** What the browser's contact picker gives (each field is a list). */
export function fromPicker(list: { name?: string[]; tel?: string[]; email?: string[] }[]): Contact[] {
  return list
    .map((c) => ({ name: (c.name?.[0] ?? "").trim().slice(0, 120), phones: [...new Set((c.tel ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 5), email: (c.email?.[0] ?? "").trim() }))
    .filter((c) => c.name || c.phones.length);
}

export type ContactRow = Contact & { key: string; phonesE164: string[]; duplicates: Party[]; problem: "no_name" | null };

/**
 * One row per contact, with the people already in the notebook that look the same (same name or
 * same number: the same rule as when a person is created) and the same contact twice in the file
 * folded into one. The notebook is indexed once, so a thousand contacts against a thousand people
 * stays instant. Nothing is created here.
 */
export function planContacts(contacts: Contact[], parties: Party[], country = "DZ"): ContactRow[] {
  const byName = new Map<string, Party[]>();
  const byPhone = new Map<string, Party[]>();
  const push = (m: Map<string, Party[]>, k: string, p: Party) => (m.get(k) ?? m.set(k, []).get(k)!).push(p);
  for (const p of parties) {
    if (p.mergedIntoId) continue;
    const n = normalizeText(p.displayName);
    if (n) push(byName, n, p);
    for (const ph of p.phones) {
      const k = phoneKey(ph);
      if (k.length >= 8) push(byPhone, k, p);
    }
  }
  const rows: ContactRow[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    const phonesE164 = [...new Set(c.phones.map((p) => normalizePhone(p, country)?.value).filter((v): v is string => !!v))].slice(0, 5);
    const key = `${c.name.trim().toLowerCase()}|${phonesE164.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dup = new Set<Party>(byName.get(normalizeText(c.name)) ?? []);
    for (const ph of phonesE164) {
      const k = phoneKey(ph);
      if (k.length >= 8) for (const p of byPhone.get(k) ?? []) dup.add(p);
    }
    rows.push({ ...c, key, phonesE164, duplicates: [...dup], problem: c.name.trim() ? null : "no_name" });
  }
  return rows;
}
