"use client";
// Cash book: one day at a time, its money in and out, cash at hand, the month, and adding or
// cancelling an entry. Cash repayments of debts appear here by themselves.
import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Download, Plus, Wallet } from "lucide-react";
import { useApp, newCommandId } from "@/lib/ui/state";
import { AmountInput, Field, Money, Seg, downloadText, go, useAmount, useAsk } from "@/lib/ui/components";
import { errorMessage, type Key } from "@/lib/ui/i18n";
import { cashAtHand, cashCurrencies, cashLines, cashSummary, cashTotals, exportCash, type CashLine } from "@/lib/core/cash";
import { addDays, formatDate } from "@/lib/core/dates";
import { CASH_IN, CASH_OUT, type CashKind } from "@/lib/core/types";

const kindKey = (k: CashLine["kind"]) => `k_${k}` as Key;

export function CashPage({ date }: { date?: string }) {
  const { t, lang, ws, data, today, meta } = useApp();
  const staff = !!meta?.staffMode;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const [currency, setCurrency] = useState(ws?.defaultCurrency ?? "DZD");
  const [adding, setAdding] = useState<"in" | "out" | null>(null);
  const currencies = useMemo(() => (ws ? cashCurrencies(data, ws.id, ws.defaultCurrency) : []), [data, ws]);
  const lines = useMemo(() => (ws ? cashLines(data, ws.id, day, day) : []), [data, ws, day]);
  const totals = cashTotals(lines, currency);
  const atHand = useMemo(() => (ws ? cashAtHand(data, ws.id, day, currency) : 0), [data, ws, day, currency]);
  const month = useMemo(() => (ws ? cashSummary(data, ws.id, `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`, currency) : null), [data, ws, day, currency]);
  const onCredit = useMemo(
    () => (ws ? data.obligations.filter((o) => o.workspaceId === ws.id && o.state === "posted" && o.direction === "receivable" && o.date === day && o.currency === currency).reduce((n, o) => n + o.principal, 0) : 0),
    [data, ws, day, currency],
  );
  if (!ws) return null;
  const Prev = lang === "ar" ? ChevronRight : ChevronLeft;
  const Next = lang === "ar" ? ChevronLeft : ChevronRight;
  const shown = lines.filter((l) => l.currency === currency);
  return (
    <div className="stack">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-[22px] font-bold">{t("cash")}</h1>
        {currencies.length > 1 && (
          <select className="input w-auto" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label={t("currency")}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
      </div>
      <p className="help">{t("cashHelp")}</p>

      <div className="flex items-center justify-between gap-2">
        <button className="icon-btn" aria-label={t("cashPrev")} onClick={() => go(`/cash/${addDays(day, -1)}`)}>
          <Prev size={22} />
        </button>
        <div className="text-center">
          <p className="font-bold">
            <bdi className="num">{formatDate(day, lang)}</bdi>
          </p>
          {day !== today && (
            <button className="help font-semibold underline" onClick={() => go("/cash")}>
              {t("cashToday")}
            </button>
          )}
        </div>
        <button className="icon-btn" aria-label={t("cashNext")} disabled={day >= today} onClick={() => go(`/cash/${addDays(day, 1)}`)}>
          <Next size={22} />
        </button>
      </div>

      <section className="hero">
        <div className="hero-row">
          <div className="hero-owed">
            <p className="hero-label">
              <Wallet size={18} aria-hidden /> {t("cashAtHand")}
            </p>
            {staff ? (
              <p className="help mt-2">{t("staffTotalsHidden")}</p>
            ) : atHand === null ? (
              <p className="help mt-2">{t("cashNoOpening")}</p>
            ) : (
              <>
                <p className="hero-amount mt-2">
                  {/* More went out than came in: the drawer is short, and the sign must show it. */}
                  <Money minor={atHand} currency={currency} signed={atHand < 0} />
                </p>
                <p className="help">{t("cashAtHandHelp")}</p>
              </>
            )}
          </div>
          <div className="hero-owe">
            <p className="flex items-center gap-1.5 font-bold owed">
              <ArrowDownLeft size={16} aria-hidden /> {t("cashIn")}
            </p>
            <p className="owed text-[18px] font-bold">
              <Money minor={totals.in} currency={currency} />
            </p>
            <p className="mt-1 flex items-center gap-1.5 font-bold owe">
              <ArrowUpRight size={16} aria-hidden /> {t("cashOut")}
            </p>
            <p className="owe text-[18px] font-bold">
              <Money minor={totals.out} currency={currency} />
            </p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-owed" style={{ minHeight: 54 }} onClick={() => setAdding("in")}>
          <Plus size={18} aria-hidden /> {t("cashIn")}
        </button>
        <button className="btn btn-owe" style={{ minHeight: 54 }} onClick={() => setAdding("out")}>
          <Plus size={18} aria-hidden /> {t("cashOut")}
        </button>
      </div>
      {adding && <CashForm key={adding + day} direction={adding} date={day} currency={currency} onDone={() => setAdding(null)} />}

      <section className="card overflow-hidden">
        {shown.length === 0 ? (
          <p className="help p-4">{t("cashEmpty")}</p>
        ) : (
          shown.map((l) => <CashRow key={l.id} line={l} />)
        )}
      </section>
      {onCredit > 0 && (
        <p className="help">
          {t("cashOnCredit")}: <Money minor={onCredit} currency={currency} className="owed font-bold" />
        </p>
      )}

      {!staff && month && (month.totals.in > 0 || month.totals.out > 0) && (
        <details className="card p-4">
          <summary className="section-title cursor-pointer">
            {t("cashMonth")} · <Money minor={month.totals.net} currency={currency} signed className={month.totals.net < 0 ? "owe" : "owed"} />
          </summary>
          <div className="stack mt-3">
            <div className="grid grid-cols-2 gap-2">
              <p>
                {t("cashIn")}: <Money minor={month.totals.in} currency={currency} className="owed font-bold" />
              </p>
              <p>
                {t("cashOut")}: <Money minor={month.totals.out} currency={currency} className="owe font-bold" />
              </p>
            </div>
            <ul className="help grid gap-1">
              {month.byKind.map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span>{t(kindKey(k))}</span>
                  <Money minor={Math.abs(v)} currency={currency} className={v < 0 ? "owe" : "owed"} />
                </li>
              ))}
            </ul>
            {month.byCategory.filter((c) => c.category).length > 0 && (
              <>
                <h3 className="font-bold">{t("cashByLabel")}</h3>
                <ul className="help grid gap-1">
                  {month.byCategory
                    .filter((c) => c.category)
                    .slice(0, 12)
                    .map((c) => (
                      <li key={c.direction + c.category} className="flex justify-between gap-2">
                        <span>{c.category}</span>
                        <Money minor={c.amount} currency={currency} className={c.direction === "out" ? "owe" : "owed"} />
                      </li>
                    ))}
                </ul>
              </>
            )}
            <button
              className="btn btn-sm w-fit"
              onClick={() => downloadText(`nsalek-cash-${day.slice(0, 7)}.csv`, exportCash(data, ws.id, `${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-31`, { lang, bom: true }), "text/csv;charset=utf-8")}
            >
              <Download size={16} aria-hidden /> {t("cashExport")}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

function CashRow({ line: l }: { line: CashLine }) {
  const { t, run, lang, toast, meta } = useApp();
  const ask = useAsk();
  const cancel = async () => {
    const reason = await ask({ title: t("cashVoid"), message: t("cashVoidAsk"), reason: true, confirmLabel: t("cashVoid"), danger: true });
    if (!reason) return;
    try {
      await run("voidCashEntry", { cashEntryId: l.id, reason });
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  const label = l.kind === "repayment" ? `${t(kindKey(l.kind))} · ${l.label}` : l.label || t(kindKey(l.kind));
  return (
    <div className="row" style={l.voided ? { opacity: 0.6 } : undefined}>
      <span className="tile-icon" style={{ background: l.direction === "in" ? "var(--owed-soft)" : "var(--owe-soft)", color: l.direction === "in" ? "var(--owed)" : "var(--owe)" }}>
        {l.direction === "in" ? <ArrowDownLeft size={18} aria-hidden /> : <ArrowUpRight size={18} aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold" style={l.voided ? { textDecoration: "line-through" } : undefined}>
          {label}
        </span>
        <span className="help block truncate">
          {l.kind !== "repayment" && l.label ? t(kindKey(l.kind)) : ""}
          {l.note ? `${l.kind !== "repayment" && l.label ? " · " : ""}${l.note}` : ""}
          {l.voided && <span className="chip chip-late ms-1">{t("cashVoided")}</span>}
        </span>
      </span>
      <span className="text-end">
        <b className={l.direction === "in" ? "owed" : "owe"} style={l.voided ? { textDecoration: "line-through" } : undefined}>
          <Money minor={l.amount} currency={l.currency} />
        </b>
        {l.kind === "repayment" && l.partyId ? (
          <a className="help block underline" href={`#/people/${l.partyId}`}>
            {t("cashOpenPerson")}
          </a>
        ) : !l.voided && !meta?.staffMode ? (
          <button className="help block underline" onClick={cancel}>
            {t("cashVoid")}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function CashForm({ direction, date, currency, onDone }: { direction: "in" | "out"; date: string; currency: string; onDone: () => void }) {
  const { t, run, ws, lang, toast } = useApp();
  const kinds = (direction === "in" ? CASH_IN : CASH_OUT) as CashKind[];
  const [kind, setKind] = useState<CashKind>(direction === "in" ? "sale" : "expense");
  const [amount, setAmount, parsed, ready] = useAmount(currency);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [id] = useState(newCommandId);
  const save = async () => {
    setTried(true);
    if (!ready || !parsed.ok || parsed.minor <= 0) return;
    setBusy(true);
    try {
      await run("addCashEntry", { workspaceId: ws!.id, kind, amount: parsed.minor, currency, date, category, note }, id);
      toast(t("saved"));
      onDone();
    } catch (e) {
      toast(errorMessage(lang, e));
      setBusy(false);
    }
  };
  return (
    <form
      className="card stack p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="section-title">{t("cashNew")}</h2>
      <Seg value={kind} onChange={setKind} label={t("cashKind")} options={kinds.map((k) => ({ value: k, label: t(kindKey(k)) }))} />
      <Field label={t("amount")} htmlFor="cash-amount">
        <AmountInput id="cash-amount" currency={currency} state={amount} onChange={setAmount} parsed={parsed} showErrors={tried} autoFocus />
      </Field>
      <Field label={t("category")} htmlFor="cash-cat" help={t("categoryHint")}>
        <input id="cash-cat" className="input" maxLength={60} value={category} onChange={(e) => setCategory(e.target.value)} list="cash-cats" />
      </Field>
      <CategoryList direction={direction} />
      <Field label={t("description")} htmlFor="cash-note">
        <input id="cash-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <button className={`btn flex-1 ${direction === "in" ? "btn-owed" : "btn-owe"}`} disabled={busy}>
          {busy ? t("saving") : t("save")}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** Labels used before, to pick instead of typing. */
function CategoryList({ direction }: { direction: "in" | "out" }) {
  const { data, ws } = useApp();
  const used = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data.cashEntries) if (e.workspaceId === ws?.id && e.direction === direction && e.category) seen.set(e.category.toLowerCase(), e.category);
    return [...seen.values()].slice(0, 30);
  }, [data, ws, direction]);
  return (
    <datalist id="cash-cats">
      {used.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}
