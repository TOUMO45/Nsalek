"use client";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp, newCommandId } from "@/lib/ui/state";
import { useSheet } from "@/lib/ui/sheets";
import { AmountInput, Empty, Field, Money, PartyPicker, Seg, go, useAmount } from "@/lib/ui/components";
import { errorMessage } from "@/lib/ui/i18n";
import { invoiceTotals, lineTotals, parseQuantity } from "@/lib/core/invoice";
import { parseAmount } from "@/lib/core/money";
import { formatDate } from "@/lib/core/dates";
import { nextOccurrences } from "@/lib/core/recurrence";
import { parseSentence } from "@/lib/core/parse";
import type { Direction, InvoiceLine } from "@/lib/core/types";

// ---------------------------------------------------------------- invoices

type LineDraft = { description: string; qty: string; price: string; discount: string; taxBps: number };

export function Invoices({ sub }: { sub?: string }) {
  const { t, data, ws, idx, lang, run, toast } = useApp();
  const list = data.invoices.filter((i) => i.workspaceId === ws?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (sub === "new" || (sub && data.invoices.some((i) => i.id === sub && i.state === "draft"))) return <InvoiceForm invoiceId={sub === "new" ? undefined : sub} />;
  const act = async (type: string, payload: Record<string, unknown>) => {
    try {
      await run(type, payload);
      toast(t("saved"));
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-[22px] font-bold">{t("invoices")}</h1>
        <a className="btn btn-sm btn-primary" href="#/more/invoices/new">
          <Plus size={16} /> {t("invoiceNew")}
        </a>
      </div>
      <p className="help">
        {t("invoiceNote")} {t("taxNote")}
      </p>
      {list.length === 0 ? (
        <Empty title={t("none")} />
      ) : (
        <div className="card overflow-hidden">
          {list.map((inv) => (
            <div key={inv.id} className="row">
              <span className="flex-1">
                <span className="block font-semibold">
                  {inv.number || t("st_draft")} · {idx?.party.get(inv.partyId)?.displayName}
                </span>
                <span className="help">
                  <bdi className="num">{formatDate(inv.date, lang)}</bdi> · <span className="chip">{t(`st_${inv.state}` as never)}</span>
                </span>
              </span>
              <Money minor={inv.totals.total} currency={inv.currency} />
              <span className="flex gap-1">
                {inv.state === "draft" && (
                  <>
                    <a className="btn btn-sm" href={`#/more/invoices/${inv.id}`}>
                      {t("edit")}
                    </a>
                    <button className="btn btn-sm btn-primary" onClick={() => act("postInvoice", { invoiceId: inv.id })}>
                      {t("postInvoice")}
                    </button>
                  </>
                )}
                <a className="btn btn-sm" href={`#/invoice-print/${inv.id}`}>
                  {t("printPdf")}
                </a>
                {inv.state === "posted" && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      const reason = window.prompt(t("reason"));
                      if (reason) void act("voidInvoice", { invoiceId: inv.id, reason });
                    }}
                  >
                    {t("voidDebt")}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function InvoiceForm({ invoiceId }: { invoiceId?: string }) {
  const { t, ws, data, run, toast, today, lang } = useApp();
  const existing = invoiceId ? data.invoices.find((i) => i.id === invoiceId) : undefined;
  const [partyId, setPartyId] = useState<string | null>(existing?.partyId ?? null);
  const [name, setName] = useState("");
  const [date, setDate] = useState(existing?.date ?? today);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    existing?.lines.map((l) => ({ description: l.description, qty: String(l.quantityMilli / 1000), price: String(l.unitPrice / 100), discount: l.discountBps ? String(l.discountBps / 100) : "", taxBps: l.taxBps })) ?? [
      { description: "", qty: "1", price: "", discount: "", taxBps: 0 },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const cmd = useMemo(() => newCommandId(), []);
  const currency = existing?.currency ?? ws!.defaultCurrency;
  const built = lines.map((l): InvoiceLine | null => {
    const q = parseQuantity(l.qty);
    const p = parseAmount(l.price, currency);
    const d = l.discount.trim() ? Math.round(Number(l.discount.replace(",", ".")) * 100) : 0;
    if (!q || !p.ok || !l.description.trim() || Number.isNaN(d)) return null;
    return { description: l.description, quantityMilli: q, unitPrice: p.minor, discountBps: d, taxBps: l.taxBps };
  });
  const valid = built.every(Boolean) && built.length > 0;
  let totals: ReturnType<typeof invoiceTotals> | null = null;
  try {
    totals = valid ? invoiceTotals(built as InvoiceLine[]) : null;
  } catch {
    totals = null;
  }
  const upd = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = async (post: boolean) => {
    setError(null);
    try {
      const r = await run<{ invoiceId: string }>("saveInvoiceDraft", { workspaceId: ws!.id, invoiceId: existing?.id, partyId, date, dueDate: dueDate || null, currency, lines: built, notes }, cmd);
      if (post) await run("postInvoice", { invoiceId: r.invoiceId });
      toast(t("saved"));
      go("/more/invoices");
    } catch (e) {
      setError(errorMessage(lang, e));
    }
  };
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("invoiceNew")}</h1>
      <section className="card stack p-4">
        <Field label={t("person")}>
          <PartyPicker partyId={partyId} name={name} onPick={setPartyId} onName={setName} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("date")}>
            <input type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t("dueDate")}>
            <input type="date" className="input" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        {lines.map((l, i) => {
          const lt = built[i] ? lineTotals(built[i]!) : null;
          return (
            <div key={i} className="grid gap-2 border-t pt-3 sm:grid-cols-[2fr_70px_110px_80px_auto_auto]" style={{ borderColor: "var(--line)" }}>
              <input className="input" placeholder={t("lineDesc")} value={l.description} onChange={(e) => upd(i, { description: e.target.value })} />
              <input className="input num" inputMode="decimal" placeholder={t("qty")} value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
              <input className="input num" inputMode="decimal" placeholder={t("unitPrice")} value={l.price} onChange={(e) => upd(i, { price: e.target.value })} />
              <input className="input num" inputMode="decimal" placeholder={t("discount")} value={l.discount} onChange={(e) => upd(i, { discount: e.target.value })} />
              {ws!.settings.invoices.taxRates.length > 0 ? (
                <select className="input" value={l.taxBps} onChange={(e) => upd(i, { taxBps: Number(e.target.value) })} aria-label={t("tax")}>
                  <option value={0}>{t("tax")}: 0</option>
                  {ws!.settings.invoices.taxRates.map((r) => (
                    <option key={r.id} value={r.bps}>
                      {r.label} {r.bps / 100}%
                    </option>
                  ))}
                </select>
              ) : (
                <span />
              )}
              <span className="flex items-center gap-1">
                {lt && <Money minor={lt.total} currency={currency} />}
                <button className="icon-btn" aria-label={t("delete")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                  <Trash2 size={16} />
                </button>
              </span>
            </div>
          );
        })}
        <button className="btn btn-sm w-fit" onClick={() => setLines((ls) => [...ls, { description: "", qty: "1", price: "", discount: "", taxBps: 0 }])}>
          <Plus size={15} /> {t("addLine")}
        </button>
        {totals && (
          <div className="ms-auto grid w-64 gap-1 text-[14px]">
            <p className="flex justify-between">
              <span>{t("subtotal")}</span>
              <Money minor={totals.subtotal} currency={currency} />
            </p>
            {totals.discount > 0 && (
              <p className="flex justify-between">
                <span>{t("discount")}</span>
                <Money minor={totals.discount} currency={currency} />
              </p>
            )}
            {totals.tax > 0 && (
              <p className="flex justify-between">
                <span>{t("tax")}</span>
                <Money minor={totals.tax} currency={currency} />
              </p>
            )}
            <p className="flex justify-between font-bold">
              <span>{t("total")}</span>
              <Money minor={totals.total} currency={currency} />
            </p>
          </div>
        )}
        <Field label={t("notes")}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="help">{t("invoiceNote")}</p>
        {error && <p className="banner banner-late">{error}</p>}
        <div className="flex gap-2">
          <button className="btn flex-1" disabled={!partyId || !totals} onClick={() => save(false)}>
            {t("saveDraft")}
          </button>
          <button className="btn btn-primary flex-1" disabled={!partyId || !totals} onClick={() => save(true)}>
            {t("postInvoice")}
          </button>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- recurring

export function Recurring() {
  const { t, data, ws, idx, lang, run, toast, today } = useApp();
  const [partyId, setPartyId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("receivable");
  const [amount, setAmount, parsed, ready] = useAmount(ws!.defaultCurrency);
  const [description, setDescription] = useState("");
  const [frequency, setFrequency] = useState<"monthly" | "weekly">("monthly");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [cmd, setCmd] = useState(() => newCommandId());
  const plans = data.recurringPlans.filter((p) => p.workspaceId === ws?.id);
  const act = async (type: string, payload: Record<string, unknown>) => {
    try {
      await run(type, payload);
      toast(t("saved"));
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("recurring")}</h1>
      <p className="help">{t("recurringNote")}</p>
      {plans.map((p) => {
        const paused = p.pauses.some((x) => !x.to);
        const next = p.state === "active" && !paused ? nextOccurrences(p, today, 3) : [];
        return (
          <section key={p.id} className="card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-bold">
                  {p.description} · {idx?.party.get(p.partyId)?.displayName}
                </p>
                <p className="help">
                  <span className={p.direction === "receivable" ? "owed" : "owe"}>
                    <Money minor={p.amount} currency={p.currency} />
                  </span>{" "}
                  · {t(p.frequency)} · {p.state === "ended" ? t("ended") : paused ? t("paused") : t("active")}
                </p>
                {next.length > 0 && (
                  <p className="help">
                    {t("nextDates")}:{" "}
                    {next.map((o) => (
                      <bdi key={o.periodKey} className="num me-2">
                        {formatDate(o.date, lang)}
                      </bdi>
                    ))}
                  </p>
                )}
              </div>
              {p.state === "active" && (
                <div className="flex flex-wrap gap-1">
                  <button className="btn btn-sm" onClick={() => act("updateRecurringPlan", { planId: p.id, action: paused ? "resume" : "pause" })}>
                    {paused ? t("resume") : t("pause")}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => act("updateRecurringPlan", { planId: p.id, action: "end" })}>
                    {t("end")}
                  </button>
                </div>
              )}
            </div>
          </section>
        );
      })}
      <form
        className="card stack p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await run("createRecurringPlan", { workspaceId: ws!.id, partyId, direction, currency: ws!.defaultCurrency, amount: parsed.ok ? parsed.minor : 0, description, frequency, startDate, endDate: endDate || null }, cmd);
            await run("generateRecurring", { workspaceId: ws!.id });
            setCmd(newCommandId());
            setDescription("");
            setAmount({ text: "" });
            toast(t("saved"));
          } catch (err) {
            toast(errorMessage(lang, err));
          }
        }}
      >
        <h2 className="section-title">{t("add")}</h2>
        <Seg value={direction} onChange={setDirection} options={[{ value: "receivable", label: t("owedToMe") }, { value: "payable", label: t("iOwe") }]} />
        <PartyPicker partyId={partyId} name={name} onPick={setPartyId} onName={setName} />
        <Field label={t("description")}>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t("amount")}>
          <AmountInput currency={ws!.defaultCurrency} state={amount} onChange={setAmount} parsed={parsed} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t("frequency")}>
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value as "monthly" | "weekly")}>
              <option value="monthly">{t("monthly")}</option>
              <option value="weekly">{t("weekly")}</option>
            </select>
          </Field>
          <Field label={t("startDate")}>
            <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label={t("endDate")}>
            <input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-primary" disabled={!partyId || !ready || !description.trim()}>
          {t("save")}
        </button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- quick notes → reviewed drafts

export function Notes() {
  const { t, data, ws, idx, today, run, toast, lang } = useApp();
  const open = useSheet();
  const [text, setText] = useState("");
  const notes = data.notes.filter((n) => n.workspaceId === ws?.id && !n.archivedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("draftNotes")}</h1>
      <form
        className="card stack p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await run("addNote", { workspaceId: ws!.id, text });
            setText("");
          } catch (err) {
            toast(errorMessage(lang, err));
          }
        }}
      >
        <textarea className="input" placeholder={t("quickNotePh")} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" disabled={!text.trim()}>
          {t("save")}
        </button>
      </form>
      {notes.map((n) => {
        const d = parseSentence(n.text, idx?.parties ?? [], today, ws!.defaultCurrency);
        return (
          <section key={n.id} className="card p-4">
            <p className="whitespace-pre-wrap">{n.text}</p>
            <p className="help mt-2">
              {t("parsedDraft")}: {d.name || "?"}
              {d.uncertain.includes("party") && <span className="chip chip-soon ms-1">{t("person")} · {t("uncertain")}</span>} · {d.amountText || "?"}
              {d.uncertain.includes("amount") && <span className="chip chip-soon ms-1">{t("amount")} · {t("uncertain")}</span>} · {d.direction ? t(d.direction === "receivable" ? "owedToMe" : "iOwe") : "?"}
              {d.uncertain.includes("direction") && <span className="chip chip-soon ms-1">{t("uncertain")}</span>}
              {d.uncertain.includes("date") && <span className="chip chip-soon ms-1">{t("date")} · {t("uncertain")}</span>}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className="btn btn-sm btn-primary"
                onClick={() =>
                  open({ kind: "debt", direction: d.direction ?? "receivable", partyId: d.partyId ?? undefined, noteId: n.id, prefill: { name: d.partyId ? undefined : d.name, amount: d.amountText, description: n.text.slice(0, 200), date: d.date } })
                }
              >
                {t("convert")}
              </button>
              <button className="btn btn-sm" onClick={() => run("updateNote", { noteId: n.id, archived: true })}>
                {t("archivePerson")}
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}
