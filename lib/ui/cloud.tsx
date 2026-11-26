"use client";
// The account and the automatic cloud copy, for the screens. Firebase is downloaded only when this
// phone has an account or the person opens the account screen.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cloudConfig } from "../cloud/config.ts";
import type { Account, FirebaseCloud } from "../cloud/firebase.ts";
import type { CloudPort, Head, Version } from "../cloud/port.ts";
import { LOOK, waitAfterError, waitBeforeSave } from "../cloud/schedule.ts";
import { claimPhone, everythingSaved, forgetAccount, removeForeign, removeSaved, restoreVersion, syncOnce, type About, type Choice, type SyncOpts, type SyncState } from "../cloud/sync.ts";
import { brand } from "../brand.ts";
import { CloudError } from "../cloud/port.ts";
import { useApp } from "./state.tsx";

export type CloudStatus = "idle" | "working" | "waiting" | "saved" | "empty" | "offline" | "quota" | "choose" | "foreign" | "error";

export type CloudCtx = {
  /** This build knows a cloud. */
  available: boolean;
  /** null = not known yet. */
  signedIn: boolean | null;
  account: Account | null;
  status: CloudStatus;
  error: string | null;
  choose: Extract<SyncState, { kind: "choose" }> | null;
  foreign: string | null;
  open: () => Promise<FirebaseCloud>;
  syncNow: (choice?: Choice) => Promise<SyncState | null>;
  head: () => Promise<Head | null>;
  restore: (v: Version) => Promise<SyncState | null>;
  /** True when nothing on this phone is missing from the account's copy (photos aside). */
  allSaved: () => Promise<boolean>;
  signOut: (remove: boolean) => Promise<void>;
  removeFromPhone: () => Promise<void>;
  /** Another account's notebook on this phone becomes this account's. */
  claim: () => Promise<void>;
  deleteAccount: (password?: string) => Promise<void>;
  setAccount: (a: Account | null) => void;
};

const Ctx = createContext<CloudCtx | null>(null);

export function useCloud(): CloudCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("CloudProvider missing");
  return c;
}

let loading: Promise<FirebaseCloud> | null = null;
function openFirebase(): Promise<FirebaseCloud> {
  loading ??= import("../cloud/firebase.ts").then(({ FirebaseCloud }) => new FirebaseCloud(cloudConfig!));
  loading.catch(() => (loading = null)); // the download can be tried again
  return loading;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Linux";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : "Safari";
  return `${os} · ${br}`;
}

const optsOf = (a: Account): SyncOpts => ({ uid: a.uid, email: a.email, device: deviceName(), appVersion: brand.version });

/** One tab at a time. */
const oneTab = <T,>(job: () => Promise<T>): Promise<T> => (navigator.locks ? (navigator.locks.request("nsalek-cloud", job) as Promise<T>) : job());

const codeOf = (e: unknown) => String((e as { code?: string })?.code ?? "cloud_failed");

export function CloudProvider({ children }: { children: ReactNode }) {
  const { store, meta, data, status: appStatus, reload, saveMeta, setPrefs, lang } = useApp();
  const available = !!cloudConfig;
  const [wanted, setWanted] = useState(false);
  const [account, setAccountState] = useState<Account | null>(null);
  const [known, setKnown] = useState(false);
  const [status, setStatus] = useState<CloudStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [choose, setChoose] = useState<CloudCtx["choose"]>(null);
  const [foreign, setForeign] = useState<string | null>(null);

  const acc = useRef<Account | null>(null);
  const running = useRef<Promise<SyncState | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef({ end: 0, duration: 0, failures: 0 });
  const shownCloud = useRef("");
  useEffect(() => {
    shownCloud.current = JSON.stringify(meta?.cloud ?? null);
  }, [meta?.cloud]);
  /** Set while something serious is under way, so no automatic save slips in between. */
  const paused = useRef(false);
  /** Something may have changed since the last round began. */
  const dirty = useRef(false);
  const changes = useRef(0);
  /** The phone's mark of the last removal, as it was when this account signed in. */
  const stopSeen = useRef<Promise<string | null>>(Promise.resolve(null));
  const round = useRef<(choice?: Choice) => Promise<SyncState | null>>(async () => null);

  const setAccount = useCallback(
    (a: Account | null) => {
      if (store && a && a.uid !== acc.current?.uid) stopSeen.current = store.run("readonly", (tx) => tx.get("meta", "app")).then((m) => m?.cloudStop ?? null);
      acc.current = a;
      setAccountState(a);
      setKnown(true);
    },
    [store],
  );

  // Also while somebody is signed in: another tab may have removed the account from this phone.
  const needed = available && appStatus === "ready" && (wanted || !!meta?.cloud?.uid || !!account);
  useEffect(() => {
    if (!needed) return;
    let stop: (() => void) | undefined;
    let gone = false;
    openFirebase()
      .then((c) => {
        if (gone) return;
        stop = c.watch((a) => {
          if (a?.uid !== acc.current?.uid) {
            setChoose(null);
            setForeign(null);
            setError(null);
            setStatus("idle");
          }
          setAccount(a);
        });
      })
      .catch(() => {
        if (gone) return;
        setKnown(true);
        setStatus("offline");
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [needed, setAccount]);

  useEffect(() => {
    if (needed) void openFirebase().then((c) => c.setLanguage(lang), () => undefined);
  }, [needed, lang]);

  const plan = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void round.current();
    }, ms);
  }, []);

  /** Brings what the round wrote on this phone to the screens and to other tabs; nothing when it wrote nothing. */
  const refresh = useCallback(
    async (applied: boolean) => {
      if (!store) return;
      if (applied) await reload();
      const row = await store.run("readonly", (tx) => tx.get("meta", "app"));
      if (applied || JSON.stringify(row?.cloud ?? null) !== shownCloud.current) await saveMeta({});
    },
    [store, reload, saveMeta],
  );

  const planNext = useCallback(() => plan(waitBeforeSave(Date.now(), last.current.end, last.current.duration)), [plan]);

  const show = useCallback(
    (s: SyncState) => {
      setChoose(s.kind === "choose" ? s : null);
      setForeign(s.kind === "foreign" ? s.email : null);
      setError(null);
      setStatus(s.kind === "choose" ? "choose" : s.kind === "foreign" ? "foreign" : s.kind === "empty" ? "empty" : s.kind === "again" ? "waiting" : "saved");
    },
    [],
  );

  const attempt = useCallback(
    async (job: (o: SyncOpts, port: CloudPort) => Promise<SyncState>): Promise<SyncState | null> => {
      const a = acc.current;
      if (!store || !a) return null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      dirty.current = false;
      setStatus("working");
      const started = Date.now();
      let applied = false;
      try {
        const c = await openFirebase();
        const o: SyncOpts = { ...optsOf(a), onApplied: () => (applied = true) };
        const s = await oneTab(async () => {
          // Another tab removed the account from this phone while this round waited.
          const row = await store.run("readonly", (tx) => tx.get("meta", "app"));
          const stopped = (row?.cloudStop ?? null) !== (await stopSeen.current) && row?.cloud?.uid !== a.uid;
          return stopped ? null : job(o, c.port(a.uid));
        });
        if (!s) {
          setStatus("idle");
          return null;
        }
        last.current = { end: Date.now(), duration: Date.now() - started, failures: 0 };
        await refresh(applied);
        if (applied) {
          // What this round brought here is in the cloud already, unless something was entered since.
          const n = changes.current;
          if ((await everythingSaved(store, a.uid)) && n === changes.current) dirty.current = false;
        }
        show(s);
        if (s.kind === "again") plan(1500);
        return s;
      } catch (e) {
        const code = codeOf(e);
        last.current = { end: Date.now(), duration: Date.now() - started, failures: last.current.failures + 1 };
        setStatus(code === "cloud_offline" ? "offline" : code === "cloud_quota" ? "quota" : code === "cloud_moved" ? "waiting" : "error");
        setError(code);
        await refresh(applied).catch(() => undefined);
        const wait = waitAfterError(code, last.current.failures);
        if (wait !== null) plan(wait);
        throw e;
      }
    },
    [store, show, refresh, plan],
  );

  /** What was entered while a round or something serious was under way is planned now. */
  const settle = useCallback(() => {
    if (!dirty.current || timer.current || paused.current || !acc.current) return;
    setStatus((s) => (s === "saved" || s === "idle" || s === "empty" ? "waiting" : s));
    planNext();
  }, [planNext]);

  const exclusive = useCallback((job: (o: SyncOpts, port: CloudPort) => Promise<SyncState>) => {
    const next = (running.current ?? Promise.resolve(null)).catch(() => null).then(() => attempt(job));
    running.current = next;
    void next
      .catch(() => undefined)
      .finally(() => {
        if (running.current !== next) return;
        running.current = null;
        settle();
      });
    return next;
  }, [attempt, settle]);

  const shownChoice = useRef<About | undefined>(undefined);
  useEffect(() => {
    shownChoice.current = choose ? { reason: choose.reason, versionId: choose.head?.versionId ?? null } : undefined;
  }, [choose]);
  const syncNow = useCallback(
    (choice?: Choice) => {
      const about = choice && shownChoice.current;
      return exclusive((o, port) => syncOnce(store!, port, { ...o, choice, about }));
    },
    [exclusive, store],
  );

  useEffect(() => {
    round.current = async (choice) => {
      if (paused.current || (running.current && !choice)) return null;
      return syncNow(choice).catch(() => null);
    };
  }, [syncNow]);

  const uid = account?.uid ?? null;
  // At sign-in and at every start.
  useEffect(() => {
    if (uid && store) void round.current();
  }, [uid, store]);

  // After each change, once things are quiet. `data` is a new object at each change.
  const first = useRef(true);
  useEffect(() => {
    if (!uid) {
      first.current = true;
      return;
    }
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    changes.current++;
    if (timer.current) clearTimeout(timer.current); // once things are quiet
    timer.current = null;
    if (!running.current) settle(); // else when the round ends
  }, [data, uid, settle]);

  // Back online, back in the app, or leaving it.
  useEffect(() => {
    if (!uid) return;
    const now = () => void round.current();
    const visible = () => {
      if (document.hidden) {
        if (timer.current || dirty.current) now();
      } else if (Date.now() - last.current.end > 30_000) now();
    };
    const look = setInterval(() => !document.hidden && Date.now() - last.current.end > LOOK - 1000 && now(), LOOK);
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(look);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [uid]);

  const value = useMemo<CloudCtx>(() => {
    const withPause = async <T,>(job: () => Promise<T>): Promise<T> => {
      paused.current = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        dirty.current = true;
      }
      try {
        await running.current?.catch(() => null);
        return await oneTab(job);
      } finally {
        paused.current = false;
        settle();
      }
    };
    const clean = async () => {
      await reload();
      await saveMeta({});
      setChoose(null);
      setForeign(null);
      setError(null);
      setStatus("idle");
    };
    return {
      available,
      signedIn: known ? !!account : null,
      account,
      status,
      error,
      choose,
      foreign,
      open: () => {
        setWanted(true);
        return openFirebase();
      },
      syncNow,
      head: async () => (acc.current ? (await openFirebase()).port(acc.current.uid).head() : null),
      restore: (v) => exclusive((o, port) => restoreVersion(store!, port, o, v.id)),
      allSaved: async () => !!store && everythingSaved(store, meta?.cloud?.uid ?? ""),
      signOut: (remove) =>
        withPause(async () => {
          const c = await openFirebase();
          const a = acc.current;
          if (store && a && remove) {
            // Asked to the cloud now, not remembered from the last save.
            let applied = false;
            const removed = await removeSaved(store, c.port(a.uid), { ...optsOf(a), onApplied: () => (applied = true) }).finally(() => refresh(applied));
            if (!removed) throw new CloudError("cloud_not_saved");
            setPrefs({ voiceAliases: {} }); // people's names as they are spoken
          }
          await c.signOut();
          if (store && a && !remove) {
            // Nothing was ever sent or received: there is nothing to remind the person of.
            const row = await store.run("readonly", (tx) => tx.get("meta", "app"));
            if (!row?.cloud?.bound) await forgetAccount(store, a.uid);
          }
          await clean();
        }),
      removeFromPhone: () =>
        withPause(async () => {
          if (store && !(await removeForeign(store))) throw new CloudError("cloud_not_saved");
          setPrefs({ voiceAliases: {} });
          await clean();
        }).then(() => void round.current()),
      claim: () =>
        withPause(async () => {
          const a = acc.current;
          if (a && store) await claimPhone(store, a);
          await clean();
        }).then(async () => void (await syncNow())),
      deleteAccount: (password) =>
        withPause(async () => {
          const a = acc.current;
          if (!a || !store) return;
          const c = await openFirebase();
          await c.confirm(password);
          await c.port(a.uid).deleteAll();
          await c.deleteAccount();
          await forgetAccount(store, a.uid); // the notebook itself stays on the phone
          await clean();
        }),
      setAccount,
    };
  }, [available, known, account, status, error, choose, foreign, syncNow, exclusive, store, meta?.cloud?.uid, reload, saveMeta, setPrefs, settle, refresh, setAccount]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
