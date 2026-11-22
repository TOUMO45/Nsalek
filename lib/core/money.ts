// Money: integer minor units, localized parsing, a restricted calculator (no eval) and formatting.
import type { CurrencyCode, Minor } from "./types.ts";

export type Lang = "ar" | "fr" | "en";

type CurrencyInfo = { exponent: number; symbol: Record<Lang, string> };

export const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  DZD: { exponent: 2, symbol: { fr: "DA", ar: "دج", en: "DZD" } },
  EUR: { exponent: 2, symbol: { fr: "€", ar: "€", en: "€" } },
  USD: { exponent: 2, symbol: { fr: "$", ar: "$", en: "$" } },
  GBP: { exponent: 2, symbol: { fr: "£", ar: "£", en: "£" } },
  MAD: { exponent: 2, symbol: { fr: "DH", ar: "د.م", en: "MAD" } },
  TND: { exponent: 3, symbol: { fr: "DT", ar: "د.ت", en: "TND" } },
  SAR: { exponent: 2, symbol: { fr: "SAR", ar: "ر.س", en: "SAR" } },
  AED: { exponent: 2, symbol: { fr: "AED", ar: "د.إ", en: "AED" } },
  CAD: { exponent: 2, symbol: { fr: "$ CA", ar: "$ CA", en: "CA$" } },
  TRY: { exponent: 2, symbol: { fr: "TRY", ar: "TRY", en: "TRY" } },
  CNY: { exponent: 2, symbol: { fr: "CNY", ar: "CNY", en: "CNY" } },
  XOF: { exponent: 0, symbol: { fr: "F CFA", ar: "F CFA", en: "XOF" } },
};

/** Largest accepted amount in minor units (10^15, below Number.MAX_SAFE_INTEGER). */
export const MAX_MINOR = 1_000_000_000_000_000;

export function isCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

export function exponentOf(code: CurrencyCode): number {
  const info = CURRENCIES[code];
  if (!info) throw new Error("unknown_currency");
  return info.exponent;
}

export function isValidMinor(n: unknown): n is Minor {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MINOR;
}

export function isPositiveMinor(n: unknown): n is Minor {
  return isValidMinor(n) && n > 0;
}

// ---------------------------------------------------------------- normalization

const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXT_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹

/** Converts Arabic-Indic and Persian digits to ASCII and Arabic separators to ASCII separators. */
export function normalizeDigits(input: string): string {
  return input
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".") // Arabic decimal separator
    .replace(/٬/g, ",") // Arabic thousands separator
    .replace(/،/g, ","); // Arabic comma
}

const SPACE_CHARS = /[\s    ​]/g;

export type AmountError =
  | "empty"
  | "invalid"
  | "ambiguous_separator"
  | "too_many_decimals"
  | "number_words"
  | "not_positive"
  | "too_large"
  | "division_by_zero"
  | "centimes_must_be_integer";

export type AmountParse =
  | { ok: true; minor: Minor; rounded: boolean; expression: boolean }
  | { ok: false; error: AmountError };

type Rational = { n: bigint; d: bigint };

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
const norm = (r: Rational): Rational => {
  if (r.d < 0n) r = { n: -r.n, d: -r.d };
  const g = gcd(r.n, r.d);
  return { n: r.n / g, d: r.d / g };
};

class ParseFailure extends Error {
  code: AmountError;
  constructor(code: AmountError) {
    super(code);
    this.code = code;
  }
}
const bad = (code: AmountError): never => {
  throw new ParseFailure(code);
};

/**
 * Parses one number literal (no operators). Accepts "1500", "1 500", "1500,50", "1 500,50",
 * "1.500,50", "1,500.50", "1.500.000". Rejects forms whose meaning depends on locale,
 * such as "1,500" or "1.500" (one separator followed by exactly three digits).
 */
export function parseNumberLiteral(raw: string): Rational {
  const s = raw.trim();
  if (!s) bad("empty");
  if (!/^[0-9 .,    ]+$/.test(s)) bad("invalid");
  const hasSpace = /[     ]/.test(s);
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let decimalChar: "." | "," | null = null;
  let groupChar: "." | "," | null = null;

  if (dots && commas) {
    decimalChar = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    groupChar = decimalChar === "." ? "," : ".";
    if ((decimalChar === "." ? dots : commas) !== 1) bad("invalid");
    if (hasSpace) bad("invalid");
  } else if (dots + commas === 1) {
    const sep = dots ? "." : ",";
    const [before, after] = s.split(sep);
    const beforeDigits = before.replace(SPACE_CHARS, "");
    if (after.length === 0 || /[     ]/.test(after)) bad("invalid");
    if (after.length === 3 && beforeDigits.length >= 1 && beforeDigits.length <= 3 && !/^0+$/.test(beforeDigits) && !hasSpace)
      bad("ambiguous_separator");
    if (after.length === 3 && hasSpace) bad("ambiguous_separator");
    decimalChar = sep;
  } else if (dots > 1 || commas > 1) {
    groupChar = dots ? "." : ",";
    if (hasSpace) bad("invalid");
  }

  let intPart = s;
  let fracPart = "";
  if (decimalChar) {
    const idx = s.lastIndexOf(decimalChar);
    intPart = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
    if (!/^\d+$/.test(fracPart)) bad("invalid");
  }
  const groupPattern = groupChar ? new RegExp(`[${groupChar === "." ? "\\." : ","}]`) : null;
  const pieces = hasSpace
    ? intPart.split(/[     ]+/)
    : groupPattern
      ? intPart.split(groupPattern)
      : [intPart];
  if (pieces.length > 1) {
    if (!/^\d{1,3}$/.test(pieces[0]) || pieces.slice(1).some((g) => !/^\d{3}$/.test(g))) bad("invalid");
  } else if (!/^\d+$/.test(pieces[0])) bad("invalid");
  const digits = pieces.join("");
  if (digits.length > 18) bad("too_large");
  const scale = 10n ** BigInt(fracPart.length);
  return norm({ n: BigInt(digits + fracPart), d: scale });
}

// ---------------------------------------------------------------- restricted calculator

type Token = { t: "num"; v: Rational } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "("} | { t: ")" };

function tokenize(input: string): Token[] {
  const s = input.replace(/[×xX]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-");
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/".includes(c)) {
      tokens.push({ t: "op", v: c as "+" | "-" | "*" | "/" });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ t: c });
      i++;
      continue;
    }
    if (/[0-9.,]/.test(c)) {
      let j = i;
      // A literal may contain inner spaces used as thousands grouping ("1 500 + 20").
      while (j < s.length && /[0-9.,    ]/.test(s[j])) {
        if (s[j] === " " && !/[0-9]/.test(s[j + 1] ?? "")) break;
        j++;
      }
      tokens.push({ t: "num", v: parseNumberLiteral(s.slice(i, j)) });
      i = j;
      continue;
    }
    bad("invalid");
  }
  return tokens;
}

function evaluate(tokens: Token[]): Rational {
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const add = (a: Rational, b: Rational, sign: bigint) => norm({ n: a.n * b.d + sign * b.n * a.d, d: a.d * b.d });
  function expr(): Rational {
    let left = term();
    for (let tok = peek(); tok && tok.t === "op" && (tok.v === "+" || tok.v === "-"); tok = peek()) {
      pos++;
      left = add(left, term(), tok.v === "+" ? 1n : -1n);
    }
    return left;
  }
  function term(): Rational {
    let left = factor();
    for (let tok = peek(); tok && tok.t === "op" && (tok.v === "*" || tok.v === "/"); tok = peek()) {
      pos++;
      const right = factor();
      if (tok.v === "*") left = norm({ n: left.n * right.n, d: left.d * right.d });
      else {
        if (right.n === 0n) bad("division_by_zero");
        left = norm({ n: left.n * right.d, d: left.d * right.n });
      }
    }
    return left;
  }
  function factor(): Rational {
    const tok = tokens[pos++];
    if (!tok) return bad("invalid");
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "-") {
      const f = factor();
      return { n: -f.n, d: f.d };
    }
    if (tok.t === "(") {
      if (++depth > 20) bad("invalid");
      const v = expr();
      if (tokens[pos++]?.t !== ")") bad("invalid");
      depth--;
      return v;
    }
    return bad("invalid");
  }
  const value = expr();
  if (pos !== tokens.length) bad("invalid");
  return value;
}

/**
 * Parses an amount typed by a person. Number words ("million", "مليون", "ألف", "k") are never
 * interpreted. The currency label may be typed after the number and is ignored.
 * unit "centime" means the integer typed is in DZD centimes (1 DA = 100 centimes).
 */
export function parseAmount(
  input: string,
  currency: CurrencyCode,
  opts: { unit?: "major" | "centime" } = {},
): AmountParse {
  try {
    const exp = exponentOf(currency);
    let s = normalizeDigits(input ?? "").trim();
    if (!s) return { ok: false, error: "empty" };
    if (s.length > 200) return { ok: false, error: "invalid" };
    const info = CURRENCIES[currency];
    const labels = [currency, ...Object.values(info.symbol), "DA", "دج", "د.ج", "DZD"];
    for (const label of labels) {
      const lower = s.toLowerCase();
      if (lower.endsWith(label.toLowerCase())) s = s.slice(0, s.length - label.length).trim();
    }
    if (/[A-Za-z؀-ۿ]/.test(s.replace(/[×xX]/g, ""))) return { ok: false, error: "number_words" };
    const isExpression = /[+\-*/×xX÷()−–]/.test(s);
    const value = isExpression ? evaluate(tokenize(s)) : parseNumberLiteral(s);
    if (value.n <= 0n) return { ok: false, error: "not_positive" };

    if (opts.unit === "centime") {
      if (currency !== "DZD") return { ok: false, error: "invalid" };
      if (value.d !== 1n) return { ok: false, error: "centimes_must_be_integer" };
      const minor = value.n;
      if (minor > BigInt(MAX_MINOR)) return { ok: false, error: "too_large" };
      return { ok: true, minor: Number(minor), rounded: false, expression: isExpression };
    }

    const scaled = value.n * 10n ** BigInt(exp);
    let minor = scaled / value.d;
    const remainder = scaled % value.d;
    let rounded = false;
    if (remainder !== 0n) {
      if (!isExpression) return { ok: false, error: "too_many_decimals" };
      rounded = true;
      if (remainder * 2n >= value.d) minor += 1n; // half up (value is positive)
    }
    if (minor <= 0n) return { ok: false, error: "not_positive" };
    if (minor > BigInt(MAX_MINOR)) return { ok: false, error: "too_large" };
    return { ok: true, minor: Number(minor), rounded, expression: isExpression };
  } catch (e) {
    if (e instanceof ParseFailure) return { ok: false, error: e.code };
    if (e instanceof Error && e.message === "unknown_currency") return { ok: false, error: "invalid" };
    throw e;
  }
}

// ---------------------------------------------------------------- formatting

// No-break space: groups digits without letting a line break split an amount.
const GROUP_SPACE = String.fromCharCode(0xa0);

/** Plain number without currency, e.g. "1 500,00" (fr/ar) or "1,500.00" (en). Latin digits everywhere. */
export function formatNumber(minor: Minor, currency: CurrencyCode, lang: Lang): string {
  const exp = exponentOf(currency);
  const negative = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(exp);
  const intPart = (abs / base).toString();
  const frac = exp ? (abs % base).toString().padStart(exp, "0") : "";
  const group = lang === "en" ? "," : GROUP_SPACE;
  const decimal = lang === "en" ? "." : ",";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return (negative ? "-" : "") + grouped + (exp ? decimal + frac : "");
}

export function currencySymbol(currency: CurrencyCode, lang: Lang): string {
  return CURRENCIES[currency]?.symbol[lang] ?? currency;
}

export const HIDDEN_AMOUNT = "•••••";

/** "1 500,00 DA", "1 500,00 دج", "1,500.00 DZD". */
export function formatMoney(minor: Minor, currency: CurrencyCode, lang: Lang, opts: { hide?: boolean } = {}): string {
  const symbol = currencySymbol(currency, lang);
  if (opts.hide) return `${HIDDEN_AMOUNT} ${symbol}`;
  return `${formatNumber(minor, currency, lang)} ${symbol}`;
}

/** Value for an editable input, e.g. 150050 → "1500,50" (fr/ar) or "1500.50" (en); no grouping. */
export function toInputValue(minor: Minor, currency: CurrencyCode, lang: Lang): string {
  const exp = exponentOf(currency);
  const base = 10n ** BigInt(exp);
  const abs = BigInt(minor);
  const intPart = (abs / base).toString();
  const frac = (abs % base).toString().padStart(exp, "0");
  if (!exp || /^0+$/.test(frac)) return intPart;
  return intPart + (lang === "en" ? "." : ",") + frac;
}

export function sumMinor(values: Minor[]): Minor {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) throw new Error("overflow");
  }
  return total;
}
