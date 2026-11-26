"use client";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Search, X } from "lucide-react";
import { formatMoney, parseAmount, CURRENCIES, type AmountParse } from "../core/money.ts";
import { searchParties, type ObligationStatus } from "../core/ledger.ts";
import { initials, displayPhone } from "../core/text.ts";
import { sha256Hex, bytesToBase64 } from "../core/crypto.ts";
import type { Direction, Minor } from "../core/types.ts";
import { amountError } from "./i18n.ts";
import { useApp } from "./state.tsx";

// ---------------------------------------------------------------- routing (hash based, static-export friendly)

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): { parts: string[]; query: URLSearchParams } {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  return useMemo(() => {
    const [path, q = ""] = hash.replace(/^#\/?/, "").split("?");
    return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
  }, [hash]);
}

export function go(path: string) {
  window.location.hash = path.startsWith("#") ? path : "#" + path;
}

// ---------------------------------------------------------------- money and labels

export function Money({ minor, currency, className = "", signed = false }: { minor: Minor; currency: string; className?: string; signed?: boolean }) {
  const { lang, prefs } = useApp();
  const text = formatMoney(Math.abs(minor), currency, lang, { hide: prefs.hideAmounts });
  return (
    <bdi className={`num ${className}`}>
      {signed && !prefs.hideAmounts ? (minor < 0 ? "−" : minor > 0 ? "+" : "") : ""}
      {text}
    </bdi>
  );
}

export function DirectionIcon({ direction, size = 16 }: { direction: Direction; size?: number }) {
  return direction === "receivable" ? (
    <ArrowDownLeft size={size} className="owed" aria-hidden />
  ) : (
    <ArrowUpRight size={size} className="owe" aria-hidden />
  );
}

export function StatusChip({ status, overdueDays, disputed }: { status: ObligationStatus; overdueDays?: number; disputed?: boolean }) {
  const { t, lang } = useApp();
  const cls = status === "paid" || status === "closed" || status === "waived" ? "chip-owed" : status === "voided" || status === "draft" ? "" : "chip-soon";
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`chip ${cls}`}>{t(`st_${status}` as never)}</span>
      {!!overdueDays && overdueDays > 0 && (
        <span className="chip chip-late">
          <bdi className="num">{overdueDays}</bdi>
          {lang === "fr" ? "" : " "}
          {t("overdueDays")}
        </span>
      )}
      {disputed && <span className="chip chip-late">{t("disputed")}</span>}
    </span>
  );
}

/** One of the six tile colours, always the same for the same name. */
export function toneOf(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 6;
}

export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span className={large ? "avatar avatar-lg" : "avatar"} data-tone={toneOf(name)} aria-hidden>
      {initials(name)}
    </span>
  );
}

export { displayPhone };

// ---------------------------------------------------------------- layout primitives

export function Sheet({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    const root = ref.current;
    const first =
      root?.querySelector<HTMLElement>("[data-autofocus]") ??
      root?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=file]), select, textarea") ??
      root?.querySelector<HTMLElement>("button:not([data-close])");
    first?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} style={wide ? { maxWidth: 760 } : undefined}>
        <div className="sheet-handle" />
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-[17px] font-bold">
            {title}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="close" data-close>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- in-app confirmation dialog

/** A confirmation inside the app (instead of the browser's confirm/prompt), optionally asking for a reason. */
export type AskOptions = { title: string; message?: string; reason?: boolean; confirmLabel: string; danger?: boolean };
type AskRequest = AskOptions & { resolve: (answer: string | null) => void };
const AskContext = createContext<(o: AskOptions) => Promise<string | null>>(async () => null);

/** Resolves to the typed reason (or "ok" when no reason is asked), or null when dismissed. */
export const useAsk = () => useContext(AskContext);

export function AskProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<AskRequest | null>(null);
  const ask = useCallback((o: AskOptions) => new Promise<string | null>((resolve) => setReq({ ...o, resolve })), []);
  const done = useCallback(
    (answer: string | null) => {
      req?.resolve(answer);
      setReq(null);
    },
    [req],
  );
  return (
    <AskContext.Provider value={ask}>
      {children}
      {req && <AskDialog req={req} onDone={done} />}
    </AskContext.Provider>
  );
}

function AskDialog({ req, onDone }: { req: AskRequest; onDone: (answer: string | null) => void }) {
  const { t } = useApp();
  const [reason, setReason] = useState("");
  const dismiss = useCallback(() => onDone(null), [onDone]);
  return (
    <Sheet title={req.title} onClose={dismiss}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(req.reason ? reason.trim() : "ok");
        }}
      >
        {req.message && <p>{req.message}</p>}
        {req.reason && (
          <Field label={t("reason")} help={t("reasonRequired")} htmlFor="ask-reason">
            <input id="ask-reason" className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn flex-1" onClick={dismiss}>
            {t("close")}
          </button>
          <button className={`btn flex-1 ${req.danger ? "btn-danger" : "btn-primary"}`} disabled={!!req.reason && !reason.trim()}>
            {req.confirmLabel}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function Field({ label, help, error, children, htmlFor }: { label: string; help?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <p className="error-text mt-1">{error}</p> : help ? <p className="help mt-1">{help}</p> : null}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && (
        <div className="mb-1 grid h-16 w-16 place-items-center rounded-[20px]" style={{ background: "var(--brand-soft)", color: "var(--brand)" }}>
          {icon}
        </div>
      )}
      <p className="text-[16px] font-bold">{title}</p>
      {text && <p className="help max-w-sm">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Toast() {
  const { toastMsg } = useApp();
  if (!toastMsg) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {toastMsg}
    </div>
  );
}

// ---------------------------------------------------------------- direction picker

export function DirectionPicker({ value, onChange }: { value: Direction; onChange: (d: Direction) => void }) {
  const { t, prefs } = useApp();
  const opt = (d: Direction) => {
    const active = value === d;
    const owed = d === "receivable";
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onChange(d)}
        className="flex min-h-[64px] flex-1 items-center gap-3 rounded-xl border px-3 text-start"
        style={{
          borderColor: active ? (owed ? "var(--owed)" : "var(--owe)") : "var(--line)",
          background: active ? (owed ? "var(--owed-soft)" : "var(--owe-soft)") : "var(--surface)",
          borderWidth: active ? 2 : 1,
        }}
      >
        <DirectionIcon direction={d} size={22} />
        <span>
          <span className={`block font-bold ${owed ? "owed" : "owe"}`}>{owed ? t(prefs.dzWording ? "owedToMeDz" : "owedToMe") : t(prefs.dzWording ? "iOweDz" : "iOwe")}</span>
          <span className="help block">{owed ? t("owedToMeHelp") : t("iOweHelp")}</span>
        </span>
      </button>
    );
  };
  return (
    <div className="flex gap-2" role="group">
      {opt("receivable")}
      {opt("payable")}
    </div>
  );
}

// ---------------------------------------------------------------- amount input with restricted calculator

export type AmountState = { text: string; unit: "major" | "centime"; confirmed: boolean };

export function useAmount(currency: string, initial = ""): [AmountState, (s: Partial<AmountState>) => void, AmountParse, boolean] {
  const [s, set] = useState<AmountState>({ text: initial, unit: "major", confirmed: false });
  const parsed = useMemo(() => parseAmount(s.text, currency, { unit: currency === "DZD" ? s.unit : "major" }), [s.text, s.unit, currency]);
  const ready = parsed.ok && (s.unit !== "centime" || s.confirmed);
  return [s, (p) => set((o) => ({ ...o, ...p, confirmed: p.text !== undefined || p.unit !== undefined ? false : (p.confirmed ?? o.confirmed) })), parsed, ready];
}

export function AmountInput({
  id,
  currency,
  state,
  onChange,
  parsed,
  showErrors,
  autoFocus,
}: {
  id?: string;
  currency: string;
  state: AmountState;
  onChange: (s: Partial<AmountState>) => void;
  parsed: AmountParse;
  showErrors?: boolean;
  autoFocus?: boolean;
}) {
  const { t, lang } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const insert = (op: string) => {
    onChange({ text: (state.text.trim() + " " + op + " ").replace(/\s+/g, " ") });
    input.current?.focus();
  };
  const error = !state.text.trim() ? null : !parsed.ok ? amountError(lang, parsed.error) : null;
  return (
    <div>
      <div className="flex items-stretch gap-2">
        <input
          ref={input}
          id={id}
          className="input num text-[20px] font-bold"
          style={{ direction: "ltr", textAlign: lang === "ar" ? "right" : "left", display: "block" }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={state.text}
          aria-invalid={!!error && showErrors}
          data-autofocus={autoFocus ? "" : undefined}
          data-amount-input=""
          onChange={(e) => onChange({ text: e.target.value })}
        />
        {currency === "DZD" ? (
          <div className="seg" style={{ gridAutoColumns: "minmax(54px,auto)" }}>
            <button type="button" aria-pressed={state.unit === "major"} onClick={() => onChange({ unit: "major" })}>
              {t("unitDa")}
            </button>
            <button type="button" aria-pressed={state.unit === "centime"} onClick={() => onChange({ unit: "centime" })}>
              {t("unitCentimes")}
            </button>
          </div>
        ) : (
          <span className="chip self-center">{currency}</span>
        )}
      </div>
      <div className="mt-2 flex gap-1.5" aria-hidden={false}>
        {["+", "−", "×", "÷"].map((op) => (
          <button key={op} type="button" className="btn btn-sm min-w-[44px]" onClick={() => insert(op === "−" ? "-" : op)} aria-label={op}>
            {op}
          </button>
        ))}
      </div>
      <div className="mt-2 min-h-[20px] text-[14px]" aria-live="polite">
        {error ? (
          <span className="error-text">{error}</span>
        ) : parsed.ok && (parsed.expression || state.unit === "centime") ? (
          <span>
            {parsed.expression && <span className="muted">{t("calcResult")}: </span>}
            <b>
              <Money minor={parsed.minor} currency={currency} />
            </b>
            {parsed.rounded && <span className="muted"> · {t("roundedNote")}</span>}
          </span>
        ) : null}
      </div>
      {state.unit === "centime" && parsed.ok && (
        <label className="banner banner-warn mt-2 cursor-pointer">
          <input type="checkbox" checked={state.confirmed} onChange={(e) => onChange({ confirmed: e.target.checked })} className="mt-1 h-5 w-5" />
          <span>
            {t("centimeConfirm")}{" "}
            <b>
              <Money minor={parsed.minor} currency={currency} />
            </b>{" "}
            (<bdi className="num">{state.text}</bdi> {t("unitCentimes")})
          </span>
        </label>
      )}
    </div>
  );
}

export function CurrencySelect({ value, onChange, id }: { value: string; onChange: (c: string) => void; id?: string }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.keys(CURRENCIES).map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- party picker

export function PartyPicker({
  partyId,
  name,
  onPick,
  onName,
  id,
  autoFocus,
}: {
  partyId: string | null;
  name: string;
  onPick: (id: string | null) => void;
  onName: (name: string) => void;
  id?: string;
  autoFocus?: boolean;
}) {
  const { idx, today, t } = useApp();
  const [open, setOpen] = useState(false);
  const picked = partyId ? idx?.party.get(partyId) : null;
  const matches = useMemo(() => (idx && name.trim() ? searchParties(idx, name, {}, today).slice(0, 6) : idx ? idx.parties.filter((p) => !p.archivedAt && !p.mergedIntoId).slice(-6).reverse().map((party) => ({ party })) : []), [idx, name, today]);
  if (picked)
    return (
      <div className="flex items-center gap-3 rounded-xl border p-2" style={{ borderColor: "var(--line)" }}>
        <Avatar name={picked.displayName} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{picked.displayName}</p>
          {picked.phones[0] && <p className="help num">{displayPhone(picked.phones[0])}</p>}
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onPick(null)}>
          {t("edit")}
        </button>
      </div>
    );
  return (
    <div className="relative">
      <div className="relative">
        <Search size={18} className="muted pointer-events-none absolute top-[14px]" style={{ insetInlineStart: 12 }} />
        <input
          id={id}
          className="input"
          style={{ paddingInlineStart: 38 }}
          placeholder={t("pickOrType")}
          data-autofocus={autoFocus ? "" : undefined}
          value={name}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            onName(e.target.value);
            setOpen(true);
          }}
        />
      </div>
      {open && (matches.length > 0 || name.trim()) && (
        <div className="card mt-1 overflow-hidden" role="listbox">
          {matches.map(({ party }) => (
            <button key={party.id} type="button" className="row" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(party.id)}>
              <Avatar name={party.displayName} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{party.displayName}</span>
                {party.phones[0] && <span className="help num block">{displayPhone(party.phones[0])}</span>}
              </span>
            </button>
          ))}
          {name.trim() && !matches.some((m) => m.party.displayName.trim().toLowerCase() === name.trim().toLowerCase()) && (
            <button
              type="button"
              className="row help"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                // New name stays typed; the person is created on save. Move on to the amount.
                (document.querySelector("[data-amount-input]") as HTMLInputElement | null)?.focus();
              }}
            >
              + {t("createNamed")} « <b className="text-[var(--ink)]">{name.trim()}</b> »
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- files

export function downloadText(name: string, text: string, mime = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readFileAttachment(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, mime: file.type || "application/octet-stream", data: bytesToBase64(bytes), sha256: await sha256Hex(bytes), size: bytes.length };
}

export function useOnline() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
