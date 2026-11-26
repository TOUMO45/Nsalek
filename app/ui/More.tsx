"use client";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  DatabaseBackup,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  History,
  Import,
  Info,
  Lock,
  UserRound,
  NotebookPen,
  Receipt,
  Repeat,
  Settings as SettingsIcon,
  Store,
  Wallet,
} from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { Empty, Field, Money, Seg, go } from "@/lib/ui/components";
import { auditActionLabel, errorMessage } from "@/lib/ui/i18n";
import { hashPin } from "@/lib/core/crypto";
import { periodReport, perPartyBalances, upcomingInstallments } from "@/lib/core/reports";
import { addDays, formatDate, formatDateTime } from "@/lib/core/dates";
import { CURRENCIES, parseAmount, toInputValue } from "@/lib/core/money";
import { brand } from "@/lib/brand";
import { seedDemo } from "@/lib/demo";
import { Backup } from "./Backup";
import { AccountPage } from "./Account";
import { useCloud } from "@/lib/ui/cloud";
import { accountText } from "@/lib/ui/accountText";
import { useBackupStatus } from "./useQuickBackup";
import { Invoices, Notes, Recurring } from "./Business";
import { CsvPage, LegacyImportPage } from "./ImportExport";
import { Help } from "./Help";

/** What an employee may open (see lib/core/staff.ts). */
const STAFF_PAGES = new Set(["cash", "notes", "help", "about"]);

export function MorePage({ section, sub }: { section?: string; sub?: string }) {
  const { t, lang, ws, meta } = useApp();
  const staff = !!meta?.staffMode;
  const status = useBackupStatus();
  const cloud = useCloud();
  const unsaved = status.level === "due" || status.level === "urgent";
  if (!section) {
    const Chevron = lang === "ar" ? ChevronLeft : ChevronRight;
    const items: [string, string, React.ReactNode, boolean?][] = [
      ["account", accountText(lang, "title"), <UserRound key="i" size={20} />, !cloud.available],
      ["cash", t("cash"), <Wallet key="i" size={20} />],
      ["reports", t("reports"), <BarChart3 key="i" size={20} />],
      ["statements", t("statements"), <FileText key="i" size={20} />],
      ["invoices", t("invoices"), <Receipt key="i" size={20} />, ws?.mode !== "business" && !ws?.settings.invoices.enabled],
      ["recurring", t("recurring"), <Repeat key="i" size={20} />],
      ["notes", t("draftNotes"), <NotebookPen key="i" size={20} />],
      ["csv", `${t("importCsv")} / ${t("exportCsv")}`, <FileSpreadsheet key="i" size={20} />],
      ["backup", t("backup"), <DatabaseBackup key="i" size={20} />],
      ["workspaces", t("workspaces"), <Store key="i" size={20} />],
      ["settings", t("settings"), <SettingsIcon key="i" size={20} />],
      ["security", t("security"), <Lock key="i" size={20} />],
      ["legacy", t("legacyImport"), <Import key="i" size={20} />],
      ["audit", t("audit"), <History key="i" size={20} />],
      ["help", t("help"), <HelpCircle key="i" size={20} />],
      ["about", t("about"), <Info key="i" size={20} />],
    ];
    return (
      <div className="stack">
        <h1 className="text-[22px] font-bold">{t("more")}</h1>
        <nav className="card overflow-hidden">
          {items
            .filter(([k, , , hidden]) => !hidden && (!staff || STAFF_PAGES.has(k)))
            .map(([k, label, icon]) => (
              <a key={k} href={k === "cash" ? "#/cash" : `#/more/${k}`} className="row">
                <span className="muted">{icon}</span>
                <span className="flex-1 font-semibold">{label}</span>
                {k === "backup" && unsaved && <span className={`chip ${status.level === "urgent" ? "chip-late" : "chip-soon"}`}>{status.changes}</span>}
                <Chevron size={18} className="muted" />
              </a>
            ))}
        </nav>
      </div>
    );
  }
  const Back = (
    <a href="#/more" className="help inline-flex items-center gap-1 font-semibold">
      <ArrowLeft size={16} style={lang === "ar" ? { transform: "scaleX(-1)" } : undefined} /> {t("more")}
    </a>
  );
  const page = (() => {
    if (staff && !STAFF_PAGES.has(section)) return <p className="banner banner-warn">{errorMessage(lang, { code: "staff_not_allowed" })}</p>;
    switch (section) {
      case "account":
        return <AccountPage />;
      case "reports":
        return <Reports />;
      case "statements":
        return <Statements />;
      case "invoices":
        return <Invoices sub={sub} />;
      case "recurring":
        return <Recurring />;
      case "notes":
        return <Notes />;
      case "csv":
        return <CsvPage />;
      case "backup":
        return <Backup />;
      case "workspaces":
        return <Workspaces />;
      case "settings":
        return <Settings />;
      case "security":
        return <Security />;
      case "legacy":
        return <LegacyImportPage />;
      case "audit":
        return <Audit />;
      case "help":
        return <Help />;
      case "about":
        return <About />;
      default:
        return <Empty title={t("noResults")} />;
    }
  })();
  return (
    <div className="stack">
      {Back}
      {page}
    </div>
  );
}

// ---------------------------------------------------------------- reports

function Reports() {
  const { idx, today, t, lang } = useApp();
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const report = useMemo(() => (idx ? [...periodReport(idx, from, to)] : []), [idx, from, to]);
  const rows = useMemo(() => (idx ? perPartyBalances(idx, today).slice(0, 50) : []), [idx, today]);
  const inst = useMemo(() => (idx ? upcomingInstallments(idx, today, 30) : []), [idx, today]);
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("reports")}</h1>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("from")}>
          <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("to")}>
          <input type="date" className="input" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {report.length === 0 && <Empty title={t("noResults")} />}
      {report.map(([currency, r]) => (
        <section key={currency} className="card p-4">
          <h2 className="section-title mb-2">{currency}</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
            {(
              [
                ["newReceivables", r.newReceivables, "owed"],
                ["newPayables", r.newPayables, "owe"],
                ["cashReceived", r.cashReceived, ""],
                ["cashPaid", r.cashPaid, ""],
                ["waived", r.waivedReceivable + r.waivedPayable, ""],
                ["netting", r.netted, ""],
              ] as const
            ).map(([k, v, cls]) => (
              <div key={k}>
                <dt className="help">{t(k)}</dt>
                <dd className={`m-0 font-bold ${cls}`}>
                  <Money minor={v} currency={currency} />
                </dd>
              </div>
            ))}
          </dl>
          {Object.keys(r.receivedByMethod).length > 0 && (
            <p className="help mt-2">
              {t("cashReceived")}:{" "}
              {Object.entries(r.receivedByMethod).map(([m, v]) => (
                <span key={m} className="me-2">
                  {t(`m_${m}` as never)} <Money minor={v!} currency={currency} />
                </span>
              ))}
            </p>
          )}
          <p className="help mt-2">{t("cashNote")}</p>
        </section>
      ))}
      <section className="card overflow-x-auto">
        <h2 className="section-title px-4 pt-3 pb-1">{t("perPerson")}</h2>
        <table className="data">
          <thead>
            <tr>
              <th>{t("person")}</th>
              <th className="amount">{t("owedToMe")}</th>
              <th className="amount">{t("iOwe")}</th>
              <th className="amount">{t("overdue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.party.id + r.currency}>
                <td>
                  <a href={`#/people/${r.party.id}`}>{r.party.displayName}</a>
                </td>
                <td className="amount owed">{r.balance.receivable ? <Money minor={r.balance.receivable} currency={r.currency} /> : ""}</td>
                <td className="amount owe">{r.balance.payable ? <Money minor={r.balance.payable} currency={r.currency} /> : ""}</td>
                <td className="amount late">{r.balance.overdueReceivable ? <Money minor={r.balance.overdueReceivable} currency={r.currency} /> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {inst.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="section-title px-4 pt-3 pb-1">{t("upcomingInst")}</h2>
          {inst.map((i) => (
            <a key={i.obligationId + i.dueDate} href={`#/people/${i.party.id}`} className="row">
              <span className="flex-1">
                {i.party.displayName} · <bdi className="num">{formatDate(i.dueDate, lang)}</bdi>
              </span>
              <span className={`chip ${i.state === "missed" ? "chip-late" : ""}`}>{t(`i_${i.state}` as never)}</span>
              <Money minor={i.remaining} currency={i.currency} />
            </a>
          ))}
        </section>
      )}
    </>
  );
}

function Statements() {
  const { idx, t } = useApp();
  const [q, setQ] = useState("");
  const list = (idx?.parties ?? []).filter((p) => !p.mergedIntoId && (idx?.obByParty.get(p.id)?.length ?? 0) > 0 && p.displayName.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("statements")}</h1>
      <input className="input" type="search" placeholder={t("searchPeople")} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-hidden">
        {list.slice(0, 100).map((p) => (
          <a key={p.id} href={`#/statement/${p.id}`} className="row">
            <FileText size={18} className="muted" />
            <span className="flex-1 font-semibold">{p.displayName}</span>
          </a>
        ))}
        {!list.length && <p className="help p-4">{t("noResults")}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- workspaces, settings, security

function Workspaces() {
  const { data, ws, t, run, saveMeta, toast, lang } = useApp();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"personal" | "business">("business");
  const list = data.workspaces.filter((w) => !w.archivedAt);
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("workspaces")}</h1>
      <div className="card overflow-hidden">
        {list.map((w) => (
          <div key={w.id} className="row">
            <BookOpen size={18} className="muted" />
            <span className="flex-1">
              <span className="block font-semibold">{w.name}</span>
              <span className="help">
                {t(w.mode === "personal" ? "modePersonal" : "modeBusiness")} · {w.defaultCurrency}
                {w.demo ? ` · ${t("demoBanner")}` : ""}
              </span>
            </span>
            {w.id === ws?.id ? (
              <span className="chip chip-owed">{t("active")}</span>
            ) : (
              <button className="btn btn-sm" onClick={() => saveMeta({ activeWorkspaceId: w.id }).then(() => go("/"))}>
                {t("switchTo")}
              </button>
            )}
            {w.demo && (
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  try {
                    await run("archiveWorkspace", { workspaceId: w.id, reason: "demo" });
                    if (w.id === ws?.id) await saveMeta({ activeWorkspaceId: list.find((x) => x.id !== w.id)?.id ?? null });
                  } catch (e) {
                    toast(errorMessage(lang, e));
                  }
                }}
              >
                {t("removeDemo")}
              </button>
            )}
          </div>
        ))}
      </div>
      <form
        className="card stack p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await run<{ workspaceId: string }>("createWorkspace", { name, mode, defaultCurrency: "DZD", timezone: "Africa/Algiers" });
            await saveMeta({ activeWorkspaceId: r.workspaceId });
            setName("");
            go("/");
          } catch (err) {
            toast(errorMessage(lang, err));
          }
        }}
      >
        <h2 className="section-title">{t("newWorkspace")}</h2>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workspaceName")} />
        <Seg value={mode} onChange={setMode} options={[{ value: "personal", label: t("modePersonal") }, { value: "business", label: t("modeBusiness") }]} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          {t("save")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              const id = await seedDemo(run, { lang, mode });
              await saveMeta({ activeWorkspaceId: id });
              go("/");
            } catch (err) {
              toast(errorMessage(lang, err));
            }
          }}
        >
          {t("startDemo")}
        </button>
      </form>
    </>
  );
}

function Settings() {
  const { t, prefs, setPrefs, ws, run, toast, lang } = useApp();
  const [f, setF] = useState(() => ({
    name: ws!.name,
    mode: ws!.mode,
    currency: ws!.defaultCurrency,
    bname: ws!.business.name,
    bphone: ws!.business.phone,
    baddress: ws!.business.address,
    btax: ws!.business.taxId,
    aging: ws!.settings.agingBounds.join(", "),
    reminderMinDays: String(ws!.settings.reminderMinDays),
    qStart: ws!.settings.quietHours.start,
    qEnd: ws!.settings.quietHours.end,
    invoices: ws!.settings.invoices.enabled,
    taxRates: ws!.settings.invoices.taxRates.map((r) => `${r.label}=${r.bps / 100}`).join(", "),
  }));
  const set = (p: Partial<typeof f>) => setF((o) => ({ ...o, ...p }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const taxRates = f.taxRates
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s, i) => {
          const [label, pct] = s.split("=");
          return { id: `tax${i}`, label: label.trim(), bps: Math.round(Number(String(pct).replace(",", ".")) * 100) };
        });
      await run("updateWorkspace", {
        workspaceId: ws!.id,
        changes: {
          name: f.name,
          mode: f.mode,
          defaultCurrency: f.currency,
          business: { name: f.bname, phone: f.bphone, address: f.baddress, email: ws!.business.email, taxId: f.btax },
          settings: {
            agingBounds: f.aging.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)),
            reminderMinDays: Number(f.reminderMinDays),
            quietHours: { start: f.qStart, end: f.qEnd },
            invoices: { ...ws!.settings.invoices, enabled: f.invoices, taxRates },
          },
        },
      });
      toast(t("saved"));
    } catch (err) {
      toast(errorMessage(lang, err));
    }
  };
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("settings")}</h1>
      <section className="card stack p-4">
        <Field label={t("language")}>
          <Seg value={prefs.lang} onChange={(l) => setPrefs({ lang: l })} options={[{ value: "ar", label: "العربية" }, { value: "fr", label: "Français" }, { value: "en", label: "English" }]} />
        </Field>
        <Field label={t("theme")}>
          <Seg value={prefs.theme} onChange={(th) => setPrefs({ theme: th })} options={[{ value: "system", label: t("themeSystem") }, { value: "light", label: t("themeLight") }, { value: "dark", label: t("themeDark") }]} />
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={prefs.dzWording} onChange={(e) => setPrefs({ dzWording: e.target.checked })} /> {t("dzWording")}
        </label>
      </section>
      <form className="card stack p-4" onSubmit={save}>
        <Field label={t("workspaceName")}>
          <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t("mode")}>
          <Seg value={f.mode} onChange={(mode) => set({ mode })} options={[{ value: "personal", label: t("modePersonal") }, { value: "business", label: t("modeBusiness") }]} />
        </Field>
        <Field label={t("defaultCurrency")}>
          <select className="input" value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
            {Object.keys(CURRENCIES).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <p className="label">{t("businessIdentity")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder={t("displayName")} value={f.bname} onChange={(e) => set({ bname: e.target.value })} />
          <input className="input" placeholder={t("phone")} value={f.bphone} onChange={(e) => set({ bphone: e.target.value })} />
          <input className="input" placeholder={t("address")} value={f.baddress} onChange={(e) => set({ baddress: e.target.value })} />
          <input className="input" placeholder={t("taxId")} value={f.btax} onChange={(e) => set({ btax: e.target.value })} />
        </div>
        <Field label={t("agingBounds")}>
          <input className="input num" style={{ direction: "ltr" }} value={f.aging} onChange={(e) => set({ aging: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t("reminderMinDays")}>
            <input className="input num" inputMode="numeric" value={f.reminderMinDays} onChange={(e) => set({ reminderMinDays: e.target.value.replace(/\D/g, "") })} />
          </Field>
          <Field label={`${t("quietHours")} ↦`}>
            <input type="time" className="input" value={f.qStart} onChange={(e) => set({ qStart: e.target.value })} />
          </Field>
          <Field label="↤">
            <input type="time" className="input" value={f.qEnd} onChange={(e) => set({ qEnd: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={f.invoices} onChange={(e) => set({ invoices: e.target.checked })} /> {t("enableInvoices")}
        </label>
        {f.invoices && (
          <Field label={t("taxRates")} help={`${t("taxNote")} — TVA=19, TVA réduite=9`}>
            <input className="input" value={f.taxRates} onChange={(e) => set({ taxRates: e.target.value })} />
          </Field>
        )}
        <button className="btn btn-primary">{t("save")}</button>
      </form>
    </>
  );
}

function Security() {
  const { t, prefs, setPrefs, meta, saveMeta, toast } = useApp();
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("security")}</h1>
      <section className="card stack p-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={prefs.hideAmounts} onChange={(e) => setPrefs({ hideAmounts: e.target.checked })} /> {t("hideAmounts")}
        </label>
        <p className="help">{t("hideAmountsHelp")}</p>
      </section>
      <section className="card stack p-4">
        <h2 className="section-title">{t("pinLock")}</h2>
        <p className="banner banner-warn">{t("pinHelp")}</p>
        {meta?.pin ? (
          <button className="btn btn-danger w-fit" disabled={!!meta.staffMode} onClick={() => saveMeta({ pin: null, pinFailures: 0, pinLastFailAt: null }).then(() => toast(t("saved")))}>
            {t("removePin")}
          </button>
        ) : (
          <form
            className="grid gap-2 sm:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              await saveMeta({ pin: await hashPin(pin), pinFailures: 0, pinLastFailAt: null });
              setPin("");
              setPin2("");
              toast(t("saved"));
            }}
          >
            <input className="input num" type="password" inputMode="numeric" autoComplete="new-password" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} />
            <input className="input num" type="password" inputMode="numeric" autoComplete="new-password" placeholder={t("confirm")} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 8))} />
            <button className="btn btn-primary" disabled={pin.length < 4 || pin !== pin2}>
              {t("setPin")}
            </button>
          </form>
        )}
      </section>
      <section className="card stack p-4">
        <h2 className="section-title">{t("staffMode")}</h2>
        <p>{t("staffHelp")}</p>
        <p className="help">{t("staffLimit")}</p>
        {!meta?.pin && <p className="banner banner-warn">{t("staffNeedsPin")}</p>}
        <button
          className="btn btn-primary w-fit"
          disabled={!meta?.pin}
          onClick={async () => {
            await saveMeta({ staffMode: true });
            go("/");
          }}
        >
          {t("staffStart")}
        </button>
      </section>
    </>
  );
}

function Audit() {
  const { data, ws, t, idx, lang } = useApp();
  const list = useMemo(() => data.audit.filter((a) => a.workspaceId === ws?.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300), [data.audit, ws?.id]);
  // Who or what the entry is about, in words: person, debt description, receipt or invoice number.
  const subject = (id: string) => {
    const adj = data.adjustments.find((a) => a.id === id);
    const ob = idx?.obligation.get(adj?.obligationId ?? id);
    const pay = idx?.payment.get(id);
    const inv = data.invoices.find((i) => i.id === id);
    const party = idx?.party.get(id) ?? idx?.party.get(ob?.partyId ?? pay?.partyId ?? inv?.partyId ?? "");
    return [party?.displayName, ob?.description, pay?.receiptNumber, inv?.number].filter(Boolean).join(" · ");
  };
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("audit")}</h1>
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>{t("date")}</th>
              <th>{t("type")}</th>
              <th>{t("reason")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="num whitespace-nowrap">{formatDateTime(a.at, ws?.timezone)}</td>
                <td>
                  <span className="font-semibold">{auditActionLabel(lang, a.action)}</span>
                  {a.actor === "staff" && <span className="chip chip-soon ms-1">{t("actor_staff")}</span>}
                  {subject(a.entityId) && <span className="help block">{subject(a.entityId)}</span>}
                </td>
                <td>{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function About() {
  const { t, lang } = useApp();
  const items =
    lang === "ar"
      ? [
          "تعمل بدون حساب وبدون إنترنت؛ تُحفظ البيانات في IndexedDB على هذا المتصفح. بحساب اختياري تُحفظ نسخة على الإنترنت.",
          "يمكن للمتصفح حذف البيانات إذا مُسحت بيانات الموقع أو امتلأت الذاكرة: احتفظ بنسخ احتياطية.",
          "التنبيهات تظهر عند فتح التطبيق فقط، ولا يوجد إرسال تلقائي للرسائل.",
          "واتساب/SMS: يُفتح تطبيقك للمراجعة؛ لا نسجّل «وصل» أبداً.",
          "قفل PIN شاشة خصوصية وليس تشفيراً. النسخ الاحتياطية يمكن تشفيرها بـ AES-GCM.",
          "النسخة السحابية لا تشمل الصور، وليست مشاركة فورية بين عدة أشخاص. لا ذكاء اصطناعي في هذه النسخة.",
        ]
      : lang === "fr"
        ? [
            "Fonctionne sans compte ni internet ; les données sont dans IndexedDB de ce navigateur. Avec un compte facultatif, une copie est gardée en ligne.",
            "Le navigateur peut effacer les données (effacement du site, espace plein) : gardez des sauvegardes.",
            "Les notifications s’affichent à l’ouverture de l’application ; aucun envoi automatique de message.",
            "WhatsApp/SMS : votre application s’ouvre pour relecture ; jamais de statut « distribué ».",
            "Le verrou PIN est un écran de confidentialité, pas un chiffrement. Les sauvegardes peuvent être chiffrées (AES-GCM).",
            "La copie en ligne ne contient pas les photos et n’est pas un partage en direct entre plusieurs personnes. Pas d’IA dans cette version.",
          ]
        : [
            "Works without an account or internet; data lives in this browser’s IndexedDB. With an optional account, a copy is kept online.",
            "The browser may clear data (site data cleared, low space): keep backups.",
            "Notifications appear when the app is opened; no automatic message sending.",
            "WhatsApp/SMS: your own app opens for review; never marked “delivered”.",
            "The PIN lock is a privacy screen, not encryption. Backups can be encrypted (AES-GCM).",
            "The cloud copy leaves out photos and is not live sharing between several people. No AI in this version.",
          ];
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("about")}</h1>
      <section className="card p-4">
        <p className="font-bold">
          {brand.name} · {brand.nameAr} <bdi className="num">v{brand.version}</bdi>
        </p>
        <ul className="mt-2 list-disc ps-5">
          {items.map((x) => (
            <li key={x} className="mb-1">
              {x}
            </li>
          ))}
        </ul>
        <a className="btn btn-sm mt-3 w-fit" href="/privacy" target="_blank" rel="noopener">
          {t("privacy")}
        </a>
      </section>
    </>
  );
}

// Re-exported for Business.tsx convenience.
export { parseAmount, toInputValue, addDays };
