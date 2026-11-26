"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/ui/state";
import { downloadText } from "@/lib/ui/components";
import { canShareFiles, deliverBackup, type Delivery } from "@/lib/ui/deliver";
import { errorMessage } from "@/lib/ui/i18n";
import { backupStatus, quickBackup, type QuickBackup } from "@/lib/core/quickBackup";
import { loadLedger } from "@/lib/core/restore";
import { brand } from "@/lib/brand";

export function useBackupStatus() {
  const { data, meta, nowMs } = useApp();
  const cloudAt = meta?.cloud?.link?.savedAt;
  return useMemo(() => backupStatus(data, meta?.lastBackupAt, new Date(nowMs), cloudAt), [data, meta?.lastBackupAt, nowMs, cloudAt]);
}

/** Makes one encrypted backup and hands it over. Needs meta.backupKey (set up on the backup screen). */
export function useQuickBackup() {
  const { store, meta, saveMeta, lang } = useApp();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<QuickBackup | null>(null);
  const [outcome, setOutcome] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const [canShare] = useState(() => typeof navigator !== "undefined" && canShareFiles(navigator));

  const finish = useCallback(
    async (b: QuickBackup, prefer: "share" | "download") => {
      const d = await deliverBackup(b.name, b.text, prefer, { nav: navigator, download: downloadText });
      setOutcome(d);
      setPending(d === "tap_again" ? b : null);
      if (d === "tap_again" || d === "cancelled") return;
      if (!b.check.ok) {
        // The file is kept, but it would not restore: the reminder must stay.
        setError(errorMessage(lang, { code: b.check.code }));
        await saveMeta({ lastBackupError: b.check.code ?? "integrity_failed" });
        return;
      }
      await saveMeta({ lastBackupAt: b.file.createdAt, lastBackupVia: d, lastBackupError: null });
    },
    [lang, saveMeta],
  );

  const guard = useCallback(
    async (job: () => Promise<void>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      setOutcome(null);
      try {
        await job();
      } catch (e) {
        setError(errorMessage(lang, e));
        await saveMeta({ lastBackupError: String((e as Error).message) });
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [lang, saveMeta],
  );

  const key = meta?.backupKey ?? null;
  const start = useCallback(
    (prefer: "share" | "download") =>
      guard(async () => {
        if (!store || !key) return;
        // Taken before reading, so an entry saved meanwhile still counts as not backed up.
        const now = new Date();
        const b = await quickBackup(await loadLedger(store), key, { now, appVersion: brand.version });
        await finish(b, prefer);
        // Asked again at each backup: the browser may grant it once the app is installed.
        const granted = await navigator.storage?.persist?.().catch(() => false);
        if (granted !== undefined) await saveMeta({ persistentStorage: granted ? "granted" : "denied" });
      }),
    [guard, store, key, finish, saveMeta],
  );
  const sendPending = useCallback(() => guard(async () => void (pending && (await finish(pending, "share")))), [guard, pending, finish]);

  return { ready: !!key, busy, pending, outcome, error, canShare, start, sendPending };
}
