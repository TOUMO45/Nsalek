// Spoken sentence → debt or repayment (Darija, French, English). Deterministic: no AI, no network.
// The result lists every doubt in `issues`; the app may save without a tap only when there is none.
//
// Amounts: Algerians often count in centimes ("عشرين ألف" can be 20 000 DA or 200 DA), so a number
// without a spoken unit is settled only by the user's own setting, never by a guess.
import { addDays } from "./dates.ts";
import { partyBalance, type LedgerIndex } from "./ledger.ts";
import { exponentOf, isPositiveMinor, normalizeDigits } from "./money.ts";
import { normalizeText } from "./text.ts";
import type { CurrencyCode, Direction, ISODate, Minor } from "./types.ts";

export type VoiceUnit = "ask" | "dinar" | "centime";

export type VoiceContext = {
  idx: LedgerIndex;
  today: ISODate;
  currency: CurrencyCode;
  unit: VoiceUnit;
  /** Spoken name (normalized) → person, remembered after the user confirmed it once. */
  aliases: Record<string, string>;
};

export type VoiceIssue =
  | "nothing"
  | "negation"
  | "future"
  | "kind"
  | "direction"
  | "party"
  | "party_new"
  | "party_check"
  | "amount"
  | "amount_unit"
  | "amount_heard"
  | "no_balance"
  | "overpayment"
  | "date"
  | "words";

export type VoiceIntent = {
  transcript: string;
  kind: "debt" | "payment" | "balance" | null;
  direction: Direction | null;
  partyId: string | null;
  /** People this could be, best first (for "party" and "party_check"). */
  candidates: string[];
  spokenName: string;
  spokenKey: string;
  currency: CurrencyCode;
  /** The settled amount, or null while `amounts` holds the choices. */
  amount: Minor | null;
  amounts: Minor[];
  /** "He paid everything": the amount is the open balance. */
  full: boolean;
  date: ISODate;
  issues: VoiceIssue[];
};

// ---------------------------------------------------------------- tokens

type Token = { raw: string; norm: string };

function tokenize(text: string): Token[] {
  const clean = normalizeDigits(text ?? "")
    .replace(/[’`]/g, "'")
    .replace(/د\s?\.\s?ج\.?/g, " دج ");
  return (clean.match(/\d+(?:[.,]\d+)*|[\p{L}\p{M}']+|[€$]/gu) ?? []).map((raw) => ({ raw, norm: normalizeText(raw) }));
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).map(normalizeText);
/** "على" (on) and the name "علي" normalize to the same letters; only the raw spelling tells them apart. */
const isOn = (t: Token) => t.raw === "على";

// ---------------------------------------------------------------- numbers

type Num = { type: "small" | "fixed" | "hundred" | "scale" | "double"; v: number; doubtful?: boolean };
const NUM = new Map<string, Num>();
const num = (type: Num["type"], v: number, list: string, doubtful = false) => {
  for (const w of words(list)) NUM.set(w, { type, v, doubtful });
};

const SMALL: [number, string][] = [
  [1, "واحد un une one"],
  [2, "زوج جوج زوز اثنين اتنين ثنين تنين اثنان deux two"],
  [3, "ثلاثة تلاتة ثلاث تلات تلت ثلت تلاتا trois three"],
  [4, "أربعة ربعة أربع ربع quatre four"],
  [5, "خمسة خمس cinq five"],
  [6, "ستة ست six"],
  [7, "سبعة سبع sept seven"],
  [8, "ثمانية تمانية ثمنية تمنية ثماني تماني huit eight"],
  [9, "تسعة تسع neuf nine"],
  [10, "عشرة عشر dix ten"],
  [11, "حداش احداش حداعش إحداش onze eleven"],
  [12, "طناش اطناش ثناش تناش اثناش douze twelve"],
  [13, "تلطاش ثلطاش تلتاش ثلاثطاش تلاتاش treize thirteen"],
  [14, "ربعطاش اربعطاش ربعتاش quatorze fourteen"],
  [15, "خمسطاش خمستاش quinze fifteen"],
  [16, "سطاش ستاش سطعش seize sixteen"],
  [17, "سبعطاش سبعتاش seventeen"],
  [18, "تمنطاش ثمنطاش تمنتاش ثمنتاش eighteen"],
  [19, "تسعطاش تسعتاش nineteen"],
  [20, "عشرين عشرون vingt vingts twenty"],
  [30, "ثلاثين تلاتين ثلاثون trente thirty"],
  [40, "أربعين ربعين أربعون quarante forty"],
  [50, "خمسين خمسون cinquante fifty"],
  [60, "ستين ستون soixante sixty"],
  [70, "سبعين سبعون seventy"],
  [80, "ثمانين تمانين ثمانون eighty"],
  [90, "تسعين تسعون ninety"],
];
for (const [v, list] of SMALL) num("small", v, list);
// "ثمن / تمن" also means "price" ("بثمن مية دينار"), so it is doubtful as a multiplier of hundreds.
num("small", 8, "ثمن تمن", true);
const HUNDRED = "مية مئة مائة ميا ميات ميت".split(" ");
num("hundred", 100, HUNDRED.join(" ") + " cent cents hundred");
num("fixed", 200, "ميتين مئتين مائتين ميتان مئتان");
const STEMS: [number, string][] = [
  [3, "ثلاث تلات تلت ثلت ثلث تلث"],
  [4, "أربع ربع"],
  [5, "خمس"],
  [6, "ست"],
  [7, "سبع"],
  [8, "ثمن تمن ثمان تمان ثماني"],
  [9, "تسع"],
];
for (const [v, list] of STEMS) for (const stem of list.split(" ")) num("fixed", v * 100, HUNDRED.map((h) => stem + h).join(" "));
num("scale", 1000, "ألف آلاف الاف لاف تالاف تلاف mille thousand");
num("double", 2000, "ألفين الفان");
num("scale", 1_000_000, "مليون ملاين ملايين million millions");
num("double", 2_000_000, "مليونين");
num("scale", 1_000_000_000, "مليار ملاير ملايير milliard milliards billion");
const HALF = new Set(words("نص نصف demi demie half"));
const QUARTER = normalizeText("ربع");
const JOIN = new Set(words("و et and"));
const MINUS = normalizeText("إلا");

type Unit = "dinar" | "centime" | "EUR" | "USD" | "unclear";
const UNIT = new Map<string, Unit>();
for (const [u, list] of [
  ["dinar", "دينار دنانير دينارات دج dinar dinars da dzd"],
  ["centime", "سنتيم سنتيمات صنتيم فرنك فرانك centime centimes"],
  ["EUR", "أورو يورو euro euros €"],
  ["USD", "دولار دولارات dollar dollars $"],
  // 5 centimes each, but used for very different amounts: never converted.
  ["unclear", "دورو دوروات ريال ريالات douro douros rial"],
] as [Unit, string][])
  for (const w of words(list)) UNIT.set(w, u);

/** A number word, possibly glued to "و" (and) or "ب" (for): "وخمسين", "بمية". */
function numberWord(t: Token | undefined): (Num & { and: boolean; norm: string }) | null {
  if (!t) return null;
  const direct = NUM.get(t.norm);
  if (direct) return { ...direct, and: false, norm: t.norm };
  const rest = t.norm.slice(1);
  const glued = NUM.get(rest);
  if (glued && (t.norm[0] === "و" || t.norm[0] === "ب")) return { ...glued, and: t.norm[0] === "و", norm: rest };
  return null;
}
const isDigits = (t: Token | undefined) => !!t && /^\d/.test(t.norm);
const isNumber = (t: Token | undefined) => isDigits(t) || !!numberWord(t);

export type SpokenAmount = { value: number; unit: Exclude<Unit, "unclear"> | null; million: boolean; unclear: boolean; from: number; to: number };

function readDigits(tokens: Token[], i: number): { value: number; unclear: boolean; next: number } {
  let s = tokens[i].norm;
  let next = i + 1;
  // "5 000": groups of exactly three digits after one to three digits.
  if (/^\d{1,3}$/.test(s))
    while (tokens[next] && /^\d{3}$/.test(tokens[next].norm)) s += tokens[next++].norm;
  if (/^0\d/.test(s)) return { value: Number(s.replace(/\D/g, "")), unclear: true, next }; // a phone number or a code
  if (/^\d+$/.test(s)) return { value: Number(s), unclear: false, next };
  if (/^\d+[.,]\d{1,2}$/.test(s)) return { value: Number(s.replace(",", ".")), unclear: false, next };
  return { value: Number(s.replace(/[.,]/g, "")), unclear: true, next }; // "5,000": thousands or decimals?
}

function readAmount(tokens: Token[], start: number): SpokenAmount {
  let total = 0;
  let current = 0;
  let lastScale = Infinity;
  let scaled = false;
  let million = false;
  let unclear = false;
  let and = false;
  let i = start;
  let previous: Num | null = null;
  for (; i < tokens.length; ) {
    const t = tokens[i];
    if (i > start && JOIN.has(t.norm) && (isNumber(tokens[i + 1]) || HALF.has(tokens[i + 1]?.norm ?? ""))) {
      and = true;
      i++;
      continue;
    }
    if (i > start && t.norm === MINUS && isNumber(tokens[i + 1])) {
      unclear = true;
      i++;
      continue;
    }
    const half = HALF.has(t.norm) ? and : t.norm[0] === "و" && HALF.has(t.norm.slice(1));
    if (i > start && half) {
      if (scaled && current === 0) total += lastScale / 2;
      else unclear = true;
      i++;
      and = false;
      continue;
    }
    if (isDigits(t)) {
      if (current !== 0) break;
      const d = readDigits(tokens, i);
      current = d.value;
      unclear ||= d.unclear;
      i = d.next;
      and = false;
      previous = null;
      continue;
    }
    const n = numberWord(t);
    if (!n) break;
    const joined = and || n.and;
    and = false;
    const rest = current % 100;
    if (n.type === "small") {
      // "مليون وربع": a quarter or a four? Clear only when it multiplies something ("وربع مية").
      if (n.norm === QUARTER && joined && numberWord(tokens[i + 1])?.type !== "hundred" && numberWord(tokens[i + 1])?.type !== "scale") unclear = true;
      if (rest === 0) current += n.v;
      else if (n.v === 20 && rest === 4 && /^vingts?$/.test(n.norm)) current += 76; // quatre-vingt
      else if (n.v >= 20 && rest < 10 && joined) current += n.v; // خمسة وعشرين
      else if (n.v >= 10 && n.v < 20 && (rest === 60 || rest === 80)) current += n.v; // soixante-dix
      else if (n.v < 10 && rest >= 20 && rest % 10 === 0) current += n.v; // vingt-cinq
      else {
        unclear = true;
        current += n.v;
      }
    } else if (n.type === "hundred") {
      if (current === 0) current = 100;
      else if (current < 10) {
        if (previous?.doubtful) unclear = true;
        current *= 100;
      } else unclear = true;
    } else if (n.type === "fixed") {
      if (current !== 0) unclear = true;
      current += n.v;
    } else {
      const scale = n.type === "double" ? n.v / 2 : n.v;
      if (scale >= lastScale || (n.type === "double" && current !== 0)) unclear = true;
      total += n.type === "double" ? n.v : (current || 1) * scale;
      current = 0;
      lastScale = scale;
      scaled = true;
      million ||= scale >= 1_000_000;
    }
    previous = n;
    i++;
  }
  const spokenUnit = UNIT.get(tokens[i]?.norm ?? "") ?? null;
  if (spokenUnit) i++;
  if (spokenUnit === "unclear") unclear = true;
  return { value: total + current, unit: spokenUnit === "unclear" ? null : spokenUnit, million, unclear, from: start, to: i };
}

function amountsIn(tokens: Token[]): SpokenAmount[] {
  const out: SpokenAmount[] = [];
  for (let i = 0; i < tokens.length; ) {
    if (!isNumber(tokens[i])) {
      i++;
      continue;
    }
    const a = readAmount(tokens, i);
    const scaled = tokens.slice(a.from, a.to).some((t) => ["scale", "double"].includes(numberWord(t)?.type ?? ""));
    // "زوج خبزات", "un client": a small count without a currency is not an amount.
    if (a.value > 0 && (a.unclear || a.unit || scaled || a.value >= 10)) out.push(a);
    i = Math.max(a.to, i + 1);
  }
  return out;
}

export function spokenAmounts(text: string): SpokenAmount[] {
  return amountsIn(tokenize(text));
}

/** From 5 000 000 DA, the amount is confirmed even when the unit was spoken. */
const CONFIRM_FROM = 500_000_000;

type Resolved = { currency: CurrencyCode; options: Minor[]; unclear: boolean };

function resolve(a: SpokenAmount, ctx: VoiceContext): Resolved {
  const currency = a.unit === "EUR" || a.unit === "USD" ? a.unit : ctx.currency;
  const major = Math.round(a.value * 10 ** exponentOf(currency));
  const done = (...options: number[]): Resolved => ({ currency, options, unclear: a.unclear || !options.every(isPositiveMinor) });
  if (currency !== "DZD") return a.unit === "centime" ? { currency, options: [], unclear: true } : done(major);
  const centimes = a.value;
  if (a.unit === "dinar") return done(major);
  if (a.unit === "centime") return done(centimes);
  if (ctx.unit === "centime") return a.value < 500 ? done(major, centimes) : done(centimes);
  if (a.million) return done(centimes, major);
  return ctx.unit === "dinar" ? done(major) : done(major, centimes);
}

// ---------------------------------------------------------------- verbs and markers

type Cls = "PAY_IN" | "PAY_OUT" | "PAY" | "DEBT_IN" | "LENT" | "DEBT_OUT" | "BORROWED" | "GAVE" | "WEAK_IN" | "RECORD" | "UNDO" | "CASH" | "NOT" | "LATER" | "ASK" | "FULL" | "YESTERDAY" | "OTHER_DAY" | "STOP";
const PHRASES = new Map<string, Cls>();
const phrases = (cls: Cls, ...list: string[]) => {
  for (const p of list) PHRASES.set(p.split(" ").map(normalizeText).join(" "), cls);
};
const each = (cls: Cls, list: string) => phrases(cls, ...list.split(" "));

// They paid me.
each("PAY_IN", "خلصني خلصتني خلصوني رجعلي رجعتلي رجعولي ردلي ردتلي ردولي سلكني سلكتني سلكوني دفعلي دفعتلي دفعولي خلص دفع رجع رد سلك سدد");
phrases("PAY_IN", "رجع لي", "رد لي", "دفع لي", "خلص لي", "m'a payé", "m'a remboursé", "m'a rendu", "m'a versé", "a payé", "a remboursé", "a rendu", "a versé", "paid me", "paid back", "has paid", "repaid");
// I paid them.
each("PAY_OUT", "خلصتو خلصته خلصتها خلصتهم رجعتلو رجعتله رجعتلها رديتلو رديتله رديتلها رديت سلكتو سلكته سلكتها دفعتلو دفعتله دفعتلها");
phrases("PAY_OUT", "j'ai payé", "j'ai remboursé", "j'ai rendu", "j'ai versé", "i paid", "i repaid");
// "She paid" or "I paid".
each("PAY", "خلصت دفعت رجعت سلكت سددت خلصو خلصوا دفعو دفعوا تسديد تخليص versement paiement payment paid payé");
// They took on credit, or I lent.
each("DEBT_IN", "دا دات داو ادا أدى خذا خدا خذات خدات خذاو اخذ رفد رفدو تسلف تسلفو سلفتو سلفته سلفتها سلفتلو سلفتله سلفتلها نسال نسالو نسالوا نساله نسالها نسالهم owes");
phrases("DEBT_IN", "a pris", "a emprunté", "me doit", "me doivent", "j'ai prêté", "owes me", "took", "i lent", "borrowed from me", "ليا عند", "لي عند");
each("LENT", "سلفت"); // "I lent" or, with the name first, "she lent"
// I took on credit, or they lent me.
each("DEBT_OUT", "يسالني تسالني يسالوني سلفني سلفتني سلفوني عليا خذيت خديت ديت اديت");
phrases("DEBT_OUT", "je dois", "j'ai pris", "j'ai emprunté", "m'a prêté", "i owe", "i borrowed", "i took", "lent me");
each("BORROWED", "تسلفت رفدت"); // "I borrowed" or "she borrowed": من / مني decides
// A loan or a repayment? Not said.
each("GAVE", "عطيت عطيتو عطيته عطيتها عطاني عطاتني عطاوني اعطاني أعطيت عطا عطى جاب جابت جابلي جابتلي بعث بعثت gave");
phrases("GAVE", "m'a donné", "j'ai donné", "a donné");
// Nouns that mean "credit" when no verb says otherwise.
each("WEAK_IN", "كريدي الكريدي بالكريدي كريديت عليه عليها عليهم doit crédit credit");

// Recording verbs give "على محمد" (on Mohamed) its meaning; correcting verbs take it away.
each("RECORD", "سجل سجلي سجلت قيد قيدت اكتب كتب كتبت زيد زيدي زدت حط حطي حطيت");
each("UNDO", "نقص نقصت نقصلو نحي نحيت نحيلو حيد امسح مسح مسحت محيت احذف حذفت الغي لغي لغيت بطل بطلت غلط غلطت صحح annule annuler supprime supprimer enlève retire diminue corrige erreur cancel delete remove correct undo mistake");
each("CASH", "كاش نقدا نقد comptant cash");

each("NOT", "ما مازال مازالت مازالو ماشي مشي مش موش مكانش لم لا pas jamais n'a n'ai n'ont not never hasn't haven't didn't doesn't");
each("LATER", "غدوة غدا غدوا راح رايح رايحة غادي باش demain va vais vont tomorrow will");
phrases("LATER", "من بعد");
each("ASK", "شحال قداش قداه كم combien");
phrases("ASK", "how much", "قد اش");
each("FULL", "كامل كاملة كلش كلشي tout all everything");
phrases("FULL", "كل شي", "in full");
each("YESTERDAY", "البارح البارحة أمس hier yesterday");
// Days the parser does not compute: the person picks the date.
phrases("OTHER_DAY", "أول البارح", "اول البارحة", "avant hier", "day before yesterday");
each("OTHER_DAY", "نهار يوم الشهر شهر السيمانة سيمانة الاسبوع اسبوع الجاي الجاية الماضي الماضية الفايت الفايتة semaine mois dernier dernière prochain prochaine week month last next الاثنين الاتنين الثلاثاء التلات الثلاث الاربعاء الاربعا الخميس الجمعة السبت الاحد lundi mardi mercredi jeudi vendredi samedi dimanche monday tuesday wednesday thursday friday saturday sunday");
each(
  "STOP",
  "من مني منو منه منها ل لي ليا لو له لها عند عندي عندو عنده عندها في ب بـ و تاع نتاع متاع ديال اللي هو هي انا أنا اليوم ليوم شرا شرى شرات بال " +
    "le la les l de du des d a à au aux pour chez un une et je il elle on me moi lui en sur avec aujourd'hui client cliente monsieur madame dinars " +
    "the to from for and i he she they has have my me today of in back",
);

type Mark = { cls: Cls; from: number; to: number };

function marksIn(tokens: Token[], taken: (i: number) => boolean): Mark[] {
  const out: Mark[] = [];
  for (let i = 0; i < tokens.length; ) {
    let hit: Mark | null = null;
    for (let len = 3; len >= 1 && !hit; len--) {
      if (i + len > tokens.length) continue;
      const slice = tokens.slice(i, i + len);
      if (slice.some((t, k) => isOn(t) || taken(i + k))) continue;
      const text = slice.map((t) => t.norm).join(" ");
      const cls = PHRASES.get(text) ?? (text[0] === "و" && text.length > 3 ? PHRASES.get(text.slice(1)) : undefined);
      if (cls) hit = { cls, from: i, to: i + len };
    }
    if (!hit && !taken(i) && !isOn(tokens[i]) && /^ما.{2,}ش$/.test(tokens[i].norm)) hit = { cls: "NOT", from: i, to: i + 1 }; // ماخلصنيش
    if (hit) out.push(hit);
    i = hit ? hit.to : i + 1;
  }
  return out;
}

// ---------------------------------------------------------------- people

const AR: Record<string, string> = {
  ب: "b", پ: "b", ت: "t", ث: "t", ج: "j", ح: "h", خ: "x", د: "d", ذ: "d", ر: "r", ز: "z", س: "s", ش: "S", ص: "s", ض: "d", ط: "t", ظ: "d", غ: "G", ف: "f", ڤ: "f", ق: "k", ڨ: "k", گ: "k", ك: "k", ل: "l", م: "m", ن: "n", ه: "h",
};

function wordSound(word: string): string {
  let out = "";
  if (/\p{Script=Arabic}/u.test(word)) {
    const w = word.normalize("NFKD").replace(/\p{M}/gu, "");
    [...w].forEach((c, i) => {
      if (i === 0 && c === "و") out += "w";
      else if (i === 0 && c === "ي") out += "y";
      else out += AR[c] ?? "";
    });
  } else {
    let w = normalizeText(word).replace(/[^a-z]/g, "");
    if (/^ou[aeiy]/.test(w) || w[0] === "w") out += "w";
    else if (w[0] === "y") out += "y";
    w = w
      .replace(/kh/g, "X")
      .replace(/gh/g, "Q")
      .replace(/ch|sh/g, "C")
      .replace(/dj/g, "j")
      .replace(/ph/g, "f")
      .replace(/([td])h/g, "$1")
      .replace(/c(?=[eiy])/g, "s")
      .replace(/[aeiouyw]/g, "");
    for (const c of w) out += { X: "x", Q: "G", C: "S", c: "k", q: "k", g: "k", p: "b", v: "f", x: "ks" }[c] ?? c;
  }
  out = out.replace(/(.)\1+/g, "$1");
  return out.length > 1 ? out.replace(/h$/, "") : out; // final ة / h is not pronounced
}

/** Consonants of a name, comparable across Arabic and Latin spelling ("كريم" = "Karim"). */
export function soundKey(name: string): string {
  return (name.match(/[\p{L}\p{M}]+/gu) ?? []).map(wordSound).join("");
}

type Match = { partyId: string; from: number; to: number; sure: boolean };

/** "لمحمد", "ومحمد" → "محمد". */
const unglued = (t: Token): Token | null => (/^[لو]./.test(t.norm) && t.norm.length > 3 ? { raw: t.raw.slice(1), norm: t.norm.slice(1) } : null);

function findPeople(tokens: Token[], free: (i: number) => boolean, ctx: VoiceContext): Match[] {
  const people = ctx.idx.parties.filter((p) => !p.mergedIntoId && !p.archivedAt).map((p) => ({ id: p.id, parts: words(p.displayName), sound: soundKey(p.displayName), first: soundKey(p.displayName.trim().split(/\s+/)[0] ?? "") }));
  const found: Match[] = [];
  for (let from = 0; from < tokens.length; from++) {
    if (isOn(tokens[from])) continue;
    for (let len = 1; len <= 4 && from + len <= tokens.length; len++) {
      const plain = tokens.slice(from, from + len);
      if (plain.some(isOn)) break;
      const stripped = unglued(plain[0]);
      for (const span of stripped ? [plain, [stripped, ...plain.slice(1)]] : [plain]) {
        const text = span.map((t) => t.norm).join(" ");
        const sound = soundKey(span.map((t) => t.raw).join(" "));
        const allFree = plain.every((_, k) => free(from + k));
        for (const p of people) {
          const push = (sure: boolean) => found.push({ partyId: p.id, from, to: from + len, sure });
          if (p.parts.length === len && p.parts.join(" ") === text) push(true);
          else if (allFree && ctx.aliases[text] === p.id) push(true);
          else if (allFree && sound.length >= 2 && sound === p.sound) push(false);
          else if (allFree && len === 1 && p.parts.length > 1 && (p.parts[0] === text || (sound.length >= 2 && sound === p.first))) push(false);
        }
      }
    }
  }
  // Longest first; a match inside a longer one ("علي" in "كريم بن علي") is dropped.
  found.sort((a, b) => b.to - b.from - (a.to - a.from) || Number(b.sure) - Number(a.sure));
  const kept: Match[] = [];
  for (const m of found) {
    if (kept.some((k) => k.partyId === m.partyId)) continue;
    if (kept.some((k) => k.to - k.from > m.to - m.from && m.from >= k.from && m.to <= k.to)) continue;
    // Same words: a sure match beats sound-alikes.
    if (!m.sure && kept.some((k) => k.sure && k.from === m.from && k.to === m.to)) continue;
    kept.push(m);
  }
  return kept;
}

function unknownName(tokens: Token[], free: (i: number) => boolean, marks: Mark[]): { name: string; from: number; to: number } | null {
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!free(i) || isDigits(tokens[i])) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === i && i - last.from < 3) last.to++;
    else runs.push({ from: i, to: i + 1 });
  }
  if (!runs.length) return null;
  const to = new Set(words("من عند ل لـ de à chez to from"));
  const verb = marks.find((m) => !["STOP", "YESTERDAY", "OTHER_DAY", "RECORD"].includes(m.cls));
  const run =
    runs.find((r) => r.from > 0 && (isOn(tokens[r.from - 1]) || to.has(tokens[r.from - 1].norm))) ?? runs.find((r) => verb && r.to === verb.from) ?? runs[0];
  return { ...run, name: tokens.slice(run.from, run.to).map((t) => t.raw).join(" ") };
}

// ---------------------------------------------------------------- understanding

function understandOne(text: string, ctx: VoiceContext): VoiceIntent {
  const transcript = (text ?? "").trim();
  const tokens = tokenize(transcript);
  const intent: VoiceIntent = { transcript, kind: null, direction: null, partyId: null, candidates: [], spokenName: "", spokenKey: "", currency: ctx.currency, amount: null, amounts: [], full: false, date: ctx.today, issues: [] };
  const issue = (i: VoiceIssue) => {
    if (!intent.issues.includes(i)) intent.issues.push(i);
  };
  if (!tokens.length) {
    issue("nothing");
    return intent;
  }

  const amounts = amountsIn(tokens);
  const inAmount = (i: number) => amounts.some((a) => i >= a.from && i < a.to);
  const marks = marksIn(tokens, inAmount);
  const has = (...cls: Cls[]) => marks.some((m) => cls.includes(m.cls));
  const marked = (i: number) => marks.some((m) => i >= m.from && i < m.to);
  const free = (i: number) => !inAmount(i) && !marked(i) && !isOn(tokens[i]) && !numberWord(tokens[i]) && !UNIT.has(tokens[i].norm);

  // Who.
  const people = findPeople(tokens, free, ctx);
  if (people.length) {
    const [best] = people;
    intent.candidates = people.map((p) => p.partyId);
    intent.spokenKey = tokens.slice(best.from, best.to).map((t) => t.norm).join(" ");
    intent.spokenName = tokens.slice(best.from, best.to).map((t) => t.raw).join(" ");
    const tied = people.length > 1;
    if (tied) issue("party");
    else {
      intent.partyId = best.partyId;
      if (!best.sure) issue("party_check");
    }
  } else {
    const unknown = unknownName(tokens, free, marks);
    if (unknown) {
      const first = tokens[unknown.from].norm[0] === "ل" ? unglued(tokens[unknown.from]) : null;
      intent.spokenName = first ? [first.raw, ...tokens.slice(unknown.from + 1, unknown.to).map((t) => t.raw)].join(" ") : unknown.name;
      intent.spokenKey = normalizeText(unknown.name);
      issue("party_new");
    } else issue("party");
  }

  // A question shows a balance and records nothing.
  if (has("ASK")) {
    intent.kind = "balance";
    return intent;
  }

  if (has("NOT")) issue("negation");
  if (has("LATER")) issue("future");
  if (has("OTHER_DAY")) issue("date");
  else if (has("YESTERDAY")) intent.date = addDays(ctx.today, -1);

  // What, and in which direction.
  const span = people[0];
  const strong = new Set<string>();
  for (const m of marks) {
    if (m.cls === "PAY_IN") strong.add("payment receivable");
    if (m.cls === "PAY_OUT") strong.add("payment payable");
    // "خلصت" is "she paid" after a name and "I paid" before it; the open balance must agree below.
    if (m.cls === "PAY") strong.add(!span ? "payment" : span.from < m.from ? "payment? receivable" : "payment? payable");
    if (m.cls === "LENT") strong.add(span && span.from < m.from ? "debt" : "debt receivable");
    if (m.cls === "DEBT_IN") strong.add("debt receivable");
    if (m.cls === "DEBT_OUT") strong.add("debt payable");
    if (m.cls === "BORROWED") {
      const after = tokens.slice(m.to).map((t) => t.norm);
      strong.add(after.includes(normalizeText("مني")) ? "debt receivable" : after.includes(normalizeText("من")) ? "debt payable" : "debt");
    }
    if (m.cls === "GAVE") strong.add("unknown");
  }
  // A precise form absorbs the vague one ("paid me … paid").
  if (strong.has("payment receivable") || strong.has("payment payable")) for (const v of strong) if (v === "payment" || v.startsWith("payment?")) strong.delete(v);
  const said = [...strong];
  let hinted: Direction | null = null;
  // A bare "credit" or "on him" is trusted only when every word before the amount is understood:
  // "Mohamed زاد عليه" or "I erased Mohamed's credit" mean something else.
  const understood = tokens.every((_, i) => marked(i) || inAmount(i) || isOn(tokens[i]) || (span && i >= span.from && i < span.to) || (amounts[0] && i >= amounts[0].to));
  const on = tokens.some(isOn) && (has("RECORD") || isOn(tokens[0]));
  if (has("UNDO", "CASH")) issue("kind");
  else if (said.length === 1 && said[0] !== "unknown") {
    const [kind, direction] = said[0].split(" ");
    intent.kind = kind.replace("?", "") as "debt" | "payment";
    if (kind.endsWith("?")) hinted = direction as Direction;
    else intent.direction = (direction as Direction) ?? null;
  } else if (!said.length && (has("WEAK_IN") || on) && understood) {
    intent.kind = "debt";
    intent.direction = "receivable";
  } else issue("kind");

  // Words that are not understood: goods may follow the verb of a debt, anything else is asked
  // ("if", "he says", "his brother", another surname…).
  if (span && intent.kind) {
    const unknown = (i: number) => i >= 0 && i < tokens.length && !(marked(i) || inAmount(i) || isOn(tokens[i]) || numberWord(tokens[i]) || (i >= span.from && i < span.to));
    const verb = marks.find((m) => ["PAY_IN", "PAY_OUT", "PAY", "DEBT_IN", "LENT", "DEBT_OUT", "BORROWED"].includes(m.cls));
    const beforeVerb = tokens.some((_, i) => unknown(i) && (!verb || i < verb.from));
    const aroundName = unknown(span.from - 1) || (unknown(span.to) && tokens[span.to].norm.startsWith("ال"));
    const inPayment = intent.kind === "payment" && tokens.some((t, i) => unknown(i) || isOn(t));
    if (verb ? beforeVerb || aroundName || inPayment : false) issue("words");
  }

  // How much.
  const withUnit = amounts.filter((a) => a.unit);
  const chosen = withUnit.length === 1 ? withUnit[0] : amounts.length === 1 ? amounts[0] : null;
  if (chosen && amounts.some((a) => a.from >= chosen.to)) issue("amount"); // "2000 dinars and fifty"
  if (chosen) {
    const r = resolve(chosen, ctx);
    intent.currency = r.currency;
    if (r.unclear) issue("amount");
    else if (r.options.length === 1 && r.currency === "DZD" && r.options[0] >= CONFIRM_FROM) {
      intent.amounts = r.options;
      issue("amount_unit");
    } else if (r.options.length === 1) {
      intent.amount = r.options[0];
      intent.amounts = r.options;
    } else {
      intent.amounts = r.options;
      issue("amount_unit");
    }
  } else if (amounts.length > 1) {
    intent.amounts = [...new Set(amounts.filter((a) => !a.unclear).flatMap((a) => resolve(a, ctx).options))];
    issue("amount");
  } else if (!(has("FULL") && intent.kind === "payment")) issue("amount");

  intent.full = has("FULL") && !amounts.length;
  checkRepayment(intent, ctx, hinted);
  return intent;
}

/** A repayment must fit an open balance, which also settles "she paid" / "I paid". */
function checkRepayment(intent: VoiceIntent, ctx: VoiceContext, hinted: Direction | null) {
  const issue = (i: VoiceIssue) => {
    if (!intent.issues.includes(i)) intent.issues.push(i);
  };
  if (intent.kind === "payment" && intent.partyId) {
    const b = partyBalance(ctx.idx, intent.partyId, ctx.today).get(intent.currency);
    const due = { receivable: b?.receivable ?? 0, payable: b?.payable ?? 0 };
    if (!intent.direction) {
      const only: Direction | null = due.receivable > 0 === due.payable > 0 ? null : due.receivable > 0 ? "receivable" : "payable";
      if (only && (!hinted || hinted === only)) intent.direction = only;
      else issue("direction");
      if (due.receivable <= 0 && due.payable <= 0) issue("no_balance");
    }
    if (intent.direction) {
      const open = due[intent.direction];
      if (open <= 0) issue("no_balance");
      else if (intent.full && intent.amount === null) {
        intent.amount = open;
        intent.amounts = [open];
      } else if (intent.amount !== null && intent.amount > open) issue("overpayment");
    }
  } else if (intent.kind === "payment" && intent.spokenName && !intent.candidates.length) issue("no_balance"); // someone new owes nothing
  else if ((intent.kind === "debt" || intent.kind === "payment") && !intent.direction && !hinted) issue("direction");
  if (intent.kind === "payment" && intent.amount === null && !intent.amounts.length && !intent.full) issue("amount");
}

/** The user's answers to the doubts. A negation or a promise cannot be answered into an entry. */
export type VoiceFix = { partyId?: string; newName?: string; kind?: "debt" | "payment"; direction?: Direction; amount?: Minor; confirmed?: boolean };

export function settle(intent: VoiceIntent, fix: VoiceFix, ctx: VoiceContext): VoiceIntent {
  const next: VoiceIntent = { ...intent, issues: [...intent.issues] };
  const clear = (...list: VoiceIssue[]) => {
    next.issues = next.issues.filter((i) => !list.includes(i));
  };
  clear("no_balance", "overpayment"); // checked again below
  if (fix.partyId) {
    next.partyId = fix.partyId;
    clear("party", "party_new", "party_check");
  } else if (fix.newName?.trim()) {
    next.partyId = null;
    next.candidates = [];
    next.spokenName = fix.newName.trim();
    clear("party", "party_new", "party_check");
  }
  if (fix.kind && fix.direction) {
    next.kind = fix.kind;
    next.direction = fix.direction;
    clear("kind", "direction");
  }
  if (fix.amount !== undefined) {
    next.amount = fix.amount;
    clear("amount", "amount_unit", "amount_heard");
  }
  if (fix.confirmed) clear("words", "date");
  checkRepayment(next, ctx, null);
  return next;
}

/** Picks the alternative that makes most sense; amounts that differ between alternatives are asked. */
export function understand(alternatives: { text: string }[], ctx: VoiceContext): VoiceIntent {
  const all = alternatives.filter((a) => a.text?.trim()).map((a) => understandOne(a.text, ctx));
  if (!all.length) return understandOne("", ctx);
  let best = all[0];
  for (const i of all) if (i.issues.length < best.issues.length) best = i;
  if (best.kind === "balance") return best;
  const heard = [...new Set(all.filter((i) => i.currency === best.currency && i.amount !== null).map((i) => i.amount as Minor))];
  if (heard.length > 1) return { ...best, amount: null, amounts: heard, issues: [...best.issues, "amount_heard"] };
  return best;
}
