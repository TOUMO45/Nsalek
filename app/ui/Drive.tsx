"use client";
// The copy in the person's own Google Drive: choosing it, its state, its copies, putting one back.
import { useCallback, useEffect, useState } from "react";
import { HardDrive, RotateCcw, UploadCloud } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { useDrive } from "@/lib/ui/drive";
import { driveError, driveText, type DKey } from "@/lib/ui/driveText";
import { useAsk } from "@/lib/ui/components";
import { formatDateTime } from "@/lib/core/dates";
import type { BackupFile } from "@/lib/core/backup";
import type { CopyInfo } from "@/lib/drive/copy";
import { RestoreFlow } from "./Backup";

function useX() {
  const { lang } = useApp();
  return useCallback((k: DKey) => driveText(lang, k), [lang]);
}

const size = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 * 1024 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Runs a tap's work, keeping what went wrong in a person's words. */
function useJob() {
  const { lang } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // The work starts within the tap: Google's window may open from it.
  const run = (job: () => Promise<string | null | void>) => {
    setError(null);
    setNote(null);
    setWorking(true);
    job().then(
      (n) => (setNote(n || null), setWorking(false)),
      (e) => (setError(driveError(lang, e)), setWorking(false)),
    );
  };
  return { error, note, working, run };
}

function Title() {
  const x = useX();
  return (
    <div className="flex items-center gap-3">
      <span className="tile-icon" style={{ background: "var(--t2)", color: "var(--t2i)" }}>
        <HardDrive size={20} aria-hidden />
      </span>
      <h2 className="section-title">{x("title")}</h2>
    </div>
  );
}

export function DriveCard() {
  const d = useDrive();
  const x = useX();
  const { lang, ws } = useApp();
  const ask = useAsk();
  const job = useJob();
  const { prepare } = d;
  useEffect(() => {
    prepare();
  }, [prepare]);
  if (!d.available) return null;

  const copy = () =>
    job.run(async () => {
      const r = await d.copyNow();
      return r?.kind === "empty" ? x("nothing") : r ? x("copied") : null;
    });

  if (!d.connected)
    return (
      <section className="card stack p-4">
        <Title />
        <p>{x("why")}</p>
        <p className="help">{x("second")}</p>
        <button
          className="btn btn-primary"
          disabled={!d.ready || job.working}
          onClick={() =>
            job.run(async () => {
              await d.connect();
              const r = await d.copyNow();
              return r?.kind === "saved" ? x("copied") : null;
            })
          }
        >
          <HardDrive size={18} aria-hidden /> {job.working ? x("copying") : d.ready ? x("connect") : x("loading")}
        </button>
        <p className="help">{x("folder")}</p>
        {job.error && <p className="banner banner-late">{job.error}</p>}
      </section>
    );

  const until = d.until ? formatDateTime(new Date(d.until).toISOString(), ws?.timezone).split(" ").at(-1) : "";
  const problem = job.error ?? (d.error && d.error !== "drive_auth" ? driveError(lang, d.error) : null);
  return (
    <section className="card stack p-4">
      <Title />
      <div className="help">
        {d.email && (
          <p>
            {x("account")}: <b className="num">{d.email}</b>
          </p>
        )}
        <p>
          {x("last")}: <b>{d.lastAt ? <bdi className="num">{formatDateTime(d.lastAt, ws?.timezone)}</bdi> : x("never")}</b>
        </p>
        {d.quota?.limit ? (
          <p>
            {x("storage")}: <bdi className="num">{size(d.quota.usage ?? 0)}</bdi> {x("of")} <bdi className="num">{size(d.quota.limit)}</bdi>
          </p>
        ) : null}
      </div>
      <p className={`banner ${d.dirty ? "banner-warn" : ""}`}>
        <span>
          {d.dirty ? x("waiting") : x("upToDate")}{" "}
          {d.live ? (
            <>
              {x("auto")} <bdi className="num">{until}</bdi>.
            </>
          ) : (
            x("tap")
          )}
        </span>
      </p>
      <button className="btn btn-primary" disabled={d.busy || job.working} onClick={copy}>
        <UploadCloud size={18} aria-hidden /> {d.busy || job.working ? x("copying") : x("copyNow")}
      </button>
      <p role="status" aria-live="polite" className="help">
        {job.note}
      </p>
      {problem && <p className="banner banner-late">{problem}</p>}
      <Copies />
      <details>
        <summary className="help cursor-pointer font-semibold">{x("stop")}</summary>
        <div className="stack mt-2">
          <p className="help">{x("stopInfo")}</p>
          <button
            className="btn btn-sm btn-danger w-fit"
            onClick={async () => {
              if (await ask({ title: x("stop"), message: x("stopAsk"), confirmLabel: x("stop"), danger: true })) await d.disconnect();
            }}
          >
            {x("stop")}
          </button>
        </div>
      </details>
    </section>
  );
}

/** The copies in Drive, newest first, and putting one back. */
function Copies({ firstLaunch, start }: { firstLaunch?: boolean; start?: CopyInfo[] }) {
  const d = useDrive();
  const x = useX();
  const { meta, ws } = useApp();
  const job = useJob();
  const [list, setList] = useState<CopyInfo[] | null>(start ?? null);
  const [chosen, setChosen] = useState<{ info: CopyInfo; file: BackupFile } | null>(null);
  const load = () =>
    job.run(async () => {
      setList(await d.copies());
    });
  const where = (c: CopyInfo) => (c.device === meta?.deviceId ? x("thisPhone") : `${x("otherPhone")}${c.deviceName ? ` (${c.deviceName})` : ""}`);
  if (chosen)
    return (
      <div className="stack rounded-xl p-3" style={{ background: "var(--surface-2)" }}>
        <RestoreFlow file={chosen.file} label={`Google Drive · ${where(chosen.info)}`} firstLaunch={firstLaunch} onDone={() => setChosen(null)} />
        <button className="btn btn-sm w-fit" onClick={() => setChosen(null)}>
          {x("back")}
        </button>
      </div>
    );
  return (
    <div className="stack">
      {!firstLaunch && <h3 className="font-bold">{x("showCopies")}</h3>}
      {list === null ? (
        <button className="btn" disabled={job.working} onClick={load}>
          <RotateCcw size={18} aria-hidden /> {job.working ? x("opening") : x("open")}
        </button>
      ) : list.length === 0 ? (
        <p className="help">{x("none")}</p>
      ) : (
        <div className="card overflow-hidden">
          {list.map((c) => (
            <div key={c.id} className="row flex-wrap">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  <bdi className="num">{formatDateTime(c.at, ws?.timezone)}</bdi> · {where(c)}
                </span>
                <span className="help block">
                  {x("people")}: <bdi className="num">{c.people}</bdi> · {x("entries")}: <bdi className="num">{c.entries}</bdi> · {x("photos")}: <bdi className="num">{c.photos}</bdi> · <bdi className="num">{size(c.bytes)}</bdi>
                </span>
              </span>
              <button
                className="btn btn-sm"
                disabled={job.working}
                onClick={() =>
                  job.run(async () => {
                    setChosen({ info: c, file: await d.read(c) });
                  })
                }
              >
                {x("putBack")}
              </button>
            </div>
          ))}
        </div>
      )}
      {job.error && <p className="banner banner-late">{job.error}</p>}
    </div>
  );
}

/** First launch on a new phone: the notebook back from the person's Google Drive. */
export function DriveRestore() {
  const d = useDrive();
  const x = useX();
  const job = useJob();
  const [list, setList] = useState<CopyInfo[] | null>(null);
  const { prepare } = d;
  useEffect(() => {
    prepare();
  }, [prepare]);
  if (!d.available) return null;
  return (
    <section className="card stack p-4">
      <Title />
      <p className="help">{x("fromDriveHelp")}</p>
      {list === null ? (
        <button
          className="btn btn-primary"
          disabled={!d.ready || job.working}
          onClick={() =>
            job.run(async () => {
              if (!d.connected) await d.connect();
              setList(await d.copies());
            })
          }
        >
          <HardDrive size={18} aria-hidden /> {job.working ? x("opening") : d.ready ? x("openDrive") : x("loading")}
        </button>
      ) : (
        <Copies firstLaunch start={list} />
      )}
      {job.error && <p className="banner banner-late">{job.error}</p>}
    </section>
  );
}

/** The home reminder's button when this phone copies to Google Drive. */
export function DriveCopyButton() {
  const d = useDrive();
  const x = useX();
  const job = useJob();
  const { prepare } = d;
  useEffect(() => {
    prepare();
  }, [prepare]);
  return (
    <div className="stack">
      <button
        className="btn btn-sm btn-primary"
        disabled={d.busy || job.working || (!d.live && !d.ready)}
        onClick={() =>
          job.run(async () => {
            const r = await d.copyNow();
            return r?.kind === "empty" ? x("nothing") : r ? x("copied") : null;
          })
        }
      >
        <UploadCloud size={18} aria-hidden /> {d.busy || job.working ? x("copying") : x("copyNow")} · Google Drive
      </button>
      <p role="status" aria-live="polite" className="help">
        {job.note}
      </p>
      {job.error && <p className="banner banner-late">{job.error}</p>}
    </div>
  );
}
