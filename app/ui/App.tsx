"use client";
import { useEffect, useRef, useState } from "react";
import { BookOpen, CalendarClock, Eye, EyeOff, Home as HomeIcon, Lock, Menu, Mic, Plus, Users, WifiOff } from "lucide-react";
import { AppProvider, useApp } from "@/lib/ui/state";
import { SheetContext, useSheet, type SheetSpec } from "@/lib/ui/sheets";
import { AskProvider, Toast, go, useOnline, useRoute } from "@/lib/ui/components";
import { verifyPin } from "@/lib/core/crypto";
import { pinDelayMs } from "@/lib/core/pin";
import { dailyActions, inQuietHours } from "@/lib/core/collections";
import { genericNotification } from "@/lib/core/messages";
import { timeIn } from "@/lib/core/dates";
import { brand } from "@/lib/brand";
import { seedDemo } from "@/lib/demo";
import { RestoreCard } from "./Backup";
import { useBackupStatus } from "./useQuickBackup";
import { Home } from "./Home";
import { PeopleList, PersonPage } from "./People";
import { Due } from "./Due";
import { MorePage } from "./More";
import { SheetHost } from "./Forms";
import { StatementPage, ReceiptPage, InvoicePrintPage } from "./Statement";

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const app = useApp();
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  useRecurringAndNotifications();

  if (app.status === "loading")
    return (
      <div className="grid min-h-dvh place-items-center">
        <p className="muted">{app.t("loading")}</p>
      </div>
    );
  if (app.status === "error")
    return (
      <div className="mx-auto max-w-md p-6">
        <div className="banner banner-late">
          <p>
            {app.t("storageError")} <code className="text-xs">{app.error}</code>
          </p>
        </div>
      </div>
    );
  if (app.locked) return <LockScreen />;
  if (!app.ws)
    return (
      <AskProvider>
        <Onboarding />
        <Toast />
      </AskProvider>
    );
  return (
    <SheetContext.Provider value={setSheet}>
      <AskProvider>
        <Shell />
        {sheet && <SheetHost spec={sheet} onClose={() => setSheet(null)} />}
        <Toast />
      </AskProvider>
    </SheetContext.Provider>
  );
}

function useRecurringAndNotifications() {
  const { ws, run, idx, today, prefs, meta, saveMeta, data, lang } = useApp();
  const backupUrgent = useBackupStatus().level === "urgent";
  const generatedFor = useRef<string | null>(null);
  // Recurring obligations: idempotent per period, so running at every start is safe.
  useEffect(() => {
    if (!ws || generatedFor.current === ws.id + today) return;
    generatedFor.current = ws.id + today;
    if (data.recurringPlans.some((p) => p.workspaceId === ws.id && p.state === "active")) void run("generateRecurring", { workspaceId: ws.id }).catch(() => undefined);
  }, [ws, today, run, data.recurringPlans]);
  // Generic once-a-day notification while the app is open; never names or amounts.
  useEffect(() => {
    if (!ws || !idx || !prefs.notifications || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (meta?.lastNotifiedOn === today || inQuietHours(timeIn(ws.timezone), ws.settings.quietHours)) return;
    const count = dailyActions(idx, today).length;
    if (!count && !backupUrgent) return;
    const n = genericNotification(lang, count, backupUrgent);
    const show = async () => {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(n.title, { body: n.body, tag: "nsalek-daily", icon: "/icon-192.png" });
      else new Notification(n.title, { body: n.body });
    };
    void show().catch(() => undefined);
    void saveMeta({ lastNotifiedOn: today });
  }, [ws, idx, today, prefs.notifications, meta?.lastNotifiedOn, saveMeta, lang, backupUrgent]);
}

function Shell() {
  const app = useApp();
  const { t, prefs, setPrefs, ws } = app;
  const route = useRoute();
  const backupLevel = useBackupStatus().level;
  const online = useOnline();
  const setSheet = useSheet();
  const top = route.parts[0] ?? "";
  const nav = [
    { href: "#/", key: "", label: t("home"), icon: <HomeIcon size={22} /> },
    { href: "#/people", key: "people", label: t("people"), icon: <Users size={22} /> },
    { href: "#/due", key: "due", label: t("due"), icon: <CalendarClock size={22} /> },
    { href: "#/more", key: "more", label: t("more"), icon: <Menu size={22} /> },
  ];
  const printOnly = top === "statement" || top === "receipt" || top === "invoice-print";
  return (
    <div className={printOnly ? "" : "shell"}>
      {!printOnly && (
        <aside className="sidebar no-print" aria-label="navigation">
          <div className="mb-4 flex items-center gap-2 px-2">
            <BookOpen className="owed" size={24} aria-hidden />
            <div>
              <p className="font-bold leading-tight">{prefs.lang === "ar" ? brand.nameAr : brand.name}</p>
              <p className="help leading-tight">{ws?.name}</p>
            </div>
          </div>
          <button className="btn btn-primary mb-3" onClick={() => setSheet({ kind: "debt", direction: "receivable" })}>
            <Plus size={18} /> {t("add")}
          </button>
          {nav.map((n) => (
            <a key={n.key} href={n.href} aria-current={top === n.key ? "page" : undefined}>
              {n.icon} {n.label}
            </a>
          ))}
        </aside>
      )}
      <div>
        {!printOnly && (
          <header className="topbar no-print">
            <div className="min-w-0 flex-1 lg:hidden">
              <p className="truncate font-bold leading-tight">{ws?.name}</p>
              {ws?.demo && <p className="help leading-tight">{t("demoBanner")}</p>}
            </div>
            <div className="hidden flex-1 lg:block">{ws?.demo && <span className="chip chip-soon">{t("demoBanner")}</span>}</div>
            {!online && (
              <span className="chip" title={t("offline")}>
                <WifiOff size={14} /> <span className="hidden sm:inline">{t("offline")}</span>
              </span>
            )}
            <button className="icon-btn" onClick={() => setSheet({ kind: "voice" })} aria-label={t("voice")} title={t("voice")}>
              <Mic size={20} />
            </button>
            <button className="icon-btn" onClick={() => setPrefs({ hideAmounts: !prefs.hideAmounts })} aria-label={t("hideAmounts")} aria-pressed={prefs.hideAmounts}>
              {prefs.hideAmounts ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
            {app.meta?.pin && (
              <button className="icon-btn" onClick={() => app.setLocked(true)} aria-label={t("lock")}>
                <Lock size={20} />
              </button>
            )}
          </header>
        )}
        <main className={printOnly ? "" : "main"}>
          <Router />
        </main>
      </div>
      {!printOnly && (
        <nav className="bottomnav no-print" aria-label="navigation">
          <a href="#/" aria-current={top === "" ? "page" : undefined}>
            {nav[0].icon}
            {nav[0].label}
          </a>
          <a href="#/people" aria-current={top === "people" ? "page" : undefined}>
            {nav[1].icon}
            {nav[1].label}
          </a>
          <button onClick={() => setSheet({ kind: "debt", direction: "receivable" })} aria-label={t("add")}>
            <span className="add-fab">
              <Plus size={26} />
            </span>
            {t("add")}
          </button>
          <a href="#/due" aria-current={top === "due" ? "page" : undefined}>
            {nav[2].icon}
            {nav[2].label}
          </a>
          <a href="#/more" aria-current={top === "more" ? "page" : undefined}>
            <span className="relative">
              {nav[3].icon}
              {backupLevel === "urgent" && <span className="nav-dot" />}
            </span>
            {nav[3].label}
            {backupLevel === "urgent" && <span className="sr-only">{t("backupUnsaved")}</span>}
          </a>
        </nav>
      )}
    </div>
  );
}

function Router() {
  const { parts, query } = useRoute();
  const [a, b] = parts;
  const key = parts.join("/");
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  if (a === "people" && b) return <PersonPage partyId={b} />;
  if (a === "people") return <PeopleList />;
  if (a === "due") return <Due tab={b} />;
  if (a === "more") return <MorePage section={b} sub={parts[2]} />;
  if (a === "statement" && b) return <StatementPage partyId={b} query={query} />;
  if (a === "receipt" && b) return <ReceiptPage paymentId={b} />;
  if (a === "invoice-print" && b) return <InvoicePrintPage invoiceId={b} />;
  return <Home />;
}

function Onboarding() {
  const { t, prefs, setPrefs, run, saveMeta, toast } = useApp();
  const [mode, setMode] = useState<"personal" | "business">("personal");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const start = async (demo: boolean) => {
    setBusy(true);
    try {
      const workspaceId = demo
        ? await seedDemo(run, { lang: prefs.lang, mode })
        : (await run<{ workspaceId: string }>("createWorkspace", { name: name.trim() || t("myNotebook"), mode, defaultCurrency: "DZD", timezone: "Africa/Algiers", country: "DZ" })).workspaceId;
      await saveMeta({ activeWorkspaceId: workspaceId });
      go("/");
    } catch (e) {
      toast(String((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-5">
      <div className="ruled card p-6">
        <BookOpen className="owed mb-3" size={34} aria-hidden />
        <h1 className="text-[26px] font-bold leading-snug">{t("welcome")}</h1>
        <p className="help mt-2 text-[15px]">{t("welcomeText")}</p>
      </div>
      <div className="seg" role="group" aria-label={t("language")}>
        {(["ar", "fr", "en"] as const).map((l) => (
          <button key={l} aria-pressed={prefs.lang === l} onClick={() => setPrefs({ lang: l })}>
            {l === "ar" ? "العربية" : l === "fr" ? "Français" : "English"}
          </button>
        ))}
      </div>
      <div className="grid gap-2">
        {(["personal", "business"] as const).map((m) => (
          <button key={m} className="card flex items-start gap-3 p-4 text-start" aria-pressed={mode === m} onClick={() => setMode(m)} style={mode === m ? { borderColor: "var(--brand)", borderWidth: 2 } : undefined}>
            <input type="radio" readOnly checked={mode === m} className="mt-1 h-4 w-4" tabIndex={-1} />
            <span>
              <span className="block font-bold">{t(m === "personal" ? "modePersonal" : "modeBusiness")}</span>
              <span className="help block">{t(m === "personal" ? "modePersonalHelp" : "modeBusinessHelp")}</span>
            </span>
          </button>
        ))}
      </div>
      <div>
        <label className="label" htmlFor="wsname">
          {t("workspaceName")}
        </label>
        <input id="wsname" className="input" placeholder={t("myNotebook")} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => start(false)}>
          {t("start")}
        </button>
        <button className="btn" disabled={busy} onClick={() => start(true)}>
          {t("startDemo")}
        </button>
        {!restoring && (
          <button className="btn" disabled={busy} onClick={() => setRestoring(true)}>
            {t("restoreFromBackup")}
          </button>
        )}
      </div>
      {restoring && <RestoreCard firstLaunch />}
    </div>
  );
}

function LockScreen() {
  const { t, meta, setLocked, saveMeta } = useApp();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const failures = meta?.pinFailures ?? 0;
  // One check at a time, counted immediately: PIN checks are slow on purpose, so overlapping
  // attempts must not all read the same stale count.
  const busy = useRef(false);
  const count = useRef(failures);
  useEffect(() => {
    count.current = meta?.pinFailures ?? 0;
  }, [meta?.pinFailures]);
  const waitUntil = meta?.pinLastFailAt ? Date.parse(meta.pinLastFailAt) + pinDelayMs(failures) : 0;
  const waitSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => {
    if (!waitSeconds) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waitSeconds]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current || waitUntil > Date.now()) return;
    busy.current = true;
    setChecking(true);
    try {
      if (meta?.pin && (await verifyPin(pin, meta.pin))) {
        if (count.current) await saveMeta({ pinFailures: 0, pinLastFailAt: null });
        setLocked(false);
      } else {
        count.current += 1;
        await saveMeta({ pinFailures: count.current, pinLastFailAt: new Date().toISOString() });
        setNow(Date.now());
        setErr(true);
        setPin("");
      }
    } finally {
      busy.current = false;
      setChecking(false);
    }
  };
  return (
    <form onSubmit={submit} className="mx-auto flex min-h-dvh max-w-xs flex-col justify-center gap-4 p-6 text-center">
      <Lock className="mx-auto owed" size={36} aria-hidden />
      <label className="font-bold" htmlFor="pin">
        {t("enterPin")}
      </label>
      <input id="pin" className="input num text-center text-[24px] tracking-[0.4em]" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} aria-invalid={err} />
      {err && !waitSeconds && <p className="error-text">{t("wrongPin")}</p>}
      {waitSeconds > 0 && (
        <p className="error-text" role="status">
          {t("pinWait").replace("{s}", String(waitSeconds))}
        </p>
      )}
      <button className="btn btn-primary" disabled={pin.length < 4 || waitSeconds > 0 || checking}>
        {t("unlock")}
      </button>
      <p className="help">{t("pinHelp")}</p>
    </form>
  );
}
