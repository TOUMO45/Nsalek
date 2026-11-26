"use client";
// The copy in the person's own Google Drive, for the screens. Google's script is loaded only once
// the person has chosen this copy or opens a screen that offers it. Google's permission lasts
// about an hour and stays in memory: while it lasts, copies are made by themselves; after it, a
// tap on "Copy now" asks Google again and copies in the same tap.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BackupFile } from "../core/backup.ts";
import type { MetaRecord } from "../core/types.ts";
import { changedSince, listCopies, readCopy, saveCopy, signature, type CopyInfo, type SaveResult } from "../drive/copy.ts";
import { driveAvailable, driveClientId, driveFake } from "../drive/config.ts";
import { FakeDrive, type FakeShelf } from "../drive/fake.ts";
import { askGoogle, googleReady, loadGoogle, revokeGoogle, type Grant } from "../drive/google.ts";
import { HttpDrive } from "../drive/http.ts";
import { DriveError, type DriveAbout, type DrivePort } from "../drive/port.ts";
import { brand } from "../brand.ts";
import { useApp } from "./state.tsx";

/** Wait after the last change, and between two copies made by themselves. */
const AFTER_CHANGE = 90_000;
const BETWEEN = 10 * 60_000;
/** A permission this close to its end is not used: a copy could stop half way. */
const MARGIN = 60_000;
/** After these, trying again by itself would only repeat the error: the person acts first. */
const NEEDS_PERSON = new Set(["drive_full", "drive_invalid", "drive_denied", "drive_off", "drive_scope"]);

export type DriveCtx = {
  available: boolean;
  /** Google's window can open from a tap. */
  ready: boolean;
  /** The person chose this copy on this phone. */
  connected: boolean;
  /** Google's permission is valid now. */
  live: boolean;
  until: number | null;
  email: string | null;
  busy: boolean;
  error: string | null;
  lastAt: string | null;
  quota: DriveAbout | null;
  /** Something changed since the last copy. */
  dirty: boolean;
  prepare: () => void;
  /** Call from a tap. */
  connect: () => Promise<void>;
  /** Call from a tap. */
  copyNow: () => Promise<SaveResult | null>;
  /** Call from a tap. */
  copies: () => Promise<CopyInfo[]>;
  read: (c: CopyInfo) => Promise<BackupFile>;
  disconnect: () => Promise<void>;
};

const Ctx = createContext<DriveCtx | null>(null);

export function useDrive(): DriveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("DriveProvider missing");
  return c;
}

/** Development only: the fake Drive keeps its files in this browser. */
function localShelf(): FakeShelf {
  const KEY = "nsalek.fakeDrive";
  return {
    load: () => {
      try {
        return JSON.parse(localStorage.getItem(KEY) ?? "[]");
      } catch {
        return [];
      }
    },
    save: (files) => localStorage.setItem(KEY, JSON.stringify(files)),
  };
}

export function deviceName(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Linux|CrOS/.test(ua)) return "Linux";
  return "";
}

export function DriveProvider({ children }: { children: ReactNode }) {
  const { store, meta, saveMeta, data } = useApp();
  const [grant, setGrant] = useState<Grant | null>(null);
  const grantRef = useRef<Grant | null>(null);
  const [ready, setReady] = useState(() => driveFake || googleReady());
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<DriveAbout | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The copy on its way, if any. */
  const inflight = useRef<Promise<SaveResult | null> | null>(null);
  /** When the last copy was tried, done or not. */
  const tried = useRef(0);
  const fake = useRef<FakeDrive | null>(null);
  const http = useRef<HttpDrive | null>(null);
  const drive = meta?.drive ?? null;

  const keep = useCallback((g: Grant | null) => {
    grantRef.current = g;
    setGrant(g);
    setNow(Date.now());
  }, []);

  const port = useCallback((): DrivePort => {
    if (driveFake) {
      fake.current ??= Object.assign(new FakeDrive(localShelf()), { email: "vous@gmail.com" });
      fake.current.full = localStorage.getItem("nsalek.fakeDrive.full") === "1";
      return fake.current;
    }
    http.current ??= new HttpDrive((lenient) => {
      const g = grantRef.current;
      return g && g.expiresAt - (lenient ? 5_000 : MARGIN) > Date.now() ? g.token : null;
    });
    return http.current;
  }, []);

  const prepare = useCallback(() => {
    if (!driveAvailable || driveFake) return;
    loadGoogle().then(
      () => setReady(true),
      () => setReady(false),
    );
  }, []);

  // Chosen on this phone: Google's window must be able to open at the first tap.
  useEffect(() => {
    if (drive) prepare();
  }, [drive, prepare]);

  // Removed here or in another tab, or the phone was wiped: the permission goes too.
  useEffect(() => {
    if (!drive && grantRef.current) {
      if (!driveFake) revokeGoogle(grantRef.current.token);
      grantRef.current = null;
      const t = setTimeout(() => keep(null));
      return () => clearTimeout(t);
    }
  }, [drive, keep]);

  // The screen learns when the permission ends.
  useEffect(() => {
    if (!grant) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(1000, grant.expiresAt - MARGIN - Date.now() + 500));
    return () => clearTimeout(t);
  }, [grant]);

  const live = !!drive && !!grant && grant.expiresAt - MARGIN > now;

  /** Starts Google's window at once: nothing may be awaited before it inside a tap. */
  const ask = useCallback((): Promise<Grant> => {
    if (driveFake) {
      const ttl = Number(localStorage.getItem("nsalek.fakeDrive.ttl") || 3600);
      return Promise.resolve({ token: "fake", expiresAt: Date.now() + ttl * 1000 });
    }
    if (!driveClientId) return Promise.reject(new DriveError("drive_off"));
    return askGoogle(driveClientId, meta?.drive?.email ?? undefined);
  }, [meta?.drive?.email]);

  const ensure = useCallback(async () => {
    const g = grantRef.current;
    if (g && g.expiresAt - MARGIN > Date.now()) return;
    keep(await ask());
  }, [ask, keep]);

  const once = useCallback(async (): Promise<SaveResult | null> => {
    if (!store || !meta) return null;
    tried.current = Date.now();
    setBusy(true);
    try {
      const r = await saveCopy(port(), store, { device: meta.deviceId, deviceName: deviceName(), appVersion: brand.version });
      await saveMeta((row: MetaRecord) => {
        if (!row.drive) return {}; // stopped meanwhile
        if (r.kind === "empty") return { drive: { ...row.drive, lastError: null } };
        const at = r.copy.at;
        return {
          drive: { ...row.drive, lastAt: at, sig: r.signature, lastError: null },
          // A copy with the photos is a backup: the reminders count from it.
          ...(row.lastBackupAt && row.lastBackupAt > at ? {} : { lastBackupAt: at, lastBackupVia: "drive" as const, lastBackupError: null }),
        };
      });
      return r;
    } catch (e) {
      const code = e instanceof DriveError ? e.code : String((e as { code?: string })?.code ?? "drive_failed");
      if (code === "drive_auth") keep(null);
      await saveMeta((row: MetaRecord) => (row.drive ? { drive: { ...row.drive, lastError: code } } : {}));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [store, meta, port, saveMeta, keep]);

  /** Asked by a person: after the copy on its way, if any, a new one (it may miss a later change). */
  const save = useCallback(async (): Promise<SaveResult | null> => {
    while (inflight.current) await inflight.current.catch(() => undefined);
    const p = once();
    inflight.current = p;
    try {
      return await p;
    } finally {
      if (inflight.current === p) inflight.current = null;
    }
  }, [once]);

  /** By itself: never while a copy is on its way. */
  const auto = useRef<() => void>(() => undefined);
  useEffect(() => {
    auto.current = () => {
      if (!inflight.current) void save().catch(() => undefined);
    };
  }, [save]);

  // What the newest copy holds, against what the phone holds: a restore or a pull from the account
  // counts too, and a phone clock running ahead cannot hide a change.
  const sig = useMemo(() => signature(data), [data]);
  const dirty = !!drive && sig !== null && (drive.sig !== undefined ? sig !== drive.sig : changedSince(data, drive.lastAt));
  const lastAt = drive?.lastAt ?? null;
  const lastError = drive?.lastError ?? null;
  const waitsForPerson = !!lastError && NEEDS_PERSON.has(lastError);

  // While the permission lasts: a copy a little after the first change not copied (later changes do
  // not push it back), not more than every ten minutes, and after a failure not before ten minutes
  // either (a phone's data is not free).
  useEffect(() => {
    if (!live || !dirty || busy || waitsForPerson) return;
    const since = lastAt ? Date.now() - Date.parse(lastAt) : Infinity;
    const sinceTry = lastError ? Date.now() - tried.current : Infinity;
    const t = setTimeout(() => auto.current(), Math.max(AFTER_CHANGE, BETWEEN - since, BETWEEN - sinceTry));
    return () => clearTimeout(t);
  }, [live, dirty, busy, lastAt, lastError, waitsForPerson]);

  // Leaving the app (another app, the screen turned off): copy now what is not copied yet, unless the
  // last try failed less than ten minutes ago.
  useEffect(() => {
    if (!live || !dirty || waitsForPerson) return;
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (lastError && Date.now() - tried.current < BETWEEN) return;
      auto.current();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [live, dirty, lastError, waitsForPerson]);

  const connect = useCallback(async () => {
    const asked = ask(); // first: Google's window opens within the tap
    const g = await asked;
    keep(g);
    const about = await port()
      .about()
      .catch(() => null);
    setQuota(about);
    await saveMeta((row: MetaRecord) => ({ drive: { connectedAt: row.drive?.connectedAt ?? new Date().toISOString(), lastAt: row.drive?.lastAt ?? null, email: about?.email ?? row.drive?.email ?? null, lastError: null } }));
  }, [ask, keep, port, saveMeta]);

  const copyNow = useCallback(async () => {
    await ensure();
    const r = await save();
    setQuota(
      await port()
        .about()
        .catch(() => null),
    );
    return r;
  }, [ensure, save, port]);

  const copies = useCallback(async () => {
    await ensure();
    return listCopies(port());
  }, [ensure, port]);

  const read = useCallback(
    async (c: CopyInfo) => {
      await ensure(); // within the tap: the permission may have ended since the list was shown
      return readCopy(port(), c);
    },
    [ensure, port],
  );

  const disconnect = useCallback(async () => {
    const g = grantRef.current;
    if (g && !driveFake) revokeGoogle(g.token);
    keep(null);
    setQuota(null);
    await saveMeta({ drive: null });
  }, [keep, saveMeta]);

  const value = useMemo<DriveCtx>(
    () => ({
      available: driveAvailable,
      ready,
      connected: !!drive,
      live,
      until: grant?.expiresAt ?? null,
      email: drive?.email ?? null,
      busy,
      error: drive?.lastError ?? null,
      lastAt,
      quota,
      dirty,
      prepare,
      connect,
      copyNow,
      copies,
      read,
      disconnect,
    }),
    [ready, drive, live, grant, busy, lastAt, quota, dirty, prepare, connect, copyNow, copies, read, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
