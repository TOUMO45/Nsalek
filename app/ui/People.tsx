"use client";
import { useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BellRing, FileText, HandCoins, MessageCircle, MoreHorizontal, Phone, Plus, Search, UserPlus, Users } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { useSheet } from "@/lib/ui/sheets";
import { Avatar, DirectionIcon, useAsk, Empty, Money, Seg, StatusChip, displayPhone, go, readFileAttachment } from "@/lib/ui/components";
import {
  activeAdjustments,
  advancePayments,
  daysPastDue,
  figuresOf,
  netPosition,
  obligationStatus,
  partyBalance,
  partyEffects,
  paymentFiguresOf,
  searchParties,
  type PartyFilters,
} from "@/lib/core/ledger";
import { lastPayment, promiseState } from "@/lib/core/collections";
import { formatMoney } from "@/lib/core/money";
import { installmentProgress } from "@/lib/core/installments";
import { formatDate } from "@/lib/core/dates";
import { whatsappDigits } from "@/lib/core/text";
import { channelLabel, errorMessage } from "@/lib/ui/i18n";
import type { Obligation } from "@/lib/core/types";

type FilterKey = "all" | "receivable" | "payable" | "overdue" | "settled" | "archived";

export function PeopleList() {
  const { idx, today, t, ws } = useApp();
  const open = useSheet();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [tag, setTag] = useState("");
  const [limit, setLimit] = useState(60);
  const filters: PartyFilters = useMemo(
    () => ({
      direction: filter === "receivable" || filter === "payable" || filter === "settled" ? filter : undefined,
      due: filter === "overdue" ? "overdue" : undefined,
      archived: filter === "archived",
      tag: tag || undefined,
    }),
    [filter, tag],
  );
  const results = useMemo(() => (idx ? searchParties(idx, q, filters, today, ws?.settings.dueSoonDays) : []), [idx, q, filters, today, ws?.settings.dueSoonDays]);
  const rows = useMemo(
    () =>
      idx
        ? results.map((m) => {
            const bal = partyBalance(idx, m.party.id, today);
            return { ...m, bal, last: lastPayment(idx, m.party.id) };
          })
        : [],
    [results, idx, today],
  );
  const allTags = useMemo(() => [...new Set(idx?.parties.flatMap((p) => p.tags) ?? [])].sort(), [idx]);
  if (!idx || !ws) return null;
  const cur = ws.defaultCurrency;
  return (
    <div className="stack">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-[22px] font-bold">{t("people")}</h1>
        <button className="btn btn-sm" onClick={() => open({ kind: "party" })}>
          <UserPlus size={16} /> {t("newPerson")}
        </button>
      </div>
      <div className="relative">
        <Search size={18} className="muted pointer-events-none absolute top-[14px]" style={{ insetInlineStart: 12 }} />
        <input className="input" style={{ paddingInlineStart: 38 }} placeholder={t("searchPeople")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchPeople")} type="search" />
      </div>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {(
          [
            ["all", t("filterAll")],
            ["receivable", t("filterOwed")],
            ["payable", t("filterOwe")],
            ["overdue", t("filterOverdue")],
            ["settled", t("filterSettled")],
            ["archived", t("archived")],
          ] as [FilterKey, string][]
        ).map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={filter === k} style={filter === k ? { background: "var(--brand)", color: "var(--brand-ink)", borderColor: "transparent", minHeight: 32 } : { minHeight: 32 }} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
        {allTags.length > 0 && (
          <select className="input" style={{ minHeight: 32, width: "auto", padding: "0 8px" }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t("tags")}>
            <option value="">{t("tags")}</option>
            {allTags.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
      </div>
      {idx.parties.length === 0 ? (
        <Empty icon={<Users size={32} />} title={t("noPeople")} text={t("displayNameHelp")} action={<button className="btn btn-primary" onClick={() => open({ kind: "party" })}><Plus size={16} />{t("newPerson")}</button>} />
      ) : rows.length === 0 ? (
        <Empty title={t("noResults")} />
      ) : (
        <>
          <div className="card overflow-hidden lg:hidden">
            {rows.slice(0, limit).map(({ party, bal }) => {
              const b = bal.get(cur);
              const others = [...bal].filter(([c]) => c !== cur);
              return (
                <a key={party.id} href={`#/people/${party.id}`} className="row">
                  <Avatar name={party.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{party.displayName}</span>
                    <span className="help num block truncate">{party.phones[0] ? displayPhone(party.phones[0]) : party.tags.join(", ")}</span>
                  </span>
                  <span className="text-end text-[14px]">
                    {!!b?.receivable && (
                      <span className="owed block font-bold">
                        <Money minor={b.receivable} currency={cur} />
                      </span>
                    )}
                    {!!b?.payable && (
                      <span className="owe block font-bold">
                        <Money minor={b.payable} currency={cur} />
                      </span>
                    )}
                    {others.map(([c, ob]) => (
                      <span key={c} className="help block">
                        {ob.receivable ? <Money minor={ob.receivable} currency={c} className="owed" /> : null} {ob.payable ? <Money minor={ob.payable} currency={c} className="owe" /> : null}
                      </span>
                    ))}
                    {!b?.receivable && !b?.payable && !others.length && <span className="chip chip-owed">{t("settled")}</span>}
                    {!!b?.overdue && <span className="chip chip-late mt-0.5">{t("overdue")}</span>}
                  </span>
                </a>
              );
            })}
          </div>
          <div className="card hidden overflow-x-auto lg:block">
            <table className="data">
              <thead>
                <tr>
                  <th>{t("displayName")}</th>
                  <th>{t("phone")}</th>
                  <th className="amount">{t("owedToMe")}</th>
                  <th className="amount">{t("iOwe")}</th>
                  <th>{t("overdue")}</th>
                  <th>{t("lastPayment")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map(({ party, bal, last }) => (
                  <tr key={party.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => go(`/people/${party.id}`)}>
                    <td>
                      <a href={`#/people/${party.id}`} className="font-semibold">
                        {party.displayName}
                      </a>
                      {party.tags.length > 0 && <span className="help block">{party.tags.join(", ")}</span>}
                    </td>
                    <td className="num">{party.phones[0] ? displayPhone(party.phones[0]) : ""}</td>
                    <td className="amount owed font-semibold">
                      {[...bal].filter(([, b]) => b.receivable).map(([c, b]) => (
                        <span key={c} className="block">
                          <Money minor={b.receivable} currency={c} />
                        </span>
                      ))}
                    </td>
                    <td className="amount owe font-semibold">
                      {[...bal].filter(([, b]) => b.payable).map(([c, b]) => (
                        <span key={c} className="block">
                          <Money minor={b.payable} currency={c} />
                        </span>
                      ))}
                    </td>
                    <td>{[...bal].some(([, b]) => b.overdue) && <span className="chip chip-late">{t("overdue")}</span>}</td>
                    <td className="num">{last ? formatDate(last.date) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limit && (
            <button className="btn w-full" onClick={() => setLimit((l) => l + 100)}>
              {t("viewAll")} (<bdi className="num">{rows.length - limit}</bdi>)
            </button>
          )}
        </>
      )}
    </div>
  );
}

type Tab = "timeline" | "debts" | "payments" | "follow";

export function PersonPage({ partyId }: { partyId: string }) {
  const app = useApp();
  const { idx, today, t, lang, ws, prefs } = app;
  const open = useSheet();
  const [tab, setTab] = useState<Tab>("timeline");
  const party = idx?.party.get(partyId);
  const balance = useMemo(() => (idx ? partyBalance(idx, partyId, today) : new Map()), [idx, partyId, today]);
  if (!idx || !ws) return null;
  if (!party) return <Empty title={t("noResults")} action={<a className="btn" href="#/people">{t("back")}</a>} />;
  if (party.mergedIntoId) {
    go(`/people/${party.mergedIntoId}`);
    return null;
  }
  const BackIcon = lang === "ar" ? ArrowRight : ArrowLeft;
  const wa = party.phones[0] ? whatsappDigits(party.phones[0]) : null;
  const currencies = [...balance.keys()];
  const hasReceivable = [...balance.values()].some((b) => b.receivable > 0);
  return (
    <div className="stack">
      <a href="#/people" className="help inline-flex items-center gap-1 font-semibold">
        <BackIcon size={16} /> {t("people")}
      </a>
      <section className="card p-4">
        <div className="flex items-start gap-3">
          <Avatar name={party.displayName} large />
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-bold leading-tight">{party.displayName}</h1>
            <div className="mt-1 flex flex-wrap gap-1">
              {party.kind === "organization" && <span className="chip">{t("kindOrg")}</span>}
              {party.isCustomer && <span className="chip">{t("customer")}</span>}
              {party.isSupplier && <span className="chip">{t("supplier")}</span>}
              {party.tags.map((x) => (
                <span key={x} className="chip">
                  {x}
                </span>
              ))}
              {party.archivedAt && <span className="chip chip-soon">{t("archived")}</span>}
              {party.snoozedUntil && party.snoozedUntil >= today && (
                <span className="chip chip-soon">
                  {t("snoozedUntil")} <bdi className="num">{formatDate(party.snoozedUntil, lang)}</bdi>
                </span>
              )}
            </div>
            {party.phones.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {party.phones.map((p) => (
                  <a key={p} href={`tel:${p}`} className="btn btn-sm">
                    <Phone size={15} /> <bdi className="num">{displayPhone(p)}</bdi>
                  </a>
                ))}
                {wa && (
                  <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="btn btn-sm">
                    <MessageCircle size={15} /> {t("whatsapp")}
                  </a>
                )}
              </div>
            )}
          </div>
          <PartyMenu partyId={party.id} />
        </div>
        <div className="mt-4 grid gap-2">
          {currencies.length === 0 && <p className="chip chip-owed w-fit">{t("settled")}</p>}
          {currencies.map((c) => {
            const b = balance.get(c)!;
            return (
              <div key={c} className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3" style={{ background: "var(--owed-soft)" }}>
                  <p className="owed text-[13px] font-bold">{t(prefs.dzWording ? "owedToMeDz" : "owedToMe")}</p>
                  <p className="owed text-[22px] font-bold">
                    <Money minor={b.receivable} currency={c} />
                  </p>
                  {b.advanceReceived > 0 && (
                    <p className="help flex flex-wrap items-center gap-1.5">
                      <span>
                        {t("advance")}: <Money minor={b.advanceReceived} currency={c} />
                      </span>
                      {b.receivable > 0 && (
                        <button className="btn btn-sm" onClick={() => open({ kind: "applyAdvance", paymentId: advancePayments(idx!, party.id, "receivable", c)[0].payment.id })}>
                          {t("applyAdvance")}
                        </button>
                      )}
                    </p>
                  )}
                </div>
                <div className="rounded-xl p-3" style={{ background: "var(--owe-soft)" }}>
                  <p className="owe text-[13px] font-bold">{t(prefs.dzWording ? "iOweDz" : "iOwe")}</p>
                  <p className="owe text-[22px] font-bold">
                    <Money minor={b.payable} currency={c} />
                  </p>
                  {b.advancePaid > 0 && (
                    <p className="help flex flex-wrap items-center gap-1.5">
                      <span>
                        {t("advance")}: <Money minor={b.advancePaid} currency={c} />
                      </span>
                      {b.payable > 0 && (
                        <button className="btn btn-sm" onClick={() => open({ kind: "applyAdvance", paymentId: advancePayments(idx!, party.id, "payable", c)[0].payment.id })}>
                          {t("applyAdvance")}
                        </button>
                      )}
                    </p>
                  )}
                </div>
                {b.receivable > 0 && b.payable > 0 && (
                  <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed p-2.5" style={{ borderColor: "var(--line)" }}>
                    <span className="help">
                      {t("net")}: <b className="text-[var(--ink)]">
                        <Money minor={netPosition(b)} currency={c} signed />
                      </b>
                      <span className="block">{t("netHelp")}</span>
                    </span>
                    <button className="btn btn-sm" onClick={() => open({ kind: "netting", partyId: party.id, currency: c })}>
                      {t("netting")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button className="btn btn-sm" onClick={() => open({ kind: "debt", direction: "receivable", partyId: party.id })}>
            <ArrowDownLeft size={16} className="owed" /> {t("owedToMe")}
          </button>
          <button className="btn btn-sm" onClick={() => open({ kind: "debt", direction: "payable", partyId: party.id })}>
            <ArrowUpRight size={16} className="owe" /> {t("iOwe")}
          </button>
          <button className="btn btn-sm" onClick={() => open({ kind: "payment", partyId: party.id, direction: hasReceivable || ![...balance.values()].some((b) => b.payable) ? "receivable" : "payable" })}>
            <HandCoins size={16} /> {t("recordRepayment")}
          </button>
          <button className="btn btn-sm" disabled={!hasReceivable} onClick={() => open({ kind: "remind", partyId: party.id })}>
            <BellRing size={16} /> {t("remind")}
          </button>
          <a className="btn btn-sm" href={`#/statement/${party.id}?currency=${currencies[0] ?? ws.defaultCurrency}`}>
            <FileText size={16} /> {t("statement")}
          </a>
          <button className="btn btn-sm" disabled={!hasReceivable} onClick={() => open({ kind: "promise", partyId: party.id })}>
            {t("promise")}
          </button>
        </div>
      </section>

      <Seg<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "timeline", label: t("timeline") },
          { value: "debts", label: t("debts") },
          { value: "payments", label: t("payments") },
          { value: "follow", label: t("followUp") },
        ]}
      />
      {tab === "timeline" && <Timeline partyId={party.id} />}
      {tab === "debts" && <DebtsTab partyId={party.id} />}
      {tab === "payments" && <PaymentsTab partyId={party.id} />}
      {tab === "follow" && <FollowTab partyId={party.id} />}
      {party.notes && (
        <section className="card p-4">
          <p className="label">{t("notes")}</p>
          <p className="whitespace-pre-wrap">{party.notes}</p>
        </section>
      )}
    </div>
  );
}

function PartyMenu({ partyId }: { partyId: string }) {
  const { t, run, idx, toast, lang } = useApp();
  const open = useSheet();
  const ask = useAsk();
  const menu = useRef<HTMLDetailsElement>(null);
  const party = idx?.party.get(partyId);
  if (!party) return null;
  const archive = async () => {
    try {
      if (party.archivedAt) await run("archiveParty", { partyId, archived: false });
      else {
        const hasBalance = [...partyBalance(idx!, partyId, "9999-12-31").values()].some((b) => b.receivable || b.payable);
        if (hasBalance && !(await ask({ title: t("archivePerson"), message: t("archiveHasBalance"), confirmLabel: t("archivePerson") }))) return;
        await run("archiveParty", { partyId, archived: true, confirmOutstanding: true });
      }
      toast(t("saved"));
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <details className="relative" ref={menu}>
      <summary className="icon-btn list-none" aria-label={t("more")}>
        <MoreHorizontal size={20} />
      </summary>
      {/* Choosing any action closes the menu, so it does not stay open behind the form. */}
      <div className="card absolute z-10 mt-1 grid min-w-[220px] p-1" style={{ insetInlineEnd: 0, boxShadow: "var(--shadow)" }} onClick={() => menu.current?.removeAttribute("open")}>
        <button className="btn btn-ghost justify-start" onClick={() => open({ kind: "party", partyId })}>
          {t("editPerson")}
        </button>
        <button className="btn btn-ghost justify-start" onClick={() => open({ kind: "snooze", partyId })}>
          {t("snooze")}
        </button>
        <button className="btn btn-ghost justify-start" onClick={() => open({ kind: "merge", partyId })}>
          {t("merge")}
        </button>
        <button className="btn btn-ghost justify-start" onClick={archive}>
          {party.archivedAt ? t("restorePerson") : t("archivePerson")}
        </button>
      </div>
    </details>
  );
}

type TlFilter = "all" | "debts" | "payments" | "corrections" | "follow";

function Timeline({ partyId }: { partyId: string }) {
  const { idx, t, lang, today, prefs } = useApp();
  const [filter, setFilter] = useState<TlFilter>("all");
  const rows = useMemo(() => {
    // A repayment that left an advance moves the balance by the allocated part only; say the full amount too.
    const fullAmount = (pay: { amount: number; currency: string }, delta: number) =>
      pay.amount !== Math.abs(delta) ? ` · ${t("fullAmount")} ${formatMoney(pay.amount, pay.currency, lang, { hide: prefs.hideAmounts })}` : "";
    if (!idx) return [];
    const balances = new Map<string, number>();
    type Row = { key: string; date: string; at: string; group: TlFilter; label: string; detail?: string; delta?: number; currency?: string; direction?: "receivable" | "payable"; balance?: number; struck?: boolean };
    const out: Row[] = partyEffects(idx, partyId).map((e) => {
      const k = e.currency + e.direction;
      const balance = (balances.get(k) ?? 0) + e.delta;
      balances.set(k, balance);
      const ob = e.obligationId ? idx.obligation.get(e.obligationId) : undefined;
      const pay = e.paymentId ? idx.payment.get(e.paymentId) : undefined;
      const group: TlFilter = e.kind === "obligation" ? "debts" : e.kind === "payment" || e.kind === "advance_applied" ? "payments" : "corrections";
      return {
        key: e.key,
        date: e.date,
        at: e.at,
        group,
        label: t(`ek_${e.kind}` as never),
        detail: ob?.description || ob?.reference || (pay ? t(`m_${pay.method}` as never) + (pay.reference ? ` · ${pay.reference}` : "") + (e.kind === "payment" ? fullAmount(pay, e.delta) : "") : undefined),
        delta: e.delta,
        currency: e.currency,
        direction: e.direction,
        balance,
      };
    });
    for (const o of idx.obByParty.get(partyId) ?? [])
      if (o.state === "voided") out.push({ key: "v" + o.id, date: (o.voidedAt ?? o.createdAt).slice(0, 10), at: o.voidedAt ?? "", group: "corrections", label: `${t("st_voided")}: ${o.description || t("ek_obligation")}`, detail: o.voidReason ?? "", delta: o.principal, currency: o.currency, direction: o.direction, struck: true });
    for (const p of idx.payByParty.get(partyId) ?? [])
      if (p.state === "reversed") out.push({ key: "r" + p.id, date: (p.reversedAt ?? p.createdAt).slice(0, 10), at: p.reversedAt ?? "", group: "corrections", label: `${t("reversed")}: ${t("ek_payment")} ${formatDate(p.date, lang)}`, detail: p.reversalReason ?? "", delta: -p.amount, currency: p.currency, direction: p.direction, struck: true });
    for (const a of idx.adjByParty.get(partyId) ?? [])
      if (a.reversedAt) out.push({ key: "ra" + a.id, date: a.reversedAt.slice(0, 10), at: a.reversedAt, group: "corrections", label: `${t("reversed")}: ${t(`ek_${a.type}` as never)}`, detail: a.reversalReason ?? "", struck: true });
    for (const pr of idx.promisesByParty.get(partyId) ?? []) out.push({ key: "pr" + pr.id, date: pr.madeOn, at: pr.createdAt, group: "follow", label: `${t("promise")} → ${formatDate(pr.promisedDate, lang)}`, detail: t(`p_${promiseState(pr, idx, today).state}` as never), currency: pr.currency });
    for (const r of idx.remindersByParty.get(partyId) ?? []) out.push({ key: "rm" + r.id, date: r.createdAt.slice(0, 10), at: r.createdAt, group: "follow", label: `${t("remind")} · ${channelLabel(lang, r.channel)}`, detail: t(`rs_${r.status}` as never) });
    return out.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  }, [idx, partyId, t, lang, today, prefs.hideAmounts]);
  const shown = rows.filter((r) => filter === "all" || r.group === filter);
  return (
    <section className="card overflow-hidden">
      <div className="flex gap-1.5 overflow-x-auto p-2">
        {(["all", "debts", "payments", "corrections", "follow"] as TlFilter[]).map((f) => (
          <button key={f} className="chip" style={filter === f ? { background: "var(--brand)", color: "var(--brand-ink)", borderColor: "transparent", minHeight: 30 } : { minHeight: 30 }} onClick={() => setFilter(f)}>
            {f === "all" ? t("all") : f === "debts" ? t("debts") : f === "payments" ? t("payments") : f === "corrections" ? t("adjust") : t("followUp")}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="help px-4 pb-4">{t("noResults")}</p>}
      {shown.map((r) => (
        <div key={r.key} className="row items-start">
          {r.direction ? <DirectionIcon direction={r.direction} size={16} /> : <span className="w-4" />}
          <div className="min-w-0 flex-1">
            <p className="font-semibold" style={r.struck ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
              {r.label}
            </p>
            <p className="help">
              <bdi className="num">{formatDate(r.date, lang)}</bdi>
              {r.detail ? ` · ${r.detail}` : ""}
            </p>
          </div>
          {r.delta !== undefined && r.currency && (
            <div className="text-end text-[14px]">
              <p className={`font-bold ${r.delta > 0 ? (r.direction === "receivable" ? "owed" : "owe") : ""}`} style={r.struck ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
                <Money minor={r.delta} currency={r.currency} signed />
              </p>
              {r.balance !== undefined && (
                <p className="help">
                  {t("runningBalance")} <Money minor={r.balance} currency={r.currency} />
                </p>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function DebtsTab({ partyId }: { partyId: string }) {
  const { idx, today, t, lang, run, toast, ws } = useApp();
  const open = useSheet();
  if (!idx || !ws) return null;
  const list = [...(idx.obByParty.get(partyId) ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (!list.length) return <Empty title={t("noResults")} />;
  const attach = async (ob: Obligation, file: File | undefined) => {
    if (!file) return;
    try {
      const a = await readFileAttachment(file);
      await run("addAttachment", { workspaceId: ws.id, ownerType: "obligation", ownerId: ob.id, ...a });
      toast(t("saved"));
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <div className="grid gap-2">
      {list.map((ob) => {
        const f = figuresOf(idx, ob);
        const status = obligationStatus(ob, f);
        const plan = (idx.plansByOb.get(ob.id) ?? []).find((p) => p.state === "active");
        const progress = plan ? installmentProgress(plan, f.settled, today) : [];
        const late = status !== "voided" && f.outstanding > 0 ? daysPastDue(ob, today) : 0;
        const adjustments = activeAdjustments(idx.adjByOb.get(ob.id));
        const attachments = idx.data.attachments.filter((a) => a.ownerId === ob.id);
        return (
          <article key={ob.id} className="card p-3" style={status === "voided" ? { opacity: 0.65 } : undefined}>
            <div className="flex items-start gap-2">
              <DirectionIcon direction={ob.direction} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{ob.description || (ob.direction === "receivable" ? t("owedToMe") : t("iOwe"))}</p>
                <p className="help">
                  <bdi className="num">{formatDate(ob.date, lang)}</bdi>
                  {ob.dueDate && (
                    <>
                      {" · "}
                      {t("dueIn")} <bdi className="num">{formatDate(ob.dueDate, lang)}</bdi>
                    </>
                  )}
                  {ob.reference && ` · ${ob.reference}`}
                </p>
                <div className="mt-1">
                  <StatusChip status={status} overdueDays={late} disputed={!!ob.disputed} />
                </div>
              </div>
              <div className="text-end">
                <p className={`text-[17px] font-bold ${ob.direction === "receivable" ? "owed" : "owe"}`}>
                  <Money minor={f.outstanding} currency={ob.currency} />
                </p>
                {f.outstanding !== ob.principal && (
                  <p className="help">
                    {t("original")} <Money minor={ob.principal} currency={ob.currency} />
                  </p>
                )}
              </div>
            </div>
            {(f.paid > 0 || adjustments.length > 0) && (
              <p className="help mt-2">
                {f.paid > 0 && (
                  <>
                    {t("paid")} <Money minor={f.paid} currency={ob.currency} />
                  </>
                )}
                {adjustments.map((a) => (
                  <span key={a.id}>
                    {" · "}
                    {t(`ek_${a.type}` as never)} <Money minor={a.amount} currency={ob.currency} /> ({a.reason})
                  </span>
                ))}
              </p>
            )}
            {progress.length > 0 && (
              <div className="mt-2 grid gap-1">
                <p className="label">{t("plan")}</p>
                {progress.map((it) => (
                  <div key={it.seq} className="flex items-center justify-between text-[13px]">
                    <span>
                      <bdi className="num">{it.seq}</bdi>. <bdi className="num">{formatDate(it.dueDate, lang)}</bdi>
                    </span>
                    <span className={`chip ${it.state === "paid" ? "chip-owed" : it.state === "missed" ? "chip-late" : it.state === "due" ? "chip-soon" : ""}`}>{t(`i_${it.state}` as never)}</span>
                    <Money minor={it.remaining || it.amount} currency={ob.currency} />
                  </div>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <p className="help mt-2">
                {t("attachment")}:{" "}
                {attachments.map((a) => (
                  <a key={a.id} className="underline" href={`data:${a.mime};base64,${a.data}`} download={a.name}>
                    {a.name}
                  </a>
                ))}
              </p>
            )}
            {status !== "voided" && status !== "draft" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {f.outstanding > 0 && (
                  <button className="btn btn-sm" onClick={() => open({ kind: "payment", partyId, direction: ob.direction, currency: ob.currency })}>
                    {t("recordRepayment")}
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => open({ kind: "adjust", obligationId: ob.id })}>
                  {t("adjust")}
                </button>
                {f.outstanding > 0 && (
                  <button className="btn btn-sm" onClick={() => open({ kind: "installments", obligationId: ob.id })}>
                    {plan ? t("reschedule") : t("installments")}
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => open({ kind: "dates", obligationId: ob.id })}>
                  {t("changeDates")}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await run("setDispute", { obligationId: ob.id, disputed: !ob.disputed });
                    } catch (e) {
                      toast(errorMessage(lang, e));
                    }
                  }}
                >
                  {ob.disputed ? t("clearDispute") : t("markDisputed")}
                </button>
                {f.paid === 0 && !ob.invoiceId && (
                  <button className="btn btn-sm" onClick={() => open({ kind: "replace", obligationId: ob.id })}>
                    {t("replace")}
                  </button>
                )}
                {f.paid === 0 && (
                  <button className="btn btn-sm btn-danger" onClick={() => open({ kind: "void", obligationId: ob.id })}>
                    {t("voidDebt")}
                  </button>
                )}
                <label className="btn btn-sm">
                  {t("attachment")}
                  <input type="file" className="sr-only" accept="image/*,application/pdf" onChange={(e) => attach(ob, e.target.files?.[0])} />
                </label>
              </div>
            )}
            {status === "draft" && (
              <div className="mt-2 flex gap-1.5">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    try {
                      await run("postDraft", { obligationId: ob.id });
                      toast(t("saved"));
                    } catch (e) {
                      toast(errorMessage(lang, e));
                    }
                  }}
                >
                  {t("save")}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => open({ kind: "void", obligationId: ob.id })}>
                  {t("delete")}
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function PaymentsTab({ partyId }: { partyId: string }) {
  const { idx, t, lang } = useApp();
  const open = useSheet();
  if (!idx) return null;
  const list = [...(idx.payByParty.get(partyId) ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (!list.length) return <Empty title={t("noResults")} />;
  return (
    <div className="card overflow-hidden">
      {list.map((p) => {
        const f = paymentFiguresOf(idx, p);
        const reversed = p.state === "reversed";
        return (
          <div key={p.id} className="row items-start" style={reversed ? { opacity: 0.65 } : undefined}>
            <DirectionIcon direction={p.direction} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t(p.direction === "receivable" ? "repaymentReceived" : "repaymentPaid")}</p>
              <p className="help">
                <bdi className="num">{formatDate(p.date, lang)}</bdi> · {t(`m_${p.method}` as never)}
                {p.reference && ` · ${p.reference}`}
                {p.receiptNumber && ` · ${p.receiptNumber}`}
              </p>
              {reversed && (
                <p className="help late">
                  {t("reversed")}: {p.reversalReason}
                </p>
              )}
              {!reversed && f.unallocated > 0 && (
                <p className="help">
                  {t("advance")}: <Money minor={f.unallocated} currency={p.currency} />{" "}
                  <button className="font-semibold underline" onClick={() => open({ kind: "applyAdvance", paymentId: p.id })}>
                    {t("applyAdvance")}
                  </button>
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-1.5">
                <a className="btn btn-sm" href={`#/receipt/${p.id}`}>
                  {t("receipt")}
                </a>
                {!reversed && (
                  <button className="btn btn-sm btn-danger" onClick={() => open({ kind: "reverse", paymentId: p.id })}>
                    {t("reverse")}
                  </button>
                )}
              </div>
            </div>
            <p className="font-bold" style={reversed ? { textDecoration: "line-through" } : undefined}>
              <Money minor={p.amount} currency={p.currency} />
            </p>
          </div>
        );
      })}
    </div>
  );
}

function FollowTab({ partyId }: { partyId: string }) {
  const { idx, t, lang, today, run, toast } = useApp();
  if (!idx) return null;
  const promises = [...(idx.promisesByParty.get(partyId) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reminders = [...(idx.remindersByParty.get(partyId) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mark = async (reminderId: string, status: string) => {
    try {
      await run("updateReminderStatus", { reminderId, status });
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  return (
    <div className="grid gap-3">
      <section className="card overflow-hidden">
        <h2 className="section-title px-4 pt-3">{t("promises")}</h2>
        <p className="help px-4">{t("promiseNote")}</p>
        {promises.length === 0 && <p className="help px-4 pb-3">{t("none")}</p>}
        {promises.map((pr) => {
          const st = promiseState(pr, idx, today);
          return (
            <div key={pr.id} className="row">
              <div className="flex-1">
                <p className="font-semibold">
                  <Money minor={pr.amount} currency={pr.currency} /> → <bdi className="num">{formatDate(pr.promisedDate, lang)}</bdi>
                </p>
                {pr.note && <p className="help">{pr.note}</p>}
              </div>
              <span className={`chip ${st.state === "kept" ? "chip-owed" : st.state === "broken" ? "chip-late" : st.state === "due_today" ? "chip-soon" : ""}`}>{t(`p_${st.state}` as never)}</span>
              {(st.state === "pending" || st.state === "due_today") && (
                <button className="btn btn-sm btn-ghost" onClick={() => run("cancelPromise", { promiseId: pr.id }).catch((e) => toast(errorMessage(lang, e)))}>
                  {t("cancel")}
                </button>
              )}
            </div>
          );
        })}
      </section>
      <section className="card overflow-hidden">
        <h2 className="section-title px-4 pt-3 pb-1">{t("remind")}</h2>
        {reminders.length === 0 && <p className="help px-4 pb-3">{t("none")}</p>}
        {reminders.map((r) => (
          <div key={r.id} className="row items-start">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {channelLabel(lang, r.channel)} · <bdi className="num">{formatDate(r.createdAt.slice(0, 10), lang)}</bdi>
              </p>
              <p className="help line-clamp-2 whitespace-pre-wrap" dir={r.language === "ar" ? "rtl" : "ltr"}>
                {r.message}
              </p>
            </div>
            <div className="grid justify-items-end gap-1">
              <span className="chip">{t(`rs_${r.status}` as never)}</span>
              {r.status === "opened_for_sharing" && (
                <span className="flex gap-1">
                  <button className="btn btn-sm" onClick={() => mark(r.id, "marked_sent")}>
                    {t("markSent")}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => mark(r.id, "failed")}>
                    {t("rs_failed")}
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
