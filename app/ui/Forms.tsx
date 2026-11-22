"use client";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Copy, Mail, MessageCircle, Smartphone } from "lucide-react";
import { useApp, newCommandId } from "@/lib/ui/state";
import type { SheetSpec } from "@/lib/ui/sheets";
import { AmountInput, CurrencySelect, DirectionPicker, Field, Money, PartyPicker, Seg, Sheet, go, readFileAttachment, useAmount } from "@/lib/ui/components";
import { errorMessage } from "@/lib/ui/i18n";
import { addDays, formatDate } from "@/lib/core/dates";
import { figuresOf, openObligations, partyBalance, paymentFiguresOf, planAllocation } from "@/lib/core/ledger";
import { buildSchedule } from "@/lib/core/installments";
import { parseAmount, toInputValue } from "@/lib/core/money";
import { reminderMessage, shareUrl } from "@/lib/core/messages";
import { whatsappDigits } from "@/lib/core/text";
import type { Direction, PaymentMethod } from "@/lib/core/types";

/** Runs an async save, keeps the form open with a readable error when it fails. */
function useSubmit() {
  const { lang } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, unknown> | null>(null);
  const submit = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      await fn();
    } catch (e) {
      setCode((e as { code?: string }).code ?? null);
      setDetails(((e as { details?: Record<string, unknown> }).details as Record<string, unknown>) ?? null);
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, code, details, submit, setError };
}

function Footer({ busy, onCancel, label, disabled, tone = "primary" }: { busy: boolean; onCancel: () => void; label?: string; disabled?: boolean; tone?: "primary" | "danger" }) {
  const { t } = useApp();
  return (
    <div className="sticky bottom-0 -mx-4 mt-4 flex gap-2 border-t px-4 pt-3 sm:static sm:mx-0 sm:border-0 sm:px-0" style={{ background: "var(--surface)", borderColor: "var(--line)" }}>
      <button type="button" className="btn flex-1" onClick={onCancel}>
        {t("cancel")}
      </button>
      <button type="submit" className={`btn flex-[2] ${tone === "danger" ? "btn-danger" : "btn-primary"}`} disabled={busy || disabled}>
        {busy ? t("saving") : (label ?? t("save"))}
      </button>
    </div>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner banner-late" role="alert">
      {error}
    </div>
  );
}

export function SheetHost({ spec, onClose }: { spec: SheetSpec; onClose: () => void }) {
  switch (spec.kind) {
    case "debt":
      return <DebtSheet spec={spec} onClose={onClose} />;
    case "payment":
      return <PaymentSheet spec={spec} onClose={onClose} />;
    case "party":
      return <PartySheet partyId={spec.partyId} onClose={onClose} />;
    case "adjust":
      return <AdjustSheet obligationId={spec.obligationId} onClose={onClose} />;
    case "void":
      return <VoidSheet obligationId={spec.obligationId} onClose={onClose} />;
    case "replace":
      return <ReplaceSheet obligationId={spec.obligationId} onClose={onClose} />;
    case "reverse":
      return <ReverseSheet paymentId={spec.paymentId} onClose={onClose} />;
    case "installments":
      return <InstallmentsSheet obligationId={spec.obligationId} onClose={onClose} />;
    case "dates":
      return <DatesSheet obligationId={spec.obligationId} onClose={onClose} />;
    case "promise":
      return <PromiseSheet partyId={spec.partyId} onClose={onClose} />;
    case "remind":
      return <RemindSheet partyId={spec.partyId} onClose={onClose} />;
    case "netting":
      return <NettingSheet partyId={spec.partyId} currency={spec.currency} onClose={onClose} />;
    case "merge":
      return <MergeSheet partyId={spec.partyId} onClose={onClose} />;
    case "snooze":
      return <SnoozeSheet partyId={spec.partyId} onClose={onClose} />;
    case "applyAdvance":
      return <ApplyAdvanceSheet paymentId={spec.paymentId} onClose={onClose} />;
  }
}

// ---------------------------------------------------------------- quick add debt

function DebtSheet({ spec, onClose }: { spec: Extract<SheetSpec, { kind: "debt" }>; onClose: () => void }) {
  const { ws, idx, t, run, toast, today, lang, prefs } = useApp();
  const [direction, setDirection] = useState<Direction>(spec.direction ?? "receivable");
  const [partyId, setPartyId] = useState<string | null>(spec.partyId ?? null);
  const [name, setName] = useState(spec.prefill?.name ?? "");
  const [currency, setCurrency] = useState(ws!.defaultCurrency);
  const [amount, setAmount, parsed, amountReady] = useAmount(currency, spec.prefill?.amount ?? "");
  const [more, setMore] = useState(false);
  const [date, setDate] = useState(spec.prefill?.date ?? today);
  const [dueDate, setDueDate] = useState("");
  const [remindOn, setRemindOn] = useState("");
  const [description, setDescription] = useState(spec.prefill?.description ?? "");
  const [reference, setReference] = useState("");
  const [tags, setTags] = useState("");
  const [draft, setDraft] = useState(false);
  const [inst, setInst] = useState({ on: false, frequency: "monthly" as "monthly" | "weekly", count: "3", start: addDays(today, 30) });
  const [file, setFile] = useState<File | null>(null);
  const [override, setOverride] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const ids = useMemo(() => ({ party: newCommandId(), ob: newCommandId(), att: newCommandId() }), []);
  const s = useSubmit();
  const dupIds = (s.code === "possible_duplicate" ? (s.details?.ids as string[]) : null) ?? [];
  const showErrors = !!s.error;
  const schedule = useMemo(() => {
    if (!inst.on || !parsed.ok) return null;
    try {
      return buildSchedule({ total: parsed.minor, frequency: inst.frequency, count: Number(inst.count), startDate: inst.start });
    } catch {
      return null;
    }
  }, [inst, parsed]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void s.submit(async () => {
      if (!parsed.ok) throw Object.assign(new Error("amount_positive"), { code: "amount_positive" });
      let pid = partyId;
      if (!pid) {
        if (!name.trim()) throw Object.assign(new Error("name_required"), { code: "name_required" });
        pid = (await run<{ partyId: string }>("createParty", { workspaceId: ws!.id, displayName: name.trim(), allowDuplicate: allowDup }, allowDup ? ids.party + "-dup" : ids.party)).partyId;
        setPartyId(pid);
      }
      const r = await run<{ obligationId: string }>(
        "createObligation",
        {
          workspaceId: ws!.id,
          partyId: pid,
          direction,
          currency,
          principal: parsed.minor,
          date,
          dueDate: dueDate || null,
          remindOn: remindOn || null,
          description,
          reference,
          tags: tags.split(",").map((x) => x.trim()).filter(Boolean),
          draft,
          creditOverrideReason: override || undefined,
          installments: inst.on && !draft ? { frequency: inst.frequency, count: Number(inst.count), startDate: inst.start } : undefined,
        },
        ids.ob,
      );
      if (file) await run("addAttachment", { workspaceId: ws!.id, ownerType: "obligation", ownerId: r.obligationId, ...(await readFileAttachment(file)) }, ids.att);
      if (spec.noteId) await run("updateNote", { noteId: spec.noteId, convertedTo: { type: "obligation", id: r.obligationId } });
      toast(t("saved"));
      onClose();
    });
  };

  return (
    <Sheet title={direction === "receivable" ? t("addOwedToMe") : t("addIOwe")} onClose={onClose}>
      <form onSubmit={save} className="stack" noValidate>
        <DirectionPicker value={direction} onChange={setDirection} />
        <Field label={t("person")} htmlFor="debt-person">
          <PartyPicker id="debt-person" partyId={partyId} name={name} onPick={setPartyId} onName={setName} autoFocus={!spec.partyId} />
        </Field>
        {dupIds.length > 0 && (
          <div className="banner banner-warn grid gap-2">
            <p>{t("duplicateFound")}</p>
            {dupIds.map((id) => (
              <button key={id} type="button" className="btn btn-sm justify-start" onClick={() => { setPartyId(id); s.setError(null); }}>
                {t("useExisting")}: {idx?.party.get(id)?.displayName}
              </button>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => { setAllowDup(true); s.setError(null); }}>
              {t("createAnyway")}
            </button>
          </div>
        )}
        <Field label={t("amount")} htmlFor="debt-amount">
          <AmountInput id="debt-amount" currency={currency} state={amount} onChange={setAmount} parsed={parsed} showErrors={showErrors} autoFocus={!!spec.partyId} />
        </Field>
        <button type="button" className="btn btn-ghost btn-sm w-full" onClick={() => setMore((m) => !m)} aria-expanded={more}>
          {more ? <ChevronUp size={16} /> : <ChevronDown size={16} />} {more ? t("fewerOptions") : t("moreOptions")}
        </button>
        {more && (
          <div className="stack">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("date")} htmlFor="debt-date">
                <input id="debt-date" type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label={t("currency")} htmlFor="debt-cur">
                <CurrencySelect id="debt-cur" value={currency} onChange={setCurrency} />
              </Field>
            </div>
            <Field label={t("dueDate")} htmlFor="debt-due">
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {[
                  ["", t("noDueDate")],
                  [addDays(date, 7), t("in7")],
                  [addDays(date, 30), t("in30")],
                ].map(([v, l]) => (
                  <button key={l} type="button" className="chip" style={dueDate === v ? { background: "var(--ink)", color: "var(--paper)", minHeight: 30 } : { minHeight: 30 }} onClick={() => setDueDate(v)}>
                    {l}
                  </button>
                ))}
              </div>
              <input id="debt-due" type="date" className="input" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label={t("description")} htmlFor="debt-desc">
              <input id="debt-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("reference")} htmlFor="debt-ref">
                <input id="debt-ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              </Field>
              <Field label={t("remindOn")} htmlFor="debt-remind">
                <input id="debt-remind" type="date" className="input" value={remindOn} onChange={(e) => setRemindOn(e.target.value)} />
              </Field>
            </div>
            <Field label={t("tags")} help={t("tagsHelp")} htmlFor="debt-tags">
              <input id="debt-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={inst.on} onChange={(e) => setInst({ ...inst, on: e.target.checked })} />
              <span className="font-semibold">{t("installments")}</span>
            </label>
            {inst.on && (
              <div className="card stack p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t("installmentsCount")}>
                    <input className="input num" inputMode="numeric" value={inst.count} onChange={(e) => setInst({ ...inst, count: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
                  </Field>
                  <Field label={t("frequency")}>
                    <select className="input" value={inst.frequency} onChange={(e) => setInst({ ...inst, frequency: e.target.value as "monthly" | "weekly" })}>
                      <option value="monthly">{t("monthly")}</option>
                      <option value="weekly">{t("weekly")}</option>
                    </select>
                  </Field>
                  <Field label={t("firstInstallment")}>
                    <input type="date" className="input" value={inst.start} onChange={(e) => setInst({ ...inst, start: e.target.value })} />
                  </Field>
                </div>
                {schedule && (
                  <ul className="grid gap-0.5 text-[13px]">
                    {schedule.map((it) => (
                      <li key={it.seq} className="flex justify-between">
                        <span className="num">{formatDate(it.dueDate, lang)}</span>
                        <Money minor={it.amount} currency={currency} />
                      </li>
                    ))}
                  </ul>
                )}
                <p className="help">{t("installmentNote")}</p>
              </div>
            )}
            <Field label={t("attachment")} help={t("attachHelp")} htmlFor="debt-file">
              <input id="debt-file" type="file" accept="image/*,application/pdf" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              <span>{t("saveDraft")}</span>
            </label>
          </div>
        )}
        {s.code === "credit_limit" && (
          <Field label={t("reason")} htmlFor="debt-override">
            <input id="debt-override" className="input" value={override} onChange={(e) => setOverride(e.target.value)} />
          </Field>
        )}
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!amountReady || (!partyId && !name.trim())} label={direction === "receivable" ? `${t("save")} · ${t(prefs.dzWording ? "owedToMeDz" : "owedToMe")}` : `${t("save")} · ${t(prefs.dzWording ? "iOweDz" : "iOwe")}`} />
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- repayment with allocation preview

const METHODS: PaymentMethod[] = ["cash", "bank_transfer", "ccp_baridimob", "card", "other"];

function PaymentSheet({ spec, onClose }: { spec: Extract<SheetSpec, { kind: "payment" }>; onClose: () => void }) {
  const { ws, idx, t, run, toast, today, lang } = useApp();
  const [partyId, setPartyId] = useState<string | null>(spec.partyId ?? null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>(spec.direction ?? "receivable");
  const [currency, setCurrency] = useState(spec.currency ?? ws!.defaultCurrency);
  const [amount, setAmount, parsed, amountReady] = useAmount(currency);
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [manual, setManual] = useState(false);
  const [manualLines, setManualLines] = useState<Record<string, string>>({});
  const [allowAdvance, setAllowAdvance] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const ids = useMemo(() => ({ pay: newCommandId(), att: newCommandId() }), []);
  const s = useSubmit();
  const open = useMemo(() => (idx && partyId ? openObligations(idx, partyId, direction, currency) : []), [idx, partyId, direction, currency]);
  const totalOpen = open.reduce((n, x) => n + x.outstanding, 0);
  const amountMinor = parsed.ok ? parsed.minor : 0;
  const autoPlan = useMemo(() => planAllocation(open, amountMinor), [open, amountMinor]);
  const lines = manual
    ? open
        .map((x) => {
          const r = parseAmount(manualLines[x.obligation.id] ?? "", currency);
          return { obligationId: x.obligation.id, amount: r.ok ? r.minor : 0, bad: !!(manualLines[x.obligation.id] ?? "").trim() && !r.ok, over: r.ok && r.minor > x.outstanding };
        })
        .filter((l) => l.amount > 0 || l.bad)
    : autoPlan.lines.map((l) => ({ ...l, bad: false, over: false }));
  const allocated = lines.reduce((n, l) => n + l.amount, 0);
  const excess = amountMinor - allocated;
  const invalidManual = lines.some((l) => l.bad || l.over) || allocated > amountMinor;
  const startManual = () => {
    setManual(true);
    setManualLines(Object.fromEntries(autoPlan.lines.map((l) => [l.obligationId, toInputValue(l.amount, currency, lang)])));
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void s.submit(async () => {
      if (!partyId) throw Object.assign(new Error("name_required"), { code: "name_required" });
      const r = await run<{ paymentId: string }>(
        "recordPayment",
        {
          workspaceId: ws!.id,
          partyId,
          direction,
          currency,
          amount: amountMinor,
          date,
          method,
          reference,
          note,
          allowAdvance: excess > 0 && allowAdvance,
          allocations: manual ? lines.map(({ obligationId, amount }) => ({ obligationId, amount })) : "auto",
        },
        ids.pay,
      );
      if (file) await run("addAttachment", { workspaceId: ws!.id, ownerType: "payment", ownerId: r.paymentId, ...(await readFileAttachment(file)) }, ids.att);
      toast(t("saved"));
      onClose();
    });
  };
  return (
    <Sheet title={t("recordRepayment")} onClose={onClose}>
      <form onSubmit={save} className="stack" noValidate>
        <Seg<Direction>
          value={direction}
          onChange={setDirection}
          options={[
            { value: "receivable", label: t("repaymentReceived") },
            { value: "payable", label: t("repaymentPaid") },
          ]}
        />
        <Field label={direction === "receivable" ? t("receivedFrom") : t("paidTo")} htmlFor="pay-person">
          <PartyPicker id="pay-person" partyId={partyId} name={name} onPick={setPartyId} onName={setName} autoFocus={!spec.partyId} />
        </Field>
        {partyId && totalOpen > 0 && (
          <p className="help">
            {t("remaining")}: <b className={direction === "receivable" ? "owed" : "owe"}>
              <Money minor={totalOpen} currency={currency} />
            </b>
          </p>
        )}
        <Field label={t("amount")} htmlFor="pay-amount">
          <AmountInput id="pay-amount" currency={currency} state={amount} onChange={setAmount} parsed={parsed} showErrors={!!s.error} autoFocus={!!spec.partyId} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("date")} htmlFor="pay-date">
            <input id="pay-date" type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t("currency")} htmlFor="pay-cur">
            <CurrencySelect id="pay-cur" value={currency} onChange={setCurrency} />
          </Field>
        </div>
        <Field label={t("method")} help={t("methodNote")}>
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map((m) => (
              <button key={m} type="button" className="chip" style={method === m ? { background: "var(--ink)", color: "var(--paper)", minHeight: 32 } : { minHeight: 32 }} onClick={() => setMethod(m)}>
                {t(`m_${m}` as never)}
              </button>
            ))}
          </div>
        </Field>
        {partyId && amountMinor > 0 && (
          <section className="card p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="label m-0">{t("allocation")}</p>
              <Seg<"auto" | "manual">
                value={manual ? "manual" : "auto"}
                onChange={(v) => (v === "manual" ? startManual() : setManual(false))}
                options={[
                  { value: "auto", label: t("oldestFirst") },
                  { value: "manual", label: t("manual") },
                ]}
              />
            </div>
            {open.length === 0 && <p className="help">{t("noOpenDebts")}</p>}
            {open
              .slice()
              .sort((a, b) => (a.obligation.dueDate ?? a.obligation.date).localeCompare(b.obligation.dueDate ?? b.obligation.date))
              .map((x) => {
                const line = lines.find((l) => l.obligationId === x.obligation.id);
                return (
                  <div key={x.obligation.id} className="flex items-center gap-2 border-t py-2 text-[14px]" style={{ borderColor: "var(--line)" }}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{x.obligation.description || formatDate(x.obligation.date, lang)}</span>
                      <span className="help">
                        {x.obligation.dueDate ? `${t("dueIn")} ${formatDate(x.obligation.dueDate, lang)} · ` : ""}
                        <Money minor={x.outstanding} currency={currency} />
                      </span>
                    </span>
                    {manual ? (
                      <input
                        className="input num w-28"
                        style={{ direction: "ltr" }}
                        inputMode="decimal"
                        value={manualLines[x.obligation.id] ?? ""}
                        aria-invalid={!!(line?.bad || line?.over)}
                        aria-label={t("amount")}
                        onChange={(e) => setManualLines({ ...manualLines, [x.obligation.id]: e.target.value })}
                      />
                    ) : (
                      <b>
                        <Money minor={line?.amount ?? 0} currency={currency} />
                      </b>
                    )}
                  </div>
                );
              })}
            {open.length > 0 && (
              <p className="help mt-2 border-t pt-2" style={{ borderColor: "var(--line)" }}>
                {t("remainingAfter")}: <b>
                  <Money minor={Math.max(0, totalOpen - allocated)} currency={currency} />
                </b>
              </p>
            )}
          </section>
        )}
        {partyId && excess > 0 && !invalidManual && (
          <div className="banner banner-warn grid gap-2">
            <p>
              {t("excessTitle")} <b>
                <Money minor={excess} currency={currency} />
              </b>
            </p>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={allowAdvance} onChange={(e) => setAllowAdvance(e.target.checked)} />
              {t("recordAdvance")}
            </label>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("reference")} htmlFor="pay-ref">
            <input id="pay-ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label={t("attachment")} htmlFor="pay-file">
            <input id="pay-file" type="file" accept="image/*,application/pdf" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <Field label={t("notes")} htmlFor="pay-note">
          <input id="pay-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!amountReady || !partyId || invalidManual || (excess > 0 && !allowAdvance)} />
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- person form

function PartySheet({ partyId, onClose }: { partyId?: string; onClose: () => void }) {
  const { ws, idx, t, run, toast } = useApp();
  const existing = partyId ? idx?.party.get(partyId) : undefined;
  const [f, setF] = useState({
    kind: existing?.kind ?? "person",
    displayName: existing?.displayName ?? "",
    phone1: existing?.phones[0] ?? "",
    phone2: existing?.phones[1] ?? "",
    email: existing?.email ?? "",
    address: existing?.address ?? "",
    taxId: existing?.taxId ?? "",
    tags: existing?.tags.join(", ") ?? "",
    isCustomer: existing?.isCustomer ?? false,
    isSupplier: existing?.isSupplier ?? false,
    notes: existing?.notes ?? "",
    limit: existing?.creditLimits?.[ws!.defaultCurrency] ? toInputValue(existing.creditLimits[ws!.defaultCurrency], ws!.defaultCurrency, "fr") : "",
  });
  const [allowDup, setAllowDup] = useState(false);
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  const set = (p: Partial<typeof f>) => setF((o) => ({ ...o, ...p }));
  const dupIds = (s.code === "possible_duplicate" ? (s.details?.ids as string[]) : null) ?? [];
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void s.submit(async () => {
      const limit = f.limit.trim() ? parseAmount(f.limit, ws!.defaultCurrency) : null;
      if (limit && !limit.ok) throw Object.assign(new Error("amount_invalid"), { code: "amount_invalid" });
      const fields = {
        kind: f.kind,
        displayName: f.displayName,
        phones: [f.phone1, f.phone2].filter((x) => x.trim()),
        email: f.email,
        address: f.address,
        taxId: f.taxId,
        tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean),
        isCustomer: f.isCustomer,
        isSupplier: f.isSupplier,
        notes: f.notes,
        creditLimits: limit?.ok ? { [ws!.defaultCurrency]: limit.minor } : {},
      };
      if (existing) await run("updateParty", { partyId: existing.id, changes: fields }, cmd);
      else {
        const r = await run<{ partyId: string }>("createParty", { workspaceId: ws!.id, ...fields, allowDuplicate: allowDup }, allowDup ? cmd + "-dup" : cmd);
        go(`/people/${r.partyId}`);
      }
      toast(t("saved"));
      onClose();
    });
  };
  return (
    <Sheet title={existing ? t("editPerson") : t("newPerson")} onClose={onClose}>
      <form onSubmit={save} className="stack" noValidate>
        <Seg value={f.kind} onChange={(kind) => set({ kind })} options={[{ value: "person", label: t("kindPerson") }, { value: "organization", label: t("kindOrg") }]} />
        <Field label={t("displayName")} help={t("displayNameHelp")} htmlFor="p-name">
          <input id="p-name" className="input" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={120} autoFocus />
        </Field>
        {dupIds.length > 0 && (
          <div className="banner banner-warn grid gap-2">
            <p>{t("duplicateFound")}</p>
            {dupIds.map((id) => (
              <a key={id} className="btn btn-sm justify-start" href={`#/people/${id}`} onClick={onClose}>
                {t("useExisting")}: {idx?.party.get(id)?.displayName}
              </a>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => { setAllowDup(true); s.setError(null); }}>
              {t("createAnyway")}
            </button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("phone")} htmlFor="p-ph1">
            <input id="p-ph1" className="input num" style={{ direction: "ltr" }} type="tel" inputMode="tel" value={f.phone1} onChange={(e) => set({ phone1: e.target.value })} placeholder="0550 00 00 00" />
          </Field>
          <Field label={`${t("phone")} 2`} htmlFor="p-ph2">
            <input id="p-ph2" className="input num" style={{ direction: "ltr" }} type="tel" inputMode="tel" value={f.phone2} onChange={(e) => set({ phone2: e.target.value })} />
          </Field>
        </div>
        <details>
          <summary className="btn btn-ghost btn-sm w-full">{t("moreOptions")}</summary>
          <div className="stack mt-3">
            <Field label={t("email")} htmlFor="p-email">
              <input id="p-email" className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label={t("address")} htmlFor="p-addr">
              <input id="p-addr" className="input" value={f.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label={t("tags")} help={t("tagsHelp")} htmlFor="p-tags">
              <input id="p-tags" className="input" value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
            </Field>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={f.isCustomer} onChange={(e) => set({ isCustomer: e.target.checked })} /> {t("customer")}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={f.isSupplier} onChange={(e) => set({ isSupplier: e.target.checked })} /> {t("supplier")}
              </label>
            </div>
            {ws!.mode === "business" && (
              <Field label={t("taxId")} htmlFor="p-tax">
                <input id="p-tax" className="input" value={f.taxId} onChange={(e) => set({ taxId: e.target.value })} />
              </Field>
            )}
            <Field label={`${t("creditLimit")} (${ws!.defaultCurrency})`} help={t("creditLimitHelp")} htmlFor="p-limit">
              <input id="p-limit" className="input num" style={{ direction: "ltr" }} inputMode="decimal" value={f.limit} onChange={(e) => set({ limit: e.target.value })} />
            </Field>
            <Field label={t("notes")} htmlFor="p-notes">
              <textarea id="p-notes" className="input" value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={2000} />
            </Field>
          </div>
        </details>
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!f.displayName.trim()} />
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- corrections

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useApp();
  return (
    <Field label={t("reason")} help={t("reasonRequired")} htmlFor="reason">
      <input id="reason" className="input" value={value} onChange={(e) => onChange(e.target.value)} maxLength={300} />
    </Field>
  );
}

function ObligationSummary({ obligationId }: { obligationId: string }) {
  const { idx, lang, t } = useApp();
  const ob = idx?.obligation.get(obligationId);
  if (!ob || !idx) return null;
  const f = figuresOf(idx, ob);
  return (
    <div className="card p-3 text-[14px]">
      <p className="font-semibold">{ob.description || t(ob.direction === "receivable" ? "owedToMe" : "iOwe")}</p>
      <p className="help">
        {idx.party.get(ob.partyId)?.displayName} · <bdi className="num">{formatDate(ob.date, lang)}</bdi> · {t("original")} <Money minor={ob.principal} currency={ob.currency} /> · {t("remaining")}{" "}
        <b>
          <Money minor={f.outstanding} currency={ob.currency} />
        </b>
      </p>
    </div>
  );
}

function AdjustSheet({ obligationId, onClose }: { obligationId: string; onClose: () => void }) {
  const { idx, t, run, toast, today } = useApp();
  const ob = idx!.obligation.get(obligationId)!;
  const [type, setType] = useState<"increase" | "decrease" | "waiver" | "write_off">("waiver");
  const [amount, setAmount, parsed, ready] = useAmount(ob.currency);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("adjust")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("adjustObligation", { obligationId, type, amount: parsed.ok ? parsed.minor : 0, date, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <ObligationSummary obligationId={obligationId} />
        <Seg value={type} onChange={setType} options={(["waiver", "write_off", "decrease", "increase"] as const).map((v) => ({ value: v, label: t(`a_${v}`) }))} />
        <Field label={t("amount")}>
          <AmountInput currency={ob.currency} state={amount} onChange={setAmount} parsed={parsed} />
        </Field>
        <Field label={t("date")}>
          <input type="date" className="input" value={date} min={ob.date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!ready || !reason.trim()} />
      </form>
    </Sheet>
  );
}

function VoidSheet({ obligationId, onClose }: { obligationId: string; onClose: () => void }) {
  const { t, run, toast } = useApp();
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("voidDebt")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("voidObligation", { obligationId, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <ObligationSummary obligationId={obligationId} />
        <p className="help">{t("voidHelp")}</p>
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!reason.trim()} label={t("voidDebt")} tone="danger" />
      </form>
    </Sheet>
  );
}

function ReplaceSheet({ obligationId, onClose }: { obligationId: string; onClose: () => void }) {
  const { idx, t, run, toast, today, lang } = useApp();
  const ob = idx!.obligation.get(obligationId)!;
  const [amount, setAmount, parsed, ready] = useAmount(ob.currency, toInputValue(ob.principal, ob.currency, lang));
  const [date, setDate] = useState(ob.date);
  const [dueDate, setDueDate] = useState(ob.dueDate ?? "");
  const [description, setDescription] = useState(ob.description);
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("replace")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("replaceObligation", { obligationId, reason, changes: { principal: parsed.ok ? parsed.minor : 0, date, dueDate: dueDate || null, description } }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <ObligationSummary obligationId={obligationId} />
        <Field label={t("amount")}>
          <AmountInput currency={ob.currency} state={amount} onChange={setAmount} parsed={parsed} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("date")}>
            <input type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t("dueDate")}>
            <input type="date" className="input" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label={t("description")}>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!ready || !reason.trim()} />
      </form>
    </Sheet>
  );
}

function ReverseSheet({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const { idx, t, run, toast, lang } = useApp();
  const p = idx!.payment.get(paymentId)!;
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("reverse")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("reversePayment", { paymentId, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <div className="card p-3">
          <p className="font-semibold">
            <Money minor={p.amount} currency={p.currency} /> · <bdi className="num">{formatDate(p.date, lang)}</bdi>
          </p>
          <p className="help">{idx!.party.get(p.partyId)?.displayName}</p>
        </div>
        <p className="help">{t("reverseHelp")}</p>
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!reason.trim()} label={t("reverse")} tone="danger" />
      </form>
    </Sheet>
  );
}

function InstallmentsSheet({ obligationId, onClose }: { obligationId: string; onClose: () => void }) {
  const { idx, t, run, toast, today, lang } = useApp();
  const ob = idx!.obligation.get(obligationId)!;
  const outstanding = figuresOf(idx!, ob).outstanding;
  const hasPlan = (idx!.plansByOb.get(ob.id) ?? []).some((p) => p.state === "active");
  const [frequency, setFrequency] = useState<"monthly" | "weekly">("monthly");
  const [count, setCount] = useState("3");
  const [start, setStart] = useState(addDays(today, 30));
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  const preview = useMemo(() => {
    try {
      return buildSchedule({ total: outstanding, frequency, count: Number(count), startDate: start });
    } catch {
      return null;
    }
  }, [outstanding, frequency, count, start]);
  return (
    <Sheet title={hasPlan ? t("reschedule") : t("installments")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("createInstallmentPlan", { obligationId, frequency, count: Number(count), startDate: start, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <ObligationSummary obligationId={obligationId} />
        <div className="grid grid-cols-3 gap-2">
          <Field label={t("installmentsCount")}>
            <input className="input num" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Field>
          <Field label={t("frequency")}>
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value as "monthly" | "weekly")}>
              <option value="monthly">{t("monthly")}</option>
              <option value="weekly">{t("weekly")}</option>
            </select>
          </Field>
          <Field label={t("firstInstallment")}>
            <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
        </div>
        {preview && (
          <ul className="card grid gap-1 p-3 text-[14px]">
            {preview.map((it) => (
              <li key={it.seq} className="flex justify-between">
                <span>
                  <bdi className="num">{it.seq}</bdi>. <bdi className="num">{formatDate(it.dueDate, lang)}</bdi>
                </span>
                <Money minor={it.amount} currency={ob.currency} />
              </li>
            ))}
            <li className="flex justify-between border-t pt-1 font-bold" style={{ borderColor: "var(--line)" }}>
              <span>{t("total")}</span>
              <Money minor={preview.reduce((n, i) => n + i.amount, 0)} currency={ob.currency} />
            </li>
          </ul>
        )}
        <p className="help">{t("installmentNote")}</p>
        {hasPlan && <ReasonField value={reason} onChange={setReason} />}
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!preview || (hasPlan && !reason.trim())} />
      </form>
    </Sheet>
  );
}

function DatesSheet({ obligationId, onClose }: { obligationId: string; onClose: () => void }) {
  const { idx, t, run, toast } = useApp();
  const ob = idx!.obligation.get(obligationId)!;
  const [dueDate, setDueDate] = useState(ob.dueDate ?? "");
  const [remindOn, setRemindOn] = useState(ob.remindOn ?? "");
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("changeDates")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("setObligationDates", { obligationId, dueDate: dueDate || null, remindOn: remindOn || null, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <ObligationSummary obligationId={obligationId} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("dueDate")}>
            <input type="date" className="input" value={dueDate} min={ob.date} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label={t("remindOn")}>
            <input type="date" className="input" value={remindOn} onChange={(e) => setRemindOn(e.target.value)} />
          </Field>
        </div>
        <Field label={t("reason")}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} />
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- follow-up

function PromiseSheet({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { idx, ws, t, run, toast, today, lang } = useApp();
  const bal = partyBalance(idx!, partyId, today);
  const first = [...bal].find(([, b]) => b.receivable > 0);
  const [currency] = useState(first?.[0] ?? ws!.defaultCurrency);
  const [amount, setAmount, parsed, ready] = useAmount(currency, first ? toInputValue(first[1].receivable, currency, lang) : "");
  const [date, setDate] = useState(addDays(today, 7));
  const [note, setNote] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("promise")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("createPromise", { workspaceId: ws!.id, partyId, currency, amount: parsed.ok ? parsed.minor : 0, promisedDate: date, note }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <p className="banner">{t("promiseNote")}</p>
        <Field label={t("amount")}>
          <AmountInput currency={currency} state={amount} onChange={setAmount} parsed={parsed} />
        </Field>
        <Field label={t("promisedDate")}>
          <input type="date" className="input" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t("notes")}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!ready} />
      </form>
    </Sheet>
  );
}

export function ReminderComposer({ partyId, onDone, compact = false }: { partyId: string; onDone?: () => void; compact?: boolean }) {
  const { idx, ws, t, run, toast, today, lang } = useApp();
  const party = idx!.party.get(partyId)!;
  const amounts = [...partyBalance(idx!, partyId, today)].filter(([, b]) => b.receivable > 0).map(([currency, b]) => ({ currency, amount: b.receivable }));
  const [msgLang, setMsgLang] = useState(lang);
  const draft = useMemo(() => reminderMessage(msgLang, { name: party.displayName, amounts, business: ws!.business.name || ws!.name }), [msgLang, party.displayName, ws, amounts]);
  const [message, setMessage] = useState<string | null>(null);
  const [logged, setLogged] = useState<string | null>(null);
  const text = message ?? draft;
  const phone = party.phones[0];
  const wa = phone ? whatsappDigits(phone) : null;
  const ios = typeof navigator !== "undefined" && /iPhone|iPad/i.test(navigator.userAgent);
  const share = async (channel: "whatsapp" | "sms" | "email" | "copy") => {
    try {
      const r = await run<{ reminderId: string }>("logReminder", { workspaceId: ws!.id, partyId, channel, language: msgLang, message: text, status: channel === "copy" ? "prepared" : "opened_for_sharing", expectedAmounts: amounts });
      setLogged(r.reminderId);
      if (channel === "copy") {
        await navigator.clipboard.writeText(text);
        toast(t("copy") + " ✓");
      } else window.open(shareUrl(channel, channel === "whatsapp" ? wa! : channel === "sms" ? phone! : party.email, text, ios), "_blank", "noopener");
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <div className="stack">
      {!compact && <p className="help">{t("queueHelp")}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">
          {party.displayName}
          {amounts.map((a) => (
            <span key={a.currency} className="owed ms-2">
              <Money minor={a.amount} currency={a.currency} />
            </span>
          ))}
        </p>
        <select className="input w-auto" value={msgLang} onChange={(e) => { setMsgLang(e.target.value as typeof msgLang); setMessage(null); }} aria-label={t("language")}>
          <option value="ar">العربية</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </div>
      <textarea className="input min-h-[140px]" dir={msgLang === "ar" ? "rtl" : "ltr"} value={text} onChange={(e) => setMessage(e.target.value)} aria-label={t("remind")} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button type="button" className="btn btn-sm" disabled={!wa} onClick={() => share("whatsapp")}>
          <MessageCircle size={16} /> {t("whatsapp")}
        </button>
        <button type="button" className="btn btn-sm" disabled={!phone} onClick={() => share("sms")}>
          <Smartphone size={16} /> {t("sms")}
        </button>
        <button type="button" className="btn btn-sm" disabled={!party.email} onClick={() => share("email")}>
          <Mail size={16} /> {t("emailCh")}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => share("copy")}>
          <Copy size={16} /> {t("copy")}
        </button>
      </div>
      {logged && (
        <div className="banner grid gap-2">
          <p>{t("rs_opened_for_sharing")} — {t("queueHelp")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={async () => {
                await run("updateReminderStatus", { reminderId: logged, status: "marked_sent" });
                setLogged(null);
                onDone?.();
              }}
            >
              {t("markSent")}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setLogged(null); onDone?.(); }}>
              {t("skip")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RemindSheet({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { t } = useApp();
  return (
    <Sheet title={t("remind")} onClose={onClose}>
      <ReminderComposer partyId={partyId} onDone={onClose} />
    </Sheet>
  );
}

function NettingSheet({ partyId, currency, onClose }: { partyId: string; currency: string; onClose: () => void }) {
  const { idx, ws, t, run, toast, today, lang } = useApp();
  const b = partyBalance(idx!, partyId, today).get(currency);
  const max = Math.min(b?.receivable ?? 0, b?.payable ?? 0);
  const [amount, setAmount, parsed, ready] = useAmount(currency, toInputValue(max, currency, lang));
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("netting")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("netBalances", { workspaceId: ws!.id, partyId, currency, amount: parsed.ok ? parsed.minor : 0, reason }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <p className="help">{t("nettingHelp")}</p>
        <div className="grid grid-cols-2 gap-2 text-[14px]">
          <p className="owed font-bold">
            <Money minor={b?.receivable ?? 0} currency={currency} />
          </p>
          <p className="owe font-bold">
            <Money minor={b?.payable ?? 0} currency={currency} />
          </p>
        </div>
        <Field label={t("amount")}>
          <AmountInput currency={currency} state={amount} onChange={setAmount} parsed={parsed} />
        </Field>
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!ready || !reason.trim()} />
      </form>
    </Sheet>
  );
}

function MergeSheet({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { idx, t, run, toast, today } = useApp();
  const source = idx!.party.get(partyId)!;
  const [target, setTarget] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  const counts = { debts: idx!.obByParty.get(partyId)?.length ?? 0, payments: idx!.payByParty.get(partyId)?.length ?? 0 };
  const after = target
    ? (() => {
        const a = partyBalance(idx!, partyId, today);
        const b = partyBalance(idx!, target, today);
        const keys = new Set([...a.keys(), ...b.keys()]);
        return [...keys].map((c) => ({ c, r: (a.get(c)?.receivable ?? 0) + (b.get(c)?.receivable ?? 0), p: (a.get(c)?.payable ?? 0) + (b.get(c)?.payable ?? 0) }));
      })()
    : [];
  return (
    <Sheet title={`${t("merge")} ${source.displayName}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("mergeParties", { sourceId: partyId, targetId: target, reason }, cmd);
            toast(t("saved"));
            onClose();
            go(`/people/${target}`);
          });
        }}
      >
        <PartyPicker partyId={target === partyId ? null : target} name={name} onPick={(id) => setTarget(id === partyId ? null : id)} onName={setName} />
        {target && (
          <div className="banner">
            <div>
              <p>
                {t("mergePreview")} <b>{idx!.party.get(target)?.displayName}</b>: <bdi className="num">{counts.debts}</bdi> {t("debts")}, <bdi className="num">{counts.payments}</bdi> {t("payments")}.
              </p>
              {after.map((x) => (
                <p key={x.c}>
                  <Money minor={x.r} currency={x.c} className="owed" /> · <Money minor={x.p} currency={x.c} className="owe" />
                </p>
              ))}
            </div>
          </div>
        )}
        <ReasonField value={reason} onChange={setReason} />
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!target || !reason.trim()} label={t("merge")} />
      </form>
    </Sheet>
  );
}

function SnoozeSheet({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { idx, t, run, toast, today } = useApp();
  const party = idx!.party.get(partyId)!;
  const [until, setUntil] = useState(party.snoozedUntil ?? addDays(today, 7));
  const s = useSubmit();
  return (
    <Sheet title={t("snooze")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("snoozeParty", { partyId, until });
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <Field label={t("snoozedUntil")}>
          <input type="date" className="input" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        {party.snoozedUntil && (
          <button type="button" className="btn" onClick={() => s.submit(async () => { await run("snoozeParty", { partyId, until: null }); onClose(); })}>
            {t("unsnooze")}
          </button>
        )}
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} />
      </form>
    </Sheet>
  );
}

function ApplyAdvanceSheet({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const { idx, t, run, toast } = useApp();
  const p = idx!.payment.get(paymentId)!;
  const { unallocated } = paymentFiguresOf(idx!, p);
  const open = openObligations(idx!, p.partyId, p.direction, p.currency);
  const plan = planAllocation(open, unallocated);
  const cmd = useMemo(() => newCommandId(), []);
  const s = useSubmit();
  return (
    <Sheet title={t("applyAdvance")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void s.submit(async () => {
            await run("applyAdvance", { paymentId, allocations: "auto" }, cmd);
            toast(t("saved"));
            onClose();
          });
        }}
      >
        <p>
          {t("advance")}: <b><Money minor={unallocated} currency={p.currency} /></b>
        </p>
        {plan.lines.length === 0 ? (
          <p className="help">{t("noOpenDebts")}</p>
        ) : (
          <ul className="card grid gap-1 p-3 text-[14px]">
            {plan.lines.map((l) => (
              <li key={l.obligationId} className="flex justify-between">
                <span>{idx!.obligation.get(l.obligationId)?.description || idx!.obligation.get(l.obligationId)?.date}</span>
                <Money minor={l.amount} currency={p.currency} />
              </li>
            ))}
          </ul>
        )}
        <ErrorBox error={s.error} />
        <Footer busy={s.busy} onCancel={onClose} disabled={!plan.lines.length} />
      </form>
    </Sheet>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
        <h2 className="section-title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
