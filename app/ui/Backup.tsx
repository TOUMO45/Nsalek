"use client";
import { useEffect, useState } from "react";
import { Download, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { Money, Seg, downloadText, go, useAsk } from "@/lib/ui/components";
import { errorMessage, snapshotLabel, storeLabel } from "@/lib/ui/i18n";
import { computeTotals, createBackup, parseBackup, serializeBackup, type BackupFile } from "@/lib/core/backup";
import { checkPassphrase, coversEverything, makeBackupKey, notebooksLost } from "@/lib/core/quickBackup";
import { loadLedger, prepareRestore, restoreBackup, type RestorePlan } from "@/lib/core/restore";
import { formatDate, formatDateTime } from "@/lib/core/dates";
import { brand } from "@/lib/brand";
import { useBackupStatus, useQuickBackup } from "./useQuickBackup";

const MIN_PASSPHRASE = 8;
const CONFIRM_EVERY = 60 * 86_400_000;

export function Backup() {
  const { t } = useApp();
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("backup")}</h1>
      <QuickCard />
      <RestoreCard />
      <ExportCard />
      <StorageCard />
      <Snapshots />
    </>
  );
}

// ---------------------------------------------------------------- one-tap backup

function QuickCard() {
  const { t, meta, ws } = useApp();
  const status = useBackupStatus();
  const unsaved = status.level === "due" || status.level === "urgent";
  return (
    <section className="card stack p-4">
      <h2 className="section-title">{t("quickBackup")}</h2>
      {status.level !== "none" && (
        <p className={`banner ${status.level === "urgent" ? "banner-late" : unsaved ? "banner-warn" : ""}`}>
          {unsaved ? <ShieldAlert size={18} className="mt-0.5" aria-hidden /> : <ShieldCheck size={18} className="mt-0.5" aria-hidden />}
          <span className="flex-1">
            {status.changes > 0 ? (
              <>
                {t("backupUnsaved")}: <bdi className="num font-bold">{status.changes}</bdi>. {unsaved && t("backupLoseAll")}
              </>
            ) : (
              t("backupUpToDate")
            )}
            <span className="block">
              {t("lastBackup")}: <b>{meta?.lastBackupAt ? formatDateTime(meta.lastBackupAt, ws?.timezone) : t("never")}</b>
              {meta?.lastBackupVia && <> ({t(meta.lastBackupVia === "shared" ? "viaShared" : "viaDownloaded")})</>}
            </span>
          </span>
        </p>
      )}
      {meta?.lastBackupError && <p className="error-text">{t("backupFailed")}</p>}
      {meta?.backupKey ? <QuickActions /> : <PassphraseForm />}
    </section>
  );
}

/** The backup buttons and what happened; also used on the home screen. */
export function QuickButtons({ compact }: { compact?: boolean }) {
  const { t } = useApp();
  const q = useQuickBackup();
  return (
    <div className="stack">
      {q.pending ? (
        <button className="btn btn-primary" disabled={q.busy} onClick={q.sendPending}>
          <Send size={18} aria-hidden /> {t("backupSendNow")}
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className={`btn ${compact ? "btn-sm" : ""} btn-primary flex-1`} disabled={q.busy} onClick={() => q.start(q.canShare ? "share" : "download")}>
            {q.canShare ? <Send size={18} aria-hidden /> : <Download size={18} aria-hidden />} {q.busy ? t("saving") : t(q.canShare ? "backupSend" : "backupNow")}
          </button>
          {q.canShare && (
            <button className={`btn ${compact ? "btn-sm" : ""}`} disabled={q.busy} onClick={() => q.start("download")}>
              <Download size={18} aria-hidden /> {t("backupSaveHere")}
            </button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="help">
        {q.outcome && t(({ shared: "backupShared", downloaded: "backupDownloaded", cancelled: "backupCancelled", tap_again: "backupTapAgain" } as const)[q.outcome])}
      </p>
      {q.error && <p className="banner banner-late">{q.error}</p>}
    </div>
  );
}

function QuickActions() {
  const { t, meta, saveMeta, nowMs } = useApp();
  const [word, setWord] = useState("");
  const [answer, setAnswer] = useState<"ok" | "bad" | null>(null);
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const key = meta!.backupKey!;
  const stale = nowMs - Date.parse(key.confirmedAt) > CONFIRM_EVERY;
  const check = async () => {
    setChecking(true);
    const ok = await checkPassphrase(key, word);
    setAnswer(ok ? "ok" : "bad");
    if (ok) {
      setWord("");
      await saveMeta({ backupKey: { ...key, confirmedAt: new Date().toISOString() } });
    }
    setChecking(false);
  };
  return (
    <>
      <QuickButtons />
      <details open={stale || undefined}>
        <summary className="help cursor-pointer font-semibold">{t("passphraseCheck")}</summary>
        <div className="stack mt-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <input className="input flex-1" type="password" autoComplete="off" aria-label={t("passphrase")} placeholder={t("passphrase")} value={word} onChange={(e) => (setWord(e.target.value), setAnswer(null))} />
            <button className="btn" disabled={checking || !word}>
              {t("passphraseCheckBtn")}
            </button>
          </form>
          {answer && <p className={answer === "ok" ? "owed font-semibold" : "banner banner-warn"}>{t(answer === "ok" ? "passphraseOk" : "passphraseBad")}</p>}
          {changing ? (
            <PassphraseForm onDone={() => setChanging(false)} />
          ) : (
            <button className="btn btn-sm w-fit" onClick={() => setChanging(true)}>
              {t("passphraseChange")}
            </button>
          )}
        </div>
      </details>
    </>
  );
}

function PassphraseForm({ onDone }: { onDone?: () => void }) {
  const { t, lang, saveMeta } = useApp();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [written, setWritten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveMeta({ backupKey: await makeBackupKey(a) });
      onDone?.();
    } catch (e) {
      setError(errorMessage(lang, e));
      setBusy(false);
    }
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="help">{t(onDone ? "passphraseChangeNote" : "quickBackupHelp")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" type="password" autoComplete="new-password" aria-label={t("passphrase")} placeholder={t("passphraseNew")} value={a} onChange={(e) => setA(e.target.value)} />
        <input className="input" type="password" autoComplete="new-password" aria-label={`${t("passphrase")} (${t("confirm")})`} placeholder={`${t("passphrase")} (${t("confirm")})`} value={b} onChange={(e) => setB(e.target.value)} aria-invalid={!!b && a !== b} />
      </div>
      <p className="banner banner-warn">{t("passphraseWarn")}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={written} onChange={(e) => setWritten(e.target.checked)} /> {t("passphraseWritten")}
      </label>
      <button className="btn btn-primary" disabled={busy || a.length < MIN_PASSPHRASE || a !== b || !written}>
        {busy ? t("saving") : t("quickEnable")}
      </button>
      {error && <p className="banner banner-late">{error}</p>}
    </form>
  );
}

/** Home-screen reminder; hidden while nothing is at risk. */
export function BackupReminder() {
  const { t, meta, lang } = useApp();
  const status = useBackupStatus();
  // Kept on screen after a tap, so the confirmation is still readable once nothing is due.
  const [shown, setShown] = useState(false);
  const unsaved = status.level === "due" || status.level === "urgent";
  if (unsaved && !shown) setShown(true);
  if (!unsaved && !shown) return null;
  return (
    <div className={`banner ${status.level === "urgent" ? "banner-late" : unsaved ? "banner-warn" : ""} flex-col`}>
      <p className="flex gap-2">
        {unsaved ? <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden /> : <ShieldCheck size={18} className="mt-0.5 shrink-0" aria-hidden />}
        <span>
          {unsaved ? (
            <>
              {t("backupUnsaved")}: <bdi className="num font-bold">{status.changes}</bdi>. {t("backupLoseAll")} {t("lastBackup")}: <b>{meta?.lastBackupAt ? formatDate(meta.lastBackupAt.slice(0, 10), lang) : t("never")}</b>
            </>
          ) : (
            t("backupUpToDate")
          )}
        </span>
      </p>
      {meta?.backupKey ? (
        <div className="w-full">
          <QuickButtons compact />
        </div>
      ) : (
        <a href="#/more/backup" className="font-bold underline">
          {t("backupNow")}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- storage

function StorageCard() {
  const { t, saveMeta } = useApp();
  const [persist, setPersist] = useState<"granted" | "no" | "unsupported" | null>(null);
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number } | null>(null);
  useEffect(() => {
    if (!navigator.storage?.persisted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPersist("unsupported");
      return;
    }
    navigator.storage.persisted().then((p) => setPersist(p ? "granted" : "no"));
    navigator.storage.estimate?.().then((e) => setEstimate(e));
  }, []);
  const mb = (n?: number) => (n === undefined ? "?" : (n / 1024 / 1024).toFixed(1));
  return (
    <section className="card stack p-4">
      <h2 className="section-title">{t("storageStatus")}</h2>
      <p className={persist === "granted" ? "owed font-semibold" : "help"}>{persist === "granted" ? t("persistGranted") : t("persistNo")}</p>
      {persist !== "granted" && <p className="help">{t("installHint")}</p>}
      {estimate && (
        <p className="help num">
          {mb(estimate.usage)} / {mb(estimate.quota)} MB
        </p>
      )}
      {persist === "no" && (
        <button
          className="btn btn-sm w-fit"
          onClick={async () => {
            const granted = await navigator.storage.persist();
            setPersist(granted ? "granted" : "no");
            await saveMeta({ persistentStorage: granted ? "granted" : "denied" });
          }}
        >
          {t("requestPersist")}
        </button>
      )}
      <p className="help">{t("syncNotBackup")}</p>
    </section>
  );
}

// ---------------------------------------------------------------- other exports

function ExportCard() {
  const { t, lang, data, ws, saveMeta, store, toast, today } = useApp();
  const [scope, setScope] = useState<"workspace" | "all">("all");
  const [encrypt, setEncrypt] = useState(true);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const all = store ? await loadLedger(store) : data;
      const backup = await createBackup(all, { workspaceIds: scope === "workspace" && ws ? [ws.id] : undefined, passphrase: encrypt ? pass : undefined, appVersion: brand.version, now });
      downloadText(`nsalek-backup-${today}${encrypt ? "-encrypted" : ""}.json`, serializeBackup(backup), "application/json");
      if (coversEverything(backup, all)) await saveMeta({ lastBackupAt: backup.createdAt, lastBackupVia: "downloaded", lastBackupError: null });
      toast(t("saved"));
    } catch (e) {
      await saveMeta({ lastBackupError: String((e as Error).message) });
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card p-4">
      <summary className="section-title cursor-pointer">{t("otherBackup")}</summary>
      <div className="stack mt-3">
        <Seg value={scope} onChange={setScope} options={[{ value: "all", label: t("allWorkspaces") }, { value: "workspace", label: t("thisWorkspace") }]} label={t("scope")} />
        {scope === "workspace" && <p className="help">{t("partialBackup")}</p>}
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} /> {t("encrypt")}
        </label>
        {encrypt && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <input className="input" type="password" autoComplete="new-password" placeholder={t("passphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
              <input className="input" type="password" autoComplete="new-password" placeholder={`${t("passphrase")} (${t("confirm")})`} value={pass2} onChange={(e) => setPass2(e.target.value)} aria-invalid={!!pass2 && pass !== pass2} />
            </div>
            <p className="banner banner-warn">{t("passphraseWarn")}</p>
          </>
        )}
        <button className="btn" disabled={busy || (encrypt && (pass.length < MIN_PASSPHRASE || pass !== pass2))} onClick={doExport}>
          {busy ? t("saving") : t("exportBackup")}
        </button>
        {error && <p className="banner banner-late">{error}</p>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- restore

/** Also shown on first launch (a new phone), where there is nothing to replace. */
export function RestoreCard({ firstLaunch }: { firstLaunch?: boolean }) {
  const { t, lang, data, ws, meta, saveMeta, store, reload, toast } = useApp();
  const ask = useAsk();
  const [file, setFile] = useState<BackupFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [rpass, setRpass] = useState("");
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setPlan(null);
    setError(null);
    if (!f) return;
    try {
      setFile(parseBackup(await f.text()));
      setFileName(f.name);
    } catch (e) {
      setFile(null);
      setError(errorMessage(lang, e));
    }
  };
  const verify = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await prepareRestore(file, rpass || undefined);
      setPlan(p);
      if (p.issues.length || !p.manifestOk) setError(errorMessage(lang, { code: p.issues.length ? "validation_failed" : "manifest_mismatch" }));
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const doRestore = async () => {
    if (!file || !store) return;
    if (mode === "replace") {
      const lost = notebooksLost(file, data);
      const message = [t("restoreReplaceWarn"), lost.length ? `${t("restoreLoses")} ${lost.join(", ")}` : ""].filter(Boolean).join(" ");
      if (!(await ask({ title: t("restoreReplace"), message, confirmLabel: t("restoreReplace"), danger: true }))) return;
    }
    setBusy(true);
    setError(null);
    try {
      const wasEmpty = !data.workspaces.some((w) => !w.demo);
      const result = await restoreBackup(store, file, { mode, passphrase: rpass || undefined });
      const ids = file.scope.workspaceIds;
      const open = ids.find((id) => !plan?.data.workspaces.find((w) => w.id === id)?.archivedAt) ?? ids[0] ?? null;
      // A new phone keeps protecting the data with the passphrase that just opened the backup.
      const backupKey = rpass && file.encryption && !meta?.backupKey ? await makeBackupKey(rpass) : undefined;
      await reload();
      await saveMeta({
        ...(mode === "replace" || !ws ? { activeWorkspaceId: ws && ids.includes(ws.id) ? ws.id : open } : {}),
        ...(mode === "replace" || wasEmpty ? { lastBackupAt: file.createdAt, lastBackupVia: null, lastBackupError: null } : {}),
        ...(backupKey ? { backupKey } : {}),
      });
      setPlan(null);
      setFile(null);
      setRpass("");
      toast(result.conflicts.length ? `${t("restoreDone")} ${t("mergeConflicts")}: ${result.conflicts.length}` : t("restoreDone"));
      if (firstLaunch) go("/");
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack p-4">
      <h2 className="section-title">{t("restore")}</h2>
      <input type="file" accept=".txt,.json,text/plain,application/json" aria-label={t("restore")} className="input" onChange={(e) => pick(e.target.files?.[0])} />
      {file && (
        <>
          <p className="help">
            {fileName} · <bdi className="num">{formatDateTime(file.createdAt, ws?.timezone)}</bdi> · {file.encryption ? "AES-GCM" : "—"}
          </p>
          <ul className="help grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            {Object.entries(file.manifest.counts)
              .filter(([, n]) => n)
              .map(([k, n]) => (
                <li key={k}>
                  {storeLabel(lang, k)}: <bdi className="num">{n}</bdi>
                </li>
              ))}
          </ul>
          {file.encryption && <input className="input" type="password" autoComplete="off" aria-label={t("passphrase")} placeholder={t("passphrase")} value={rpass} onChange={(e) => setRpass(e.target.value)} />}
          <button className="btn" disabled={busy} onClick={verify}>
            {busy ? t("saving") : t("dryRun")}
          </button>
        </>
      )}
      {plan && !plan.issues.length && plan.manifestOk && (
        <>
          <p className="owed font-semibold">✓ {t("restoreChecked")}</p>
          {file &&
            computeTotals(plan.data, new Date(file.createdAt)).map((x) => (
              <p key={x.workspaceId + x.currency} className="help">
                {plan.data.workspaces.find((w) => w.id === x.workspaceId)?.name} · <Money minor={x.receivable} currency={x.currency} className="owed" /> · <Money minor={x.payable} currency={x.currency} className="owe" />
              </p>
            ))}
          {!firstLaunch && <Seg value={mode} onChange={setMode} options={[{ value: "merge", label: t("restoreMerge") }, { value: "replace", label: t("restoreReplace") }]} />}
          <button className="btn btn-primary" disabled={busy} onClick={doRestore}>
            {t("confirm")}
          </button>
        </>
      )}
      {error && <p className="banner banner-late">{error}</p>}
    </section>
  );
}

function Snapshots() {
  const { t, lang, store, data, ws } = useApp();
  const [snapshots, setSnapshots] = useState<{ id: string; createdAt: string; reason: string }[]>([]);
  useEffect(() => {
    store?.run("readonly", (tx) => tx.all("snapshots")).then((s) => setSnapshots(s.map(({ id, createdAt, reason }) => ({ id, createdAt, reason })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
  }, [store, data]);
  const download = async (id: string) => {
    const s = await store?.run("readonly", (tx) => tx.get("snapshots", id));
    if (s) downloadText(`nsalek-${id}.json`, s.backup, "application/json");
  };
  if (!snapshots.length) return null;
  return (
    <section className="card overflow-hidden">
      <h2 className="section-title px-4 pt-3 pb-1">{t("snapshots")}</h2>
      {snapshots.map((s) => (
        <div key={s.id} className="row">
          <span className="flex-1">
            <bdi className="num">{formatDateTime(s.createdAt, ws?.timezone)}</bdi> · {snapshotLabel(lang, s.reason)}
          </span>
          <button className="btn btn-sm" onClick={() => download(s.id)}>
            {t("download")}
          </button>
        </div>
      ))}
    </section>
  );
}
