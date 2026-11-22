// Deterministic typed-sentence → draft parser (no AI, no network). It only proposes a draft;
// every uncertain field is flagged and the person reviews before anything is saved.
import { addDays } from "./dates.ts";
import { normalizeDigits, parseAmount } from "./money.ts";
import { normalizeText } from "./text.ts";
import type { Direction, ISODate, Party } from "./types.ts";

export type SentenceDraft = {
  partyId: string | null;
  name: string;
  amountText: string;
  direction: Direction | null;
  date: ISODate;
  description: string;
  uncertain: ("party" | "amount" | "direction" | "date")[];
};

// Words meaning the other person owes me (they took / borrowed / bought on credit).
const OWES_ME = ["took", "borrowed", "owes me", "bought on credit", "a pris", "a emprunte", "me doit", "doit", "credit", "اخذ", "أخذ", "خذا", "تسلف", "سلفته", "عليه", "ليا عنده", "ليك", "كريدي"];
// Words meaning I owe them (I took / they lent me).
const I_OWE = ["i owe", "lent me", "i borrowed", "je dois", "m'a prete", "j'ai emprunte", "سلفني", "عليا", "عليك", "تسلفت", "اخذت منه", "أخذت منه", "dette"];

export function parseSentence(text: string, parties: Party[], today: ISODate, currency = "DZD"): SentenceDraft {
  const raw = normalizeDigits(text ?? "").trim();
  const norm = normalizeText(raw);
  const uncertain: SentenceDraft["uncertain"] = [];

  // Person: the longest known name contained in the sentence.
  let partyId: string | null = null;
  let name = "";
  const candidates = parties
    .filter((p) => !p.mergedIntoId && !p.archivedAt)
    .map((p) => ({ p, n: normalizeText(p.displayName) }))
    .filter((x) => x.n && norm.includes(x.n))
    .sort((a, b) => b.n.length - a.n.length);
  if (candidates.length) {
    partyId = candidates[0].p.id;
    name = candidates[0].p.displayName;
    if (candidates.length > 1 && candidates[1].n.length === candidates[0].n.length) uncertain.push("party");
  } else {
    const word = raw.split(/\s+/).find((w) => /^[\p{L}][\p{L}'-]+$/u.test(w) && ![...OWES_ME, ...I_OWE].some((k) => normalizeText(w) === normalizeText(k)));
    name = word ?? "";
    uncertain.push("party");
  }

  // Amount: the first number-looking token; number words are never interpreted.
  const m = raw.match(/\d[\d\s.,]*/);
  let amountText = "";
  if (m) {
    amountText = m[0].trim().replace(/[.,]$/, "");
    if (!parseAmount(amountText, currency).ok) uncertain.push("amount");
    // Number words change the meaning of the digits; never interpret them, always ask.
    if (/(million|milliard|mille|alf|melyoun|k|مليون|مليار|الف|ألف|آلاف|مية)/i.test(norm)) uncertain.push("amount");
  } else uncertain.push("amount");

  // Direction: I_OWE is checked first because it contains longer, more specific phrases.
  const has = (list: string[]) => list.some((k) => norm.includes(normalizeText(k)));
  let direction: Direction | null = null;
  if (has(I_OWE)) direction = "payable";
  else if (has(OWES_ME)) direction = "receivable";
  if (!direction || (has(I_OWE) && has(OWES_ME))) uncertain.push("direction");

  // Date words.
  let date = today;
  if (/(yesterday|hier|امس|البارح|البارحه)/.test(norm)) date = addDays(today, -1);
  else if (!/(today|aujourd|اليوم|ليوم)/.test(norm) && /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|الاحد/.test(norm))
    uncertain.push("date");

  return { partyId, name, amountText, direction, date, description: raw.slice(0, 200), uncertain };
}
