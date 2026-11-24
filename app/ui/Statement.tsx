"use client";
import { useMemo, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { translate } from "@/lib/ui/i18n";
import { buildStatement, receiptFigures, type LedgerIndex, type Statement } from "@/lib/core/ledger";
import { formatMoney, type Lang } from "@/lib/core/money";
import { addDays, formatDate, formatDateTime } from "@/lib/core/dates";
import { displayPhone } from "@/lib/core/text";
import { lineTotals } from "@/lib/core/invoice";
import type { Party, Workspace } from "@/lib/core/types";
import { brand } from "@/lib/brand";

const M = (minor: number, currency: string, lang: Lang) => <bdi className="num">{formatMoney(minor, currency, lang)}</bdi>;

export function StatementView({ ws, party, st, idx, lang, generatedAt }: { ws: Workspace; party: Party; st: Statement; idx: LedgerIndex; lang: Lang; generatedAt: string }) {
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  const describe = (row: Statement["sections"][number]["rows"][number]) => {
    const ob = row.obligationId ? idx.obligation.get(row.obligationId) : null;
    const pay = row.paymentId ? idx.payment.get(row.paymentId) : null;
    const base = t(`ek_${row.kind}` as never);
    if (row.kind === "obligation") return [base, ob?.description, ob?.reference].filter(Boolean).join(" · ");
    if (pay) return [base, t(`m_${pay.method}` as never), pay.receiptNumber, pay.reference].filter(Boolean).join(" · ");
    const adj = idx.data.adjustments.find((a) => a.id === row.sourceId);
    return [base, adj?.reason, ob?.description].filter(Boolean).join(" · ");
  };
  const identity = ws.business.name || ws.name;
  return (
    <article className="print-page" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} style={{ fontFamily: "var(--font)" }}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b-2 pb-4" style={{ borderColor: "#111" }}>
        <div>
          <p className="text-[20px] font-bold">{identity}</p>
          {ws.business.address && <p className="text-[12px]">{ws.business.address}</p>}
          {ws.business.phone && <p className="num text-[12px]">{ws.business.phone}</p>}
          {ws.business.taxId && (
            <p className="text-[12px]">
              {t("taxId")}: <bdi className="num">{ws.business.taxId}</bdi>
            </p>
          )}
        </div>
        <div className="text-end">
          <p className="text-[18px] font-bold">{t("statementTitle")}</p>
          <p className="text-[12px]">
            {t("period")}: <bdi className="num">{formatDate(st.from, lang)}</bdi> – <bdi className="num">{formatDate(st.to, lang)}</bdi>
          </p>
          <p className="text-[12px]">
            {t("currency")}: {st.currency}
          </p>
        </div>
      </header>
      <section className="mb-4">
        <p className="text-[12px] text-[#555]">{t("person")}</p>
        <p className="text-[16px] font-bold">{party.displayName}</p>
        {party.phones[0] && <p className="num text-[12px]">{displayPhone(party.phones[0])}</p>}
        {party.address && <p className="text-[12px]">{party.address}</p>}
      </section>
      {st.sections.length === 0 && <p>{t("settled")}</p>}
      {st.sections.map((sec) => (
        <section key={sec.direction} className="mb-6">
          <h2 className="mb-1 text-[14px] font-bold">{sec.direction === "receivable" ? t("stmtOwedTitle") : t("stmtOweTitle")}</h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: 88 }}>{t("date")}</th>
                <th>{t("description")}</th>
                <th className="amount">{t("increase")}</th>
                <th className="amount">{t("decrease")}</th>
                <th className="amount">{t("runningBalance")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{formatDate(st.from, lang)}</td>
                <td>
                  <b>{t("opening")}</b>
                </td>
                <td />
                <td />
                <td className="amount">
                  <b>{M(sec.opening, st.currency, lang)}</b>
                </td>
              </tr>
              {sec.rows.map((r) => (
                <tr key={r.key}>
                  <td className="num">{formatDate(r.date, lang)}</td>
                  <td>{describe(r)}</td>
                  <td className="amount">{r.delta > 0 ? M(r.delta, st.currency, lang) : ""}</td>
                  <td className="amount">{r.delta < 0 ? M(-r.delta, st.currency, lang) : ""}</td>
                  <td className="amount">{M(r.balance, st.currency, lang)}</td>
                </tr>
              ))}
              <tr>
                <td className="num">{formatDate(st.to, lang)}</td>
                <td>
                  <b>{t("closing")}</b>
                </td>
                <td className="amount">{M(sec.increases, st.currency, lang)}</td>
                <td className="amount">{M(sec.decreases, st.currency, lang)}</td>
                <td className="amount">
                  <b>{M(sec.closing, st.currency, lang)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      ))}
      {(st.advances.received > 0 || st.advances.paid > 0) && (
        <p className="mb-4 text-[12px]">
          {t("advancesNote")}: {st.advances.received > 0 && M(st.advances.received, st.currency, lang)} {st.advances.paid > 0 && M(st.advances.paid, st.currency, lang)}
        </p>
      )}
      <footer className="mt-8 border-t pt-2 text-[11px] text-[#555]" style={{ borderColor: "#ccc" }}>
        <p>
          {t("generatedAt")}: <bdi className="num">{formatDateTime(generatedAt, ws.timezone)}</bdi> · {lang === "ar" ? brand.nameAr : brand.name}
        </p>
        <p>{t("statementNote")}</p>
      </footer>
    </article>
  );
}

function PrintBar({ children }: { children?: React.ReactNode }) {
  const { t, lang } = useApp();
  return (
    <div className="no-print sticky top-0 z-10 flex flex-wrap items-end gap-2 border-b p-3" style={{ background: "var(--paper)", borderColor: "var(--line)" }}>
      <button className="btn btn-sm" onClick={() => history.back()}>
        <ArrowLeft size={16} style={lang === "ar" ? { transform: "scaleX(-1)" } : undefined} /> {t("back")}
      </button>
      {children}
      <div className="ms-auto flex flex-col items-end">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
          <Printer size={16} /> {t("printPdf")}
        </button>
        <span className="help text-[12px]">{t("printHelp")}</span>
      </div>
    </div>
  );
}

export function StatementPage({ partyId, query }: { partyId: string; query: URLSearchParams }) {
  const { idx, ws, today, t, lang } = useApp();
  const party = idx?.party.get(partyId);
  const currencies = useMemo(() => (idx ? [...new Set((idx.obByParty.get(partyId) ?? []).map((o) => o.currency))] : []), [idx, partyId]);
  const [currency, setCurrency] = useState(query.get("currency") || currencies[0] || ws?.defaultCurrency || "DZD");
  const firstDate = useMemo(() => (idx?.obByParty.get(partyId) ?? []).map((o) => o.date).sort()[0] ?? addDays(today, -30), [idx, partyId, today]);
  const [from, setFrom] = useState(query.get("from") || firstDate);
  const [to, setTo] = useState(query.get("to") || today);
  const [docLang, setDocLang] = useState<Lang>((query.get("lang") as Lang) || lang);
  const [generatedAt] = useState(() => new Date().toISOString());
  if (!idx || !ws || !party) return null;
  const st = buildStatement(idx, partyId, currency, from, to);
  return (
    <div>
      <PrintBar>
        <label className="grid text-[12px]">
          {t("currency")}
          <select className="input" style={{ minHeight: 36 }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(currencies.length ? currencies : [currency]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="grid text-[12px]">
          {t("from")}
          <input type="date" className="input" style={{ minHeight: 36 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid text-[12px]">
          {t("to")}
          <input type="date" className="input" style={{ minHeight: 36 }} value={to} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="grid text-[12px]">
          {t("language")}
          <select className="input" style={{ minHeight: 36 }} value={docLang} onChange={(e) => setDocLang(e.target.value as Lang)}>
            <option value="ar">العربية</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
      </PrintBar>
      <StatementView ws={ws} party={party} st={st} idx={idx} lang={docLang} generatedAt={generatedAt} />
    </div>
  );
}

export function ReceiptPage({ paymentId }: { paymentId: string }) {
  const { idx, ws, lang } = useApp();
  const p = idx?.payment.get(paymentId);
  if (!idx || !ws || !p) return null;
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  const party = idx.party.get(p.partyId)!;
  // Figures as they stood when the payment was recorded, so a reprint never changes.
  const r = receiptFigures(idx, p);
  return (
    <div>
      <PrintBar />
      <article className="print-page" dir={lang === "ar" ? "rtl" : "ltr"} style={{ maxWidth: 560 }}>
        <header className="mb-4 border-b-2 pb-3" style={{ borderColor: "#111" }}>
          <p className="text-[18px] font-bold">{ws.business.name || ws.name}</p>
          {ws.business.phone && <p className="num text-[12px]">{ws.business.phone}</p>}
          <p className="mt-2 text-[16px] font-bold">
            {t("receipt")} {p.receiptNumber && <bdi className="num">{p.receiptNumber}</bdi>}
          </p>
          {p.state === "reversed" && <p className="text-[16px] font-bold text-[#b42318]">{t("reversed")}</p>}
        </header>
        <table>
          <tbody>
            <tr>
              <td>{t("date")}</td>
              <td className="num">{formatDate(p.date, lang)}</td>
            </tr>
            <tr>
              <td>{p.direction === "receivable" ? t("receivedFrom") : t("paidTo")}</td>
              <td>
                <b>{party.displayName}</b>
              </td>
            </tr>
            <tr>
              <td>{t("amount")}</td>
              <td>
                <b>{M(p.amount, p.currency, lang)}</b>
              </td>
            </tr>
            <tr>
              <td>{t("method")}</td>
              <td>
                {t(`m_${p.method}` as never)} {p.reference && `· ${p.reference}`}
              </td>
            </tr>
            {r.lines.map((l) => {
              const ob = idx.obligation.get(l.obligationId);
              return (
                <tr key={l.obligationId}>
                  <td>{ob?.description || (ob ? formatDate(ob.date, lang) : "")}</td>
                  <td>
                    {M(l.amount, p.currency, lang)} → {t("remaining")} {M(l.remainingAfter, p.currency, lang)}
                  </td>
                </tr>
              );
            })}
            {r.advance > 0 && (
              <tr>
                <td>{t("advance")}</td>
                <td>{M(r.advance, p.currency, lang)}</td>
              </tr>
            )}
            <tr>
              <td>{t("remainingAfter")}</td>
              <td>
                <b>{M(r.remainingAfter, p.currency, lang)}</b>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-4 text-[11px] text-[#555]">{t("methodNote")}</p>
      </article>
    </div>
  );
}

export function InvoicePrintPage({ invoiceId }: { invoiceId: string }) {
  const { idx, ws, lang } = useApp();
  const inv = idx?.data.invoices.find((i) => i.id === invoiceId);
  if (!idx || !ws || !inv) return null;
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  const party = idx.party.get(inv.partyId);
  return (
    <div>
      <PrintBar />
      <article className="print-page" dir={lang === "ar" ? "rtl" : "ltr"}>
        <header className="mb-4 flex justify-between border-b-2 pb-3" style={{ borderColor: "#111" }}>
          <div>
            <p className="text-[18px] font-bold">{ws.business.name || ws.name}</p>
            {ws.business.address && <p className="text-[12px]">{ws.business.address}</p>}
            {ws.business.taxId && <p className="num text-[12px]">{ws.business.taxId}</p>}
          </div>
          <div className="text-end">
            <p className="text-[18px] font-bold">
              {t("invoices")} <bdi className="num">{inv.number || t("st_draft")}</bdi>
            </p>
            <p className="num text-[12px]">{formatDate(inv.date, lang)}</p>
            {inv.dueDate && (
              <p className="text-[12px]">
                {t("dueDate")}: <bdi className="num">{formatDate(inv.dueDate, lang)}</bdi>
              </p>
            )}
            {inv.state === "voided" && <p className="font-bold text-[#b42318]">{t("st_voided")}</p>}
          </div>
        </header>
        <p className="mb-3 font-bold">{party?.displayName}</p>
        <table>
          <thead>
            <tr>
              <th>{t("lineDesc")}</th>
              <th className="amount">{t("qty")}</th>
              <th className="amount">{t("unitPrice")}</th>
              <th className="amount">{t("discount")}</th>
              <th className="amount">{t("total")}</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => {
              const lt = lineTotals(l);
              return (
                <tr key={i}>
                  <td>{l.description}</td>
                  <td className="amount num">{(l.quantityMilli / 1000).toString()}</td>
                  <td className="amount">{M(l.unitPrice, inv.currency, lang)}</td>
                  <td className="amount num">{l.discountBps ? `${l.discountBps / 100}%` : ""}</td>
                  <td className="amount">{M(lt.total, inv.currency, lang)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 ms-auto grid w-64 gap-1 text-[13px]">
          <p className="flex justify-between">
            <span>{t("subtotal")}</span>
            {M(inv.totals.subtotal, inv.currency, lang)}
          </p>
          {inv.totals.discount > 0 && (
            <p className="flex justify-between">
              <span>{t("discount")}</span>-{M(inv.totals.discount, inv.currency, lang)}
            </p>
          )}
          {inv.totals.tax > 0 && (
            <p className="flex justify-between">
              <span>{t("tax")}</span>
              {M(inv.totals.tax, inv.currency, lang)}
            </p>
          )}
          <p className="flex justify-between border-t pt-1 text-[15px] font-bold" style={{ borderColor: "#111" }}>
            <span>{t("total")}</span>
            {M(inv.totals.total, inv.currency, lang)}
          </p>
        </div>
        {inv.notes && <p className="mt-4 text-[12px]">{inv.notes}</p>}
        <p className="mt-8 text-[11px] text-[#555]">{t("taxNote")}</p>
      </article>
    </div>
  );
}
