"use client";
// App state: opens IndexedDB, loads every record into memory, runs commands and applies
// their committed writes. "Saved" is only reported after the transaction commits.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { execute } from "../core/commands.ts";
import { todayIn } from "../core/dates.ts";
import { buildIndex, type LedgerIndex } from "../core/ledger.ts";
import type { Lang } from "../core/money.ts";
import { loadLedger } from "../core/restore.ts";
import type { Store } from "../core/store.ts";
import { DATA_STORES, emptyLedger, type LedgerData, type MetaRecord, type Workspace } from "../core/types.ts";
import type { VoiceUnit } from "../core/voice.ts";
import { openStore } from "../storage/idb.ts";
import { translate, type Key } from "./i18n.ts";

export type Prefs = {
  lang: Lang;
  theme: "system" | "light" | "dark";
  hideAmounts: boolean;
  dzWording: boolean;
  notifications: boolean;
  voiceLang: "ar-DZ" | "fr-FR" | "en-US";
  /** How amounts are counted when no unit is spoken (Algeria: dinars or centimes). */
  voiceUnit: VoiceUnit;
  voiceAutoSave: boolean;
  /** The user agreed that the browser's maker turns the audio into text. */
  voiceConsent: boolean;
  /** Notebook → spoken name → person, learned from confirmations. */
  voiceAliases: Record<string, Record<string, string>>;
};

const DEFAULT_PREFS: Prefs = { lang: "ar", theme: "system", hideAmounts: false, dzWording: true, notifications: false, voiceLang: "ar-DZ", voiceUnit: "ask", voiceAutoSave: true, voiceConsent: false, voiceAliases: {} };
const PREFS_KEY = "nsalek.prefs";

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

type Write = { store: string; value: unknown; deleted?: boolean };

function applyWrites(data: LedgerData, writes: Write[]): LedgerData {
  if (!writes.length) return data;
  const next = { ...data };
  for (const w of writes) {
    if (!(DATA_STORES as readonly string[]).includes(w.store)) continue;
    const key = w.store as keyof LedgerData;
    const id = (w.value as { id: string }).id;
    const list = next[key] as { id: string }[];
    next[key] = (
      w.deleted ? list.filter((r) => r.id !== id) : list.some((r) => r.id === id) ? list.map((r) => (r.id === id ? w.value : r)) : [...list, w.value]
    ) as never;
  }
  return next;
}

export type AppCtx = {
  status: "loading" | "ready" | "error";
  error: string | null;
  store: Store | null;
  data: LedgerData;
  meta: MetaRecord | null;
  ws: Workspace | null;
  idx: LedgerIndex | null;
  today: string;
  /** Minute-resolution clock, so screens can show elapsed time without reading it while rendering. */
  nowMs: number;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  lang: Lang;
  t: (k: Key) => string;
  run: <T = Record<string, unknown>>(type: string, payload: Record<string, unknown>, commandId?: string) => Promise<T>;
  saveMeta: (patch: Partial<MetaRecord>) => Promise<void>;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
  toastMsg: string | null;
  flashId: string | null;
  locked: boolean;
  setLocked: (v: boolean) => void;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider missing");
  return c;
}

export const newCommandId = () => crypto.randomUUID();

const MONEY_COMMANDS = new Set(["createObligation", "recordPayment", "postInvoice", "commitImport"]);

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppCtx["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [data, setData] = useState<LedgerData>(emptyLedger);
  const [meta, setMeta] = useState<MetaRecord | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [toastMsg, setToast] = useState<string | null>(null);
  const [flashId, setFlash] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const channel = useRef<BroadcastChannel | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (s: Store) => {
    const [ledger, m] = await Promise.all([
      loadLedger(s),
      s.run("readwrite", async (tx) => {
        let row = await tx.get("meta", "app");
        if (!row) {
          row = { id: "app", schemaVersion: 1, deviceId: crypto.randomUUID(), activeWorkspaceId: null, lastBackupAt: null };
          await tx.put("meta", row);
        }
        return row;
      }),
    ]);
    setData(ledger);
    setMeta(m);
    return { ledger, m };
  }, []);

  useEffect(() => {
    // Preferences are per-device conveniences kept in localStorage; read once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefsState(readPrefs());
    let cancelled = false;
    (async () => {
      try {
        const s = await openStore();
        if (cancelled) return;
        setStore(s);
        const { m } = await load(s);
        if (m.pin) setLocked(true);
        setStatus("ready");
        try {
          channel.current = new BroadcastChannel("nsalek");
          channel.current.onmessage = () => void load(s);
        } catch {
          /* BroadcastChannel unsupported: single tab only */
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStatus("error");
      }
    })();
    const tick = setInterval(() => setClock(Date.now()), 60_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      channel.current?.close();
    };
  }, [load]);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const next = { ...old, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* private mode: keep in memory */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = prefs.lang;
    root.dir = prefs.lang === "ar" ? "rtl" : "ltr";
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
  }, [prefs.lang, prefs.theme]);

  const ws = useMemo(() => data.workspaces.find((w) => w.id === meta?.activeWorkspaceId && !w.archivedAt) ?? null, [data.workspaces, meta?.activeWorkspaceId]);
  const today = useMemo(() => todayIn(ws?.timezone ?? "Africa/Algiers", new Date(clock)), [ws?.timezone, clock]);
  const idx = useMemo(() => (ws ? buildIndex(data, ws.id) : null), [data, ws]);

  const toast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Once real money is recorded, ask the browser not to evict it. Asked once here; each backup asks again.
  const asked = useRef(false);
  const askProtectedStorage = useCallback(() => {
    if (asked.current || !store || !navigator.storage?.persist) return;
    asked.current = true;
    void store
      .run("readonly", (tx) => tx.get("meta", "app"))
      .then(async (row) => {
        if (!row || row.persistentStorage) return;
        const granted = await navigator.storage.persist();
        await store.run("readwrite", async (tx) => {
          const now = await tx.get("meta", "app");
          if (now) await tx.put("meta", { ...now, persistentStorage: granted ? "granted" : "denied" });
        });
      })
      .catch(() => undefined);
  }, [store]);

  const run = useCallback(
    async <T,>(type: string, payload: Record<string, unknown>, commandId?: string): Promise<T> => {
      if (!store) throw new Error("storage_unavailable");
      const outcome = await execute<T>(store, { id: commandId ?? newCommandId(), type, payload });
      setData((d) => applyWrites(d, outcome.writes as Write[]));
      const firstId = (outcome.writes.find((w) => ["obligations", "payments", "parties"].includes(w.store))?.value as { id?: string } | undefined)?.id;
      if (firstId) setFlash(firstId);
      channel.current?.postMessage({ type: "changed" });
      if (MONEY_COMMANDS.has(type)) askProtectedStorage();
      return outcome.result;
    },
    [store, askProtectedStorage],
  );

  const saveMeta = useCallback(
    async (patch: Partial<MetaRecord>) => {
      if (!store) return;
      const next = await store.run("readwrite", async (tx) => {
        const row = { ...((await tx.get("meta", "app")) as MetaRecord), ...patch };
        await tx.put("meta", row);
        return row;
      });
      setMeta(next);
      channel.current?.postMessage({ type: "changed" });
    },
    [store],
  );

  const reload = useCallback(async () => {
    if (store) await load(store);
  }, [store, load]);

  const t = useCallback((k: Key) => translate(prefs.lang, k), [prefs.lang]);

  const value: AppCtx = {
    status,
    error,
    store,
    data,
    meta,
    ws,
    idx,
    today,
    nowMs: clock,
    prefs,
    setPrefs,
    lang: prefs.lang,
    t,
    run,
    saveMeta,
    reload,
    toast,
    toastMsg,
    flashId,
    locked,
    setLocked,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
