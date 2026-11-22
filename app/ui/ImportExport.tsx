"use client";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useApp, newCommandId } from "@/lib/ui/state";
import { Field, Money, downloadText } from "@/lib/ui/components";
import { errorMessage } from "@/lib/ui/i18n";
import { exportFileName, exportObligations, exportParties, exportPayments, type Delimiter } from "@/lib/core/csv";
import {
  IMPORT_FIELDS,
  REQUIRED_FIELDS,
  commitPayload,
  csvTemplate,
  decodeCsvBytes,
  dryRunImport,
  parseCsv,
  suggestMapping,
  type ColumnRef,
  type DateFormat,
  type DryRunResult,
  type ImportField,
  type ImportMapping,
} from "@/lib/core/csvImport";
import { agrovetCommitPayload, planAgrovetImport, type AgrovetImportPlan } from "@/lib/migration/agrovet";
import { formatDateTime } from "@/lib/core/dates";

const FIELD_LABEL: Record<ImportField, ["type" | "displayName" | "phone" | "amount" | "currency" | "date" | "dueDate" | "description" | "reference" | "status", string]> = {
  type: ["type", "debt / payment"],
  partyName: ["displayName", ""],
  phone: ["phone", ""],
  direction: ["status", "receivable / payable · ليك / عليك"],
  amount: ["amount", ""],
  currency: ["currency", ""],
  date: ["date", ""],
  dueDate: ["dueDate", ""],
  description: ["description", ""],
  reference: ["reference", ""],
};

export function CsvPage() {
  const { t, data, ws, today, lang, run, toast } = useApp();
  const [delimiter, setDelimiter] = useState<Delimiter>(lang === "en" ? "," : ";");
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [encoding, setEncoding] = useState("");
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commitId = useMemo(() => newCommandId(), [result?.fileHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const headers = useMemo(() => (text ? (parseCsv(text).rows[0] ?? []) : []), [text]);
  const batches = data.importBatches.filter((b) => b.workspaceId === ws?.id && b.source === "csv").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const doExport = (kind: "parties" | "obligations" | "payments") => {
    const fn = kind === "parties" ? exportParties : kind === "obligations" ? exportObligations : exportPayments;
    downloadText(exportFileName(kind, today), fn(data, ws!.id, { delimiter, lang, today }), "text/csv;charset=utf-8");
  };
  const pick = async (file: File | undefined) => {
    setResult(null);
    setError(null);
    if (!file) return;
    const decoded = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
    setText(decoded.text);
    setEncoding(decoded.encoding);
    setFileName(file.name);
    const hs = parseCsv(decoded.text).rows[0] ?? [];
    const guess = suggestMapping(hs);
    setMapping({
      ...Object.fromEntries(IMPORT_FIELDS.map((f) => [f, guess[f] ?? null])),
      dateFormat: "YYYY-MM-DD",
      amountUnit: "major",
      defaultCurrency: ws!.defaultCurrency,
      matchByName: false,
      allowAdvance: false,
      hasHeader: true,
    } as ImportMapping);
  };
  const setRef = (field: ImportField, v: string) => {
    const ref: ColumnRef = v === "" ? null : v.startsWith("=") ? { value: v.slice(1) } : Number(v);
    setMapping((m) => (m ? { ...m, [field]: ref } : m));
    setResult(null);
  };
  const preview = async () => {
    if (!text || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await dryRunImport({ text, mapping, data, workspaceId: ws!.id, today, fileName }));
    } catch (e) {
      setError(errorMessage(lang, e) + ((e as { details?: { field?: string } }).details?.field ? ` (${(e as { details: { field: string } }).details.field})` : ""));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await run("commitImport", commitPayload(result) as unknown as Record<string, unknown>, commitId);
      toast(t("saved"));
      setResult(null);
      setText(null);
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const reverse = async (batchId: string) => {
    const reason = window.prompt(t("reason"));
    if (!reason) return;
    try {
      await run("reverseImport", { batchId, reason });
      toast(t("saved"));
    } catch (e) {
      toast(errorMessage(lang, e));
    }
  };
  const fixedOptions: Partial<Record<ImportField, [string, string][]>> = {
    type: [["=debt", `= ${t("debts")}`], ["=payment", `= ${t("payments")}`]],
    direction: [["=receivable", `= ${t("owedToMe")}`], ["=payable", `= ${t("iOwe")}`]],
    currency: [[`=${ws!.defaultCurrency}`, `= ${ws!.defaultCurrency}`]],
  };
  const refValue = (r: ColumnRef | undefined) => (r === null || r === undefined ? "" : typeof r === "number" ? String(r) : "=" + r.value);
  return (
    <>
      <h1 className="text-[22px] font-bold">
        {t("exportCsv")} / {t("importCsv")}
      </h1>
      <section className="card stack p-4">
        <h2 className="section-title">{t("exportCsv")}</h2>
        <Field label="Delimiter">
          <select className="input" value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delimiter)}>
            <option value=";">; (Excel FR)</option>
            <option value=",">, (Excel EN)</option>
            <option value={"\t"}>Tab</option>
          </select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={() => doExport("parties")}>
            <Download size={15} /> {t("people")}
          </button>
          <button className="btn btn-sm" onClick={() => doExport("obligations")}>
            <Download size={15} /> {t("debts")}
          </button>
          <button className="btn btn-sm" onClick={() => doExport("payments")}>
            <Download size={15} /> {t("payments")}
          </button>
        </div>
        <p className="help">CSV (UTF-8). XLSX: {t("notAvailable")}</p>
      </section>

      <section className="card stack p-4">
        <h2 className="section-title">{t("importCsv")}</h2>
        <button className="btn btn-sm w-fit" onClick={() => downloadText(`nsalek-template-${lang}.csv`, csvTemplate(lang), "text/csv;charset=utf-8")}>
          <Download size={15} /> {t("template")}
        </button>
        <input type="file" accept=".csv,text/csv,text/plain" className="input" onChange={(e) => pick(e.target.files?.[0])} />
        {text && mapping && (
          <>
            <p className="help">
              {fileName} · {encoding} · <bdi className="num">{headers.length}</bdi> col.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {IMPORT_FIELDS.map((f) => (
                <Field key={f} label={`${t(FIELD_LABEL[f][0])}${REQUIRED_FIELDS.includes(f) ? " *" : ""}`} help={FIELD_LABEL[f][1] || undefined}>
                  <select className="input" value={refValue(mapping[f])} onChange={(e) => setRef(f, e.target.value)}>
                    <option value="">—</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {i + 1}. {h}
                      </option>
                    ))}
                    {(fixedOptions[f] ?? []).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={t("date")}>
                <select className="input" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as DateFormat })}>
                  <option>YYYY-MM-DD</option>
                  <option>DD/MM/YYYY</option>
                  <option>MM/DD/YYYY</option>
                </select>
              </Field>
              <Field label={t("amount")}>
                <select className="input" value={mapping.amountUnit} onChange={(e) => setMapping({ ...mapping, amountUnit: e.target.value as "major" | "centime" })}>
                  <option value="major">{t("unitDa")}</option>
                  <option value="centime">{t("unitCentimes")}</option>
                </select>
              </Field>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={mapping.matchByName} onChange={(e) => setMapping({ ...mapping, matchByName: e.target.checked })} /> {t("matchByName")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={mapping.allowAdvance} onChange={(e) => setMapping({ ...mapping, allowAdvance: e.target.checked })} /> {t("recordAdvance")}
            </label>
            <button className="btn" disabled={busy} onClick={preview}>
              {t("dryRun")}
            </button>
          </>
        )}
        {error && <p className="banner banner-late">{error}</p>}
        {result && (
          <div className="stack">
            <p className="font-semibold">
              <span className="owed">
                <bdi className="num">{result.counts.ok}</bdi> {t("rowsOk")}
              </span>
              {" · "}
              <span className="late">
                <bdi className="num">{result.counts.error}</bdi> {t("rowsError")}
              </span>
              {" · "}
              <bdi className="num">{result.counts.duplicate}</bdi> {t("rowsDup")}
            </p>
            {result.alreadyImported && <p className="banner banner-warn">{errorMessage(lang, { code: "already_imported" })}</p>}
            {result.totals.map((x) => (
              <p key={x.currency + x.direction} className="help">
                {x.direction === "receivable" ? t("owedToMe") : t("iOwe")} · {t("debts")} <Money minor={x.debts} currency={x.currency} /> · {t("payments")} <Money minor={x.payments} currency={x.currency} />
              </p>
            ))}
            {result.newParties.length > 0 && (
              <p className="help">
                {t("newPerson")}: <bdi className="num">{result.newParties.length}</bdi>
              </p>
            )}
            <div className="card max-h-80 overflow-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("status")}</th>
                    <th>{t("person")}</th>
                    <th className="amount">{t("amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 200).map((r) => (
                    <tr key={r.line}>
                      <td className="num">{r.line}</td>
                      <td>
                        <span className={`chip ${r.status === "ok" ? "chip-owed" : r.status === "error" ? "chip-late" : "chip-soon"}`}>{r.status}</span>
                        {r.errors.length > 0 && <span className="help block">{r.errors.join(", ")}</span>}
                      </td>
                      <td>
                        {r.preview.partyName} {r.preview.party && <span className="help">({r.preview.party})</span>}
                      </td>
                      <td className="amount">{r.preview.amount !== null && r.preview.currency ? <Money minor={r.preview.amount} currency={r.preview.currency} /> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              {(result.counts.error > 0 || result.counts.duplicate > 0) && (
                <button className="btn btn-sm" onClick={() => downloadText(`nsalek-import-errors-${today}.csv`, result.errorsCsv, "text/csv;charset=utf-8")}>
                  {t("downloadErrors")}
                </button>
              )}
              <button className="btn btn-primary" disabled={busy || result.alreadyImported || result.counts.ok === 0} onClick={commit}>
                {t("commit")} (<bdi className="num">{result.counts.ok}</bdi>)
              </button>
            </div>
          </div>
        )}
      </section>

      {batches.length > 0 && (
        <section className="card overflow-hidden">
          {batches.map((b) => (
            <div key={b.id} className="row">
              <span className="flex-1">
                <span className="block font-semibold">{b.fileName}</span>
                <span className="help">
                  <bdi className="num">{formatDateTime(b.createdAt, ws?.timezone)}</bdi> · {Object.entries(b.counts).map(([k, v]) => `${k}: ${v}`).join(", ")}
                </span>
              </span>
              {b.state === "committed" ? (
                <button className="btn btn-sm btn-danger" onClick={() => reverse(b.id)}>
                  {t("undoImport")}
                </button>
              ) : (
                <span className="chip">{t("reversed")}</span>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export function LegacyImportPage() {
  const { t, ws, lang, run, toast, data } = useApp();
  const [raw, setRaw] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [includeVet, setIncludeVet] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [plan, setPlan] = useState<AgrovetImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commitId = useMemo(() => newCommandId(), [plan?.fileHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const batches = data.importBatches.filter((b) => b.workspaceId === ws?.id && b.source === "agrovet");
  const dry = async () => {
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await planAgrovetImport(raw, { workspaceId: ws!.id, includeVeterinaryDetails: includeVet, includeClientNotes: includeNotes, timezone: ws!.timezone }));
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await run("commitImport", agrovetCommitPayload(plan, fileName) as unknown as Record<string, unknown>, commitId);
      toast(t("saved"));
      setPlan(null);
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const r = plan?.report;
  const byCode = r ? Object.entries(r.review.reduce<Record<string, number>>((acc, x) => ((acc[`${x.severity}:${x.code}`] = (acc[`${x.severity}:${x.code}`] ?? 0) + 1), acc), {})) : [];
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("legacyImport")}</h1>
      <p className="banner">{t("legacyHelp")}</p>
      <section className="card stack p-4">
        <input
          type="file"
          accept="application/json,.json"
          className="input"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setPlan(null);
            if (f) {
              setRaw(await f.text());
              setFileName(f.name);
            }
          }}
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={includeVet} onChange={(e) => setIncludeVet(e.target.checked)} /> {t("includeVet")}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> {t("includeNotes")}
        </label>
        <button className="btn" disabled={!raw || busy} onClick={dry}>
          {t("dryRun")}
        </button>
        {error && <p className="banner banner-late">{error}</p>}
      </section>
      {r && (
        <section className="card stack p-4">
          <h2 className="section-title">{t("reconciliation")}</h2>
          <table className="data">
            <tbody>
              {(["debt", "paid", "balance"] as const).map((k) => {
                const x = r.totals[k] as { cached: number; difference: number; matches: boolean };
                return (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="amount">
                      <Money minor={x.cached} currency={r.currency} />
                    </td>
                    <td className="amount">
                      Δ <Money minor={x.difference} currency={r.currency} />
                    </td>
                    <td>{x.matches ? <span className="chip chip-owed">✓</span> : <span className="chip chip-late">≠</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="help">
            {Object.entries(r.counts)
              .filter(([k]) => k !== "openingBalances")
              .map(([k, v]) => `${k}: ${(v as { imported: number; source: number }).imported}/${(v as { source: number }).source}`)
              .join(" · ")}
            {" · "}opening balances: {r.counts.openingBalances}
          </p>
          {byCode.length > 0 && (
            <div>
              <p className="label">{t("reviewItems")}</p>
              <ul className="help">
                {byCode.map(([code, n]) => (
                  <li key={code}>
                    {code}: <bdi className="num">{n}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button className="btn btn-sm w-fit" onClick={() => downloadText(`agrovet-import-report.json`, JSON.stringify(r, null, 2), "application/json")}>
            {t("download")}
          </button>
          <button className="btn btn-primary" disabled={!r.ready || busy} onClick={commit}>
            {t("commit")}
          </button>
        </section>
      )}
      {batches.map((b) => (
        <p key={b.id} className="help">
          {b.fileName} · <bdi className="num">{formatDateTime(b.createdAt, ws?.timezone)}</bdi> · {b.state}
        </p>
      ))}
    </>
  );
}
