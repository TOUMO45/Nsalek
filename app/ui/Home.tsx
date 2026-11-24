"use client";
import { useMemo } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock, HandCoins, Mic, NotebookPen } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { BackupReminder } from "./Backup";
import { peopleCount } from "@/lib/ui/i18n";
import { useSheet } from "@/lib/ui/sheets";
import { Avatar, DirectionIcon, Empty, Money } from "@/lib/ui/components";
import { workspaceTotals, figuresOf } from "@/lib/core/ledger";
import { dailyActions } from "@/lib/core/collections";
import { formatDate } from "@/lib/core/dates";

export function Home() {
  const { idx, today, t, prefs, ws, lang, flashId } = useApp();
  const open = useSheet();
  const totals = useMemo(() => (idx ? [...workspaceTotals(idx, today)].sort((a, b) => (a[0] === ws?.defaultCurrency ? -1 : b[0] === ws?.defaultCurrency ? 1 : a[0].localeCompare(b[0]))) : []), [idx, today, ws?.defaultCurrency]);
  const actions = useMemo(() => (idx ? dailyActions(idx, today) : []), [idx, today]);
  const recent = useMemo(() => {
    if (!idx) return [];
    const items = [
      ...[...idx.obligation.values()].filter((o) => o.state === "posted").map((o) => ({ kind: "o" as const, id: o.id, at: o.createdAt, date: o.date, partyId: o.partyId, direction: o.direction, amount: o.principal, currency: o.currency })),
      ...[...idx.payment.values()].map((p) => ({ kind: "p" as const, id: p.id, at: p.createdAt, date: p.date, partyId: p.partyId, direction: p.direction, amount: p.amount, currency: p.currency, reversed: p.state === "reversed" })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  }, [idx]);
  if (!idx || !ws) return null;
  const hasData = idx.obligation.size > 0;
  const overdueCount = totals.reduce((n, [, b]) => n + b.overdue, 0);
  const dueTodayCount = totals.reduce((n, [, b]) => n + b.dueToday, 0);
  const owedLabel = t(prefs.dzWording ? "owedToMeDz" : "owedToMe");
  const oweLabel = t(prefs.dzWording ? "iOweDz" : "iOwe");

  return (
    <div className="stack">
      <BackupReminder />

      <section className="ruled card overflow-hidden" aria-label={`${owedLabel} / ${oweLabel}`}>
        <div className="grid grid-cols-2">
          <div className="p-4" style={{ borderInlineEnd: "1px solid var(--line)" }}>
            <p className="flex items-center gap-1.5 text-[15px] font-bold owed">
              <ArrowDownLeft size={18} aria-hidden /> {owedLabel}
            </p>
            <p className="help">{t("owedToMeHelp")}</p>
          </div>
          <div className="p-4">
            <p className="flex items-center gap-1.5 text-[15px] font-bold owe">
              <ArrowUpRight size={18} aria-hidden /> {oweLabel}
            </p>
            <p className="help">{t("iOweHelp")}</p>
          </div>
        </div>
        {(totals.length ? totals : [[ws.defaultCurrency, null] as const]).map(([currency, b]) => (
          <div key={currency} className="grid grid-cols-2" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="px-4 py-3" style={{ borderInlineEnd: "1px solid var(--line)" }}>
              <p className="owed hero-amount">
                <Money minor={b?.receivable ?? 0} currency={currency} />
              </p>
              <p className="help">
                <bdi>{peopleCount(lang, b?.debtors ?? 0)}</bdi>
                {b && b.advanceReceived > 0 && (
                  <>
                    {" · "}
                    {t("advance")} <Money minor={b.advanceReceived} currency={currency} />
                  </>
                )}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className="owe hero-amount">
                <Money minor={b?.payable ?? 0} currency={currency} />
              </p>
              <p className="help">
                <bdi>{peopleCount(lang, b?.creditors ?? 0)}</bdi>
              </p>
            </div>
          </div>
        ))}
      </section>

      <button className="btn w-full" onClick={() => open({ kind: "voice" })}>
        <Mic size={20} aria-hidden /> {t("voiceStart")} · {t("voice")}
      </button>

      <div className="grid grid-cols-3 gap-2">
        <button className="btn btn-owed min-h-[52px] flex-col gap-0.5 px-2 py-2 text-[13px] btn-wrap leading-tight" onClick={() => open({ kind: "debt", direction: "receivable" })}>
          <ArrowDownLeft size={20} aria-hidden />
          {t("addOwedToMe")}
        </button>
        <button className="btn btn-owe min-h-[52px] flex-col gap-0.5 px-2 py-2 text-[13px] btn-wrap leading-tight" onClick={() => open({ kind: "debt", direction: "payable" })}>
          <ArrowUpRight size={20} aria-hidden />
          {t("addIOwe")}
        </button>
        <button className="btn min-h-[52px] flex-col gap-0.5 px-2 py-2 text-[13px] btn-wrap leading-tight" onClick={() => open({ kind: "payment" })}>
          <HandCoins size={20} aria-hidden />
          {t("recordRepayment")}
        </button>
      </div>

      {!hasData ? (
        <Empty
          icon={<NotebookPen size={34} />}
          title={t("emptyHomeTitle")}
          text={t("emptyHomeText")}
          action={
            <button className="btn btn-primary" onClick={() => open({ kind: "debt", direction: "receivable" })}>
              {t("addOwedToMe")}
            </button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <a href="#/due/today" className="card flex items-center gap-3 p-3">
              <CalendarClock className="muted" size={22} aria-hidden />
              <span>
                <span className="block text-[22px] font-bold num">{dueTodayCount}</span>
                <span className="help">{t("dueToday")}</span>
              </span>
            </a>
            <a href="#/due/overdue" className="card flex items-center gap-3 p-3">
              <AlertTriangle className={overdueCount ? "late" : "muted"} size={22} aria-hidden />
              <span>
                <span className={`block text-[22px] font-bold num ${overdueCount ? "late" : ""}`}>{overdueCount}</span>
                <span className="help">{t("overdue")}</span>
              </span>
            </a>
          </div>

          <section className="card">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <h2 className="section-title">{t("todayActions")}</h2>
              <a className="help font-semibold" href="#/due">
                {t("viewAll")}
              </a>
            </div>
            {actions.length === 0 ? (
              <p className="help px-4 pb-4">{t("nothingToday")}</p>
            ) : (
              actions.slice(0, 5).map((a) => (
                <a key={a.kind + a.party.id + a.currency} href={`#/people/${a.party.id}`} className="row">
                  <Avatar name={a.party.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{a.party.displayName}</span>
                    <span className={`help block ${a.kind.includes("broken") || a.kind.includes("missed") || a.kind === "overdue" ? "late" : ""}`}>{t(`ak_${a.kind}` as never)}</span>
                  </span>
                  <span className={`font-bold ${a.kind === "payable_due" ? "owe" : "owed"}`}>
                    <Money minor={a.amount} currency={a.currency} />
                  </span>
                </a>
              ))
            )}
          </section>

          <section className="card">
            <h2 className="section-title px-4 pt-3 pb-1">{t("recent")}</h2>
            {recent.map((r) => {
              const party = idx.party.get(r.partyId);
              const ob = r.kind === "o" ? idx.obligation.get(r.id) : null;
              const outstanding = ob ? figuresOf(idx, ob).outstanding : null;
              return (
                <a key={r.id} href={`#/people/${r.partyId}`} className={`row ${flashId === r.id ? "just-saved" : ""}`}>
                  <DirectionIcon direction={r.direction} size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{party?.displayName}</span>
                    <span className="help block">
                      {r.kind === "o" ? t(r.direction === "receivable" ? "owedToMe" : "iOwe") : t(r.direction === "receivable" ? "repaymentReceived" : "repaymentPaid")} · <bdi className="num">{formatDate(r.date, lang)}</bdi>
                      {"reversed" in r && r.reversed ? ` · ${t("reversed")}` : ""}
                    </span>
                  </span>
                  <span className="text-end">
                    <span className={`block font-bold ${r.kind === "p" ? "" : r.direction === "receivable" ? "owed" : "owe"}`} style={"reversed" in r && r.reversed ? { textDecoration: "line-through" } : undefined}>
                      <Money minor={r.amount} currency={r.currency} />
                    </span>
                    {outstanding !== null && outstanding !== r.amount && (
                      <span className="help block">
                        {t("remaining")} <Money minor={outstanding} currency={r.currency} />
                      </span>
                    )}
                  </span>
                </a>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
