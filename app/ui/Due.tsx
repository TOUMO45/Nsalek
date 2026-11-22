"use client";
import { useMemo, useState } from "react";
import { BellRing, CheckCircle2 } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { useSheet } from "@/lib/ui/sheets";
import { Avatar, Empty, Money, go } from "@/lib/ui/components";
import { agingReport, dailyActions, dueBetween, overdueList, promiseState, reminderQueue } from "@/lib/core/collections";
import { addDays, formatDate } from "@/lib/core/dates";
import { ReminderComposer } from "./Forms";

type Tab = "today" | "overdue" | "week" | "promises" | "queue";

export function Due({ tab: initial }: { tab?: string }) {
  const { t } = useApp();
  const tab = (["today", "overdue", "week", "promises", "queue"].includes(initial ?? "") ? initial : "today") as Tab;
  const tabs: [Tab, string][] = [
    ["today", t("todayActions")],
    ["overdue", t("overdue")],
    ["week", t("thisWeek")],
    ["promises", t("promises")],
    ["queue", t("dueQueue")],
  ];
  return (
    <div className="stack">
      <h1 className="text-[22px] font-bold">{t("due")}</h1>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className="chip" style={tab === k ? { background: "var(--ink)", color: "var(--paper)", minHeight: 34 } : { minHeight: 34 }} onClick={() => go(`/due/${k}`)}>
            {label}
          </button>
        ))}
      </div>
      <NotificationCard />
      {tab === "today" && <TodayTab />}
      {tab === "overdue" && <OverdueTab />}
      {tab === "week" && <WeekTab />}
      {tab === "promises" && <PromisesTab />}
      {tab === "queue" && <QueueTab />}
    </div>
  );
}

function NotificationCard() {
  const { t, prefs, setPrefs } = useApp();
  const [perm, setPerm] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  if (perm === "unsupported") return null;
  if (perm === "granted" && prefs.notifications) return null;
  return (
    <div className="banner">
      <BellRing size={18} className="mt-0.5 muted" aria-hidden />
      <div className="flex-1">
        <p className="font-semibold">{t("notifTitle")}</p>
        <p className="help">{perm === "denied" ? t("notifDenied") : t("notifHelp")}</p>
      </div>
      {perm !== "denied" && (
        <button
          className="btn btn-sm"
          onClick={async () => {
            const r = await Notification.requestPermission();
            setPerm(r);
            setPrefs({ notifications: r === "granted" });
          }}
        >
          {t("enableNotif")}
        </button>
      )}
    </div>
  );
}

function TodayTab() {
  const { idx, today, t } = useApp();
  const actions = useMemo(() => (idx ? dailyActions(idx, today) : []), [idx, today]);
  if (!actions.length) return <Empty icon={<CheckCircle2 size={32} />} title={t("nothingToday")} text={t("rulesNote")} />;
  return (
    <section className="card overflow-hidden">
      <p className="help px-4 pt-3">{t("rulesNote")}</p>
      {actions.map((a) => (
        <a key={a.kind + a.party.id + a.currency} href={`#/people/${a.party.id}`} className="row">
          <Avatar name={a.party.displayName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{a.party.displayName}</span>
            <span className={`help block ${["promise_broken", "installment_missed", "overdue"].includes(a.kind) ? "late" : ""}`}>
              {t(`ak_${a.kind}` as never)} · <bdi className="num">{formatDate(a.date)}</bdi>
            </span>
          </span>
          <b className={a.kind === "payable_due" ? "owe" : "owed"}>
            <Money minor={a.amount} currency={a.currency} />
          </b>
        </a>
      ))}
    </section>
  );
}

function OverdueTab() {
  const { idx, today, t, ws } = useApp();
  const aging = useMemo(() => (idx && ws ? agingReport(idx, today, ws.settings, "receivable") : new Map()), [idx, today, ws]);
  const list = useMemo(() => (idx ? overdueList(idx, today) : []), [idx, today]);
  return (
    <>
      {[...aging].map(([currency, r]) => (
        <section key={currency} className="card p-4">
          <h2 className="section-title mb-2">
            {t("aging")} · {currency}
          </h2>
          <div className="grid gap-1.5">
            {[{ key: "not_due", label: t("notDue"), row: r.notDue }, ...r.buckets.map((b: { key: string; amount: number; count: number }) => ({ key: b.key, label: `${b.key} ${t("days")}`, row: b })), { key: "no_due", label: t("noDue"), row: r.noDueDate }].map(({ key, label, row }) => {
              const pct = r.total ? Math.round((row.amount / r.total) * 100) : 0;
              const late = key !== "not_due" && key !== "no_due";
              return (
                <div key={key} className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-[14px]">
                  <span className={late && row.amount ? "late font-semibold" : "muted"}>
                    <bdi>{label}</bdi>
                  </span>
                  <span className="h-2 overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }} aria-hidden>
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: late ? "var(--late)" : "var(--owed)" }} />
                  </span>
                  <span className="text-end">
                    <Money minor={row.amount} currency={currency} /> <span className="help">(<bdi className="num">{row.count}</bdi>)</span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {!list.length ? (
        <Empty icon={<CheckCircle2 size={32} />} title={t("nothingToday")} />
      ) : (
        <section className="card overflow-hidden">
          {list.map((x) => (
            <a key={x.obligation.id} href={`#/people/${x.party.id}`} className="row">
              <Avatar name={x.party.displayName} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{x.party.displayName}</span>
                <span className="help block">
                  {x.obligation.description || formatDate(x.obligation.date)} · <span className="late">
                    <bdi className="num">{x.daysPastDue}</bdi> {t("overdueDays")}
                  </span>
                  {x.obligation.disputed ? ` · ${t("disputed")}` : ""}
                </span>
              </span>
              <b className="owed">
                <Money minor={x.outstanding} currency={x.obligation.currency} />
              </b>
            </a>
          ))}
        </section>
      )}
    </>
  );
}

function WeekTab() {
  const { idx, today, t } = useApp();
  const rec = useMemo(() => (idx ? dueBetween(idx, today, addDays(today, 6), "receivable") : []), [idx, today]);
  const pay = useMemo(() => (idx ? dueBetween(idx, today, addDays(today, 6), "payable") : []), [idx, today]);
  if (!rec.length && !pay.length) return <Empty icon={<CheckCircle2 size={32} />} title={t("nothingToday")} />;
  return (
    <section className="card overflow-hidden">
      {[...rec, ...pay]
        .sort((a, b) => a.obligation.dueDate!.localeCompare(b.obligation.dueDate!))
        .map((x) => (
          <a key={x.obligation.id} href={`#/people/${x.party.id}`} className="row">
            <Avatar name={x.party.displayName} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{x.party.displayName}</span>
              <span className="help block">
                {t("dueIn")} <bdi className="num">{formatDate(x.obligation.dueDate)}</bdi>
              </span>
            </span>
            <b className={x.obligation.direction === "receivable" ? "owed" : "owe"}>
              <Money minor={x.outstanding} currency={x.obligation.currency} />
            </b>
          </a>
        ))}
    </section>
  );
}

function PromisesTab() {
  const { idx, today, t } = useApp();
  const list = useMemo(
    () =>
      idx
        ? idx.data.promises
            .filter((p) => p.workspaceId === idx.workspaceId && !p.cancelledAt)
            .map((p) => ({ p, st: promiseState(p, idx, today), party: idx.party.get(p.partyId) }))
            .sort((a, b) => a.p.promisedDate.localeCompare(b.p.promisedDate))
        : [],
    [idx, today],
  );
  if (!list.length) return <Empty title={t("none")} text={t("promiseNote")} />;
  return (
    <section className="card overflow-hidden">
      <p className="help px-4 pt-3">{t("promiseNote")}</p>
      {list.map(({ p, st, party }) => (
        <a key={p.id} href={`#/people/${p.partyId}`} className="row">
          <Avatar name={party?.displayName ?? "?"} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{party?.displayName}</span>
            <span className="help block">
              <bdi className="num">{formatDate(p.promisedDate)}</bdi>
              {p.note ? ` · ${p.note}` : ""}
            </span>
          </span>
          <span className="grid justify-items-end gap-1">
            <Money minor={p.amount} currency={p.currency} />
            <span className={`chip ${st.state === "kept" ? "chip-owed" : st.state === "broken" ? "chip-late" : st.state === "due_today" ? "chip-soon" : ""}`}>{t(`p_${st.state}` as never)}</span>
          </span>
        </a>
      ))}
    </section>
  );
}

function QueueTab() {
  const { idx, today, t, ws, lang } = useApp();
  const open = useSheet();
  const queue = useMemo(() => (idx && ws ? reminderQueue(idx, today, ws.settings) : []), [idx, today, ws]);
  const [pos, setPos] = useState(0);
  if (!queue.length) return <Empty icon={<CheckCircle2 size={32} />} title={t("queueEmpty")} text={t("queueHelp")} />;
  const i = Math.min(pos, queue.length - 1);
  const item = queue[i];
  return (
    <div className="stack">
      <p className="help">{t("queueHelp")}</p>
      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between text-[13px]">
          <span className="chip">
            <bdi className="num">
              {i + 1} / {queue.length}
            </bdi>
          </span>
          <span className="help">
            {item.lastReminderAt ? (
              <>
                {t("lastReminder")}: <bdi className="num">{formatDate(item.lastReminderAt.slice(0, 10), lang)}</bdi>
              </>
            ) : null}
            {item.lastPaymentDate ? (
              <>
                {" · "}
                {t("lastPayment")}: <bdi className="num">{formatDate(item.lastPaymentDate, lang)}</bdi>
              </>
            ) : null}
          </span>
        </div>
        {item.maxDaysPastDue > 0 && (
          <p className="late mb-2 text-[14px] font-semibold">
            <bdi className="num">{item.maxDaysPastDue}</bdi> {t("overdueDays")}
          </p>
        )}
        <ReminderComposer key={item.party.id} partyId={item.party.id} compact onDone={() => setPos(i + 1)} />
        <div className="mt-3 flex justify-between gap-2">
          <button className="btn btn-sm" disabled={i === 0} onClick={() => setPos(i - 1)}>
            {t("back")}
          </button>
          <button className="btn btn-sm" onClick={() => open({ kind: "snooze", partyId: item.party.id })}>
            {t("snooze")}
          </button>
          <button className="btn btn-sm" onClick={() => setPos(i + 1)} disabled={i >= queue.length - 1}>
            {t("skip")}
          </button>
        </div>
      </section>
    </div>
  );
}
