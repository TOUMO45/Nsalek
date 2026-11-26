"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Cloud, CloudAlert, CloudOff, CloudUpload, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { useCloud, type CloudStatus } from "@/lib/ui/cloud";
import { accountError, accountText, type AKey } from "@/lib/ui/accountText";
import { Field, Seg, useAsk } from "@/lib/ui/components";
import { formatDateTime } from "@/lib/core/dates";
import { peopleCount } from "@/lib/ui/i18n";
import { cloudView } from "@/lib/cloud/bundle";
import type { Choice } from "@/lib/cloud/sync";
import type { Version } from "@/lib/cloud/port";
import { DriveCard } from "./Drive";

const MIN_PASSWORD = 8;

function useText() {
  const { lang } = useApp();
  return useCallback((k: AKey) => accountText(lang, k), [lang]);
}

/** One button press at a time, with a readable error that stays on screen. */
function useAct() {
  const { lang } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = useRef(false);
  const act = async (job: () => Promise<unknown>) => {
    if (on.current) return false;
    on.current = true;
    setBusy(true);
    setError(null);
    try {
      await job();
      return true;
    } catch (e) {
      setError(accountError(lang, e));
      return false;
    } finally {
      on.current = false;
      setBusy(false);
    }
  };
  return { busy, error, act, setError };
}

function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p className="banner banner-late" role="alert">
      {children}
    </p>
  ) : null;
}

function PasswordInput({ value, onChange, label, help, autoComplete }: { value: string; onChange: (v: string) => void; label: string; help?: string; autoComplete: "current-password" | "new-password" }) {
  const a = useText();
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <Field label={label} htmlFor={id} help={help}>
      <div className="relative">
        <input id={id} className="input" dir="ltr" style={{ paddingInlineEnd: 48 }} type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="icon-btn absolute top-0" style={{ insetInlineEnd: 2 }} aria-label={a(show ? "hidePassword" : "showPassword")} aria-pressed={show} onClick={() => setShow(!show)}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------- signing in

export function SignInCard({ start = "in" }: { start?: "in" | "up" }) {
  const { lang } = useApp();
  const cloud = useCloud();
  const a = useText();
  const id = useId();
  const [mode, setMode] = useState<"in" | "up" | "forgot">(start);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [sent, setSent] = useState(false);
  const { busy, error, act, setError } = useAct();
  const { open } = cloud;
  useEffect(() => {
    // Downloaded while the person reads, so the Google window opens at the tap (a late window is blocked).
    void open().catch(() => undefined);
  }, [open]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const c = await open();
      c.setLanguage(lang);
      if (mode === "forgot") {
        await c.resetPassword(email);
        setSent(true);
      } else cloud.setAccount(mode === "up" ? await c.signUp(email, password) : await c.signIn(email, password));
    });
  };
  const google = () =>
    act(async () => {
      const c = await open();
      cloud.setAccount(await c.google());
    });
  const go = (m: typeof mode) => {
    setMode(m);
    setError(null);
    setSent(false);
  };
  return (
    <section className="card stack p-4">
      {mode === "forgot" ? (
        <>
          <h2 className="section-title">{a("forgot")}</h2>
          <p className="help">{a("forgotHelp")}</p>
        </>
      ) : (
        <>
          <p>{a("why")}</p>
          <p className="help">{a("optional")}</p>
          <details open={mode === "up" || undefined}>
            <summary className="cursor-pointer font-semibold">{a("privacyTitle")}</summary>
            <p className="help mt-2">{a("privacy")}</p>
          </details>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> <span>{a("agree")}</span>
          </label>
          <button type="button" className="btn" disabled={busy || !agree} onClick={google}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
            </svg>
            {a("google")}
          </button>
          <p className="help text-center">{a("or")}</p>
          <Seg value={mode} onChange={go} options={[{ value: "in", label: a("signIn") }, { value: "up", label: a("signUp") }]} />
        </>
      )}
      <form className="stack" onSubmit={submit} noValidate>
        <Field label={a("email")} htmlFor={id}>
          <input id={id} className="input" dir="ltr" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {mode !== "forgot" && <PasswordInput value={password} onChange={setPassword} label={a("password")} help={mode === "up" ? a("passwordHelp") : undefined} autoComplete={mode === "up" ? "new-password" : "current-password"} />}
        <Problem>{error}</Problem>
        {sent && (
          <p className="banner" role="status">
            {a("linkSent")}
          </p>
        )}
        <button className="btn btn-primary w-full" disabled={busy || !email.trim() || (mode !== "forgot" && (!agree || password.length < (mode === "up" ? MIN_PASSWORD : 1)))}>
          {mode === "forgot" ? a("sendLink") : mode === "up" ? a("signUp") : a("signIn")}
        </button>
      </form>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => go(mode === "forgot" ? "in" : "forgot")}>
        {a(mode === "forgot" ? "signIn" : "forgot")}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- status

const ICON: Partial<Record<CloudStatus, typeof Cloud>> = { working: CloudUpload, waiting: CloudUpload, offline: CloudOff, quota: CloudOff, choose: CloudAlert, foreign: CloudAlert, error: CloudAlert };

/** In the top bar, once this phone has had an account. */
export function CloudButton() {
  const { meta } = useApp();
  const cloud = useCloud();
  const a = useText();
  if (!cloud.available || !meta?.cloud) return null;
  const out = cloud.signedIn === false;
  const bad = out || ["choose", "foreign", "error"].includes(cloud.status);
  const Icon = out ? CloudAlert : (ICON[cloud.status] ?? Cloud);
  const label = a(out ? "st_out" : (`st_${cloud.status}` as AKey));
  return (
    <a href="#/more/account" className={`icon-btn ${bad ? "late" : cloud.status === "saved" ? "owed" : ""}`} aria-label={label} title={label}>
      <Icon size={20} />
    </a>
  );
}

/** On the home screen, only when the person has something to do about it. */
export function CloudNotice() {
  const { meta } = useApp();
  const cloud = useCloud();
  const a = useText();
  if (!cloud.available || !meta?.cloud) return null;
  const key: AKey | null = cloud.signedIn === false ? "st_out" : cloud.status === "choose" ? "st_choose" : cloud.status === "foreign" ? "st_foreign" : cloud.status === "error" ? "st_error" : null;
  if (!key) return null;
  return (
    <a href="#/more/account" className="banner banner-late">
      <CloudAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
      <span className="flex-1">{a(key)}</span>
      <span className="font-bold underline">{a("openAccount")}</span>
    </a>
  );
}

function StatusCard() {
  const { meta, lang, ws, data } = useApp();
  const cloud = useCloud();
  const a = useText();
  const { busy, error, act } = useAct();
  const link = meta?.cloud?.uid === cloud.account?.uid ? meta?.cloud?.link : undefined;
  const Icon = ICON[cloud.status] ?? Cloud;
  const bad = ["choose", "foreign", "error"].includes(cloud.status);
  const photos = data.attachments.filter((x) => data.workspaces.some((w) => w.id === x.workspaceId && !w.demo)).length;
  return (
    <section className="card stack p-4">
      <div>
        <p className="help">{a("signedInAs")}</p>
        <p className="truncate font-bold">
          <bdi dir="ltr">{cloud.account?.email}</bdi>
        </p>
      </div>
      <p className={`banner ${bad ? "banner-late" : cloud.status === "offline" || cloud.status === "quota" ? "banner-warn" : ""}`} role="status" aria-live="polite">
        <Icon size={18} className={`mt-0.5 shrink-0 ${cloud.status === "saved" ? "owed" : ""}`} aria-hidden />
        <span className="flex-1">
          {a(`st_${cloud.status}` as AKey)}
          {cloud.status === "error" && cloud.error && <span className="block">{accountError(lang, cloud.error)}</span>}
          {link && (
            <span className="help block">
              {a("lastSaved")}: <bdi className="num">{formatDateTime(link.savedAt, ws?.timezone)}</bdi>
            </span>
          )}
        </span>
      </p>
      {photos > 0 && (
        <p className="help">
          {a("photosLocal")} <bdi className="num font-bold">{photos}</bdi>{" "}
          <a href="#/more/backup" className="font-semibold underline">
            →
          </a>
        </p>
      )}
      {error && cloud.status !== "error" && <Problem>{error}</Problem>}
      {cloud.status !== "choose" && cloud.status !== "foreign" && (
        <button className="btn btn-sm w-fit" disabled={busy || cloud.status === "working"} onClick={() => act(() => cloud.syncNow())}>
          <CloudUpload size={16} aria-hidden /> {a("saveNow")}
        </button>
      )}
    </section>
  );
}

function Amounts({ people, entries }: { people: number; entries: number }) {
  const { lang } = useApp();
  const a = useText();
  return (
    <>
      <bdi>{peopleCount(lang, people)}</bdi>
      {a("comma")} {a("entries")}: <bdi className="num">{entries}</bdi>
    </>
  );
}

function Side({ label, people, entries, at, device }: { label: string; people: number; entries: number; at?: string; device?: string }) {
  const { ws } = useApp();
  const a = useText();
  return (
    <p>
      <b>{label}:</b> <Amounts people={people} entries={entries} />
      {at && (
        <span className="block">
          {a("lastChange")}: <bdi className="num">{formatDateTime(at, ws?.timezone)}</bdi> {device && <bdi>· {device}</bdi>}
        </span>
      )}
    </p>
  );
}

const latest = (audit: { at: string }[]) => audit.reduce<string | undefined>((m, e) => (m === undefined || e.at > m ? e.at : m), undefined);

function ChooseCard() {
  const { data } = useApp();
  const cloud = useCloud();
  const a = useText();
  const { busy, error, act } = useAct();
  const c = cloud.choose;
  if (!c) return null;
  const pick = (choice: Choice) => act(() => cloud.syncNow(choice));
  const view = cloudView(data);
  const now = c.head?.versions.find((v) => v.id === c.head!.versionId);
  return (
    <section className="card stack p-4" style={{ borderColor: "var(--late)" }}>
      <h2 className="section-title late">{a("st_choose")}</h2>
      <p>{a(c.reason === "both_changed" && c.canCombine ? "choose_doubts" : (`choose_${c.reason}` as AKey))}</p>
      {c.people.length > 0 && (
        <p>
          {a("chooseAbout")} <b>{c.people.slice(0, 4).map((name, i) => <bdi key={name}>{(i ? `${a("comma")} ` : "") + name}</bdi>)}</b>
          {c.people.length > 4 && " …"}
        </p>
      )}
      <div className="help grid gap-2">
        <Side label={a("phoneHas")} people={view.parties.filter((p) => !p.mergedIntoId).length} entries={view.obligations.length + view.payments.length} at={latest(view.audit)} />
        {now && <Side label={a("cloudHas")} people={now.people} entries={now.entries} at={c.head!.updatedAt} device={now.device} />}
      </div>
      {c.head && <p className="help">{a("chooseSafe")}</p>}
      <div className="grid gap-2">
        {c.canCombine && (
          <button className="btn btn-primary" disabled={busy} onClick={() => pick("combine")}>
            {a("combine")}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => pick("keep_phone")}>
          {a(c.head ? "keepPhone" : "saveAgain")}
        </button>
        {c.head && (
          <button className="btn" disabled={busy} onClick={() => pick("keep_cloud")}>
            {a("keepCloud")}
          </button>
        )}
      </div>
      <Problem>{error}</Problem>
    </section>
  );
}

function usePhotosWarning() {
  const { data } = useApp();
  const a = useText();
  const photos = data.attachments.filter((x) => data.workspaces.some((w) => w.id === x.workspaceId && !w.demo)).length;
  return photos ? ` ${a("removePhotos")} ${photos}` : "";
}

function ForeignCard() {
  const cloud = useCloud();
  const a = useText();
  const ask = useAsk();
  const { busy, error, act, setError } = useAct();
  const photos = usePhotosWarning();
  if (!cloud.foreign) return null;
  const remove = () =>
    act(async () => {
      if (!(await cloud.allSaved())) return setError(a("notAllSaved"));
      if ((await ask({ title: a("removeAsk"), message: a("removeForeignInfo") + photos, confirmLabel: a("removeThat"), danger: true })) === null) return;
      await cloud.removeFromPhone();
    });
  const claim = () =>
    act(async () => {
      if ((await ask({ title: a("claimAsk"), message: `${a("claimInfo")} ${cloud.account?.email}`, confirmLabel: a("claim") })) === null) return;
      await cloud.claim();
    });
  return (
    <section className="card stack p-4" style={{ borderColor: "var(--late)" }}>
      <h2 className="section-title late">{a("st_foreign")}</h2>
      <p>
        {a("foreignText")} <b dir="ltr">{cloud.foreign}</b>
      </p>
      <p className="help">{a("foreignHelp")}</p>
      <Problem>{error}</Problem>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" disabled={busy} onClick={() => act(() => cloud.signOut(false))}>
          {a("signOut")}
        </button>
        <button className="btn btn-sm whitespace-normal" disabled={busy} onClick={claim}>
          {a("claim")}
        </button>
        <button className="btn btn-sm btn-danger whitespace-normal" disabled={busy} onClick={remove}>
          {a("removeThat")}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- confirm the address

function VerifyCard() {
  const cloud = useCloud();
  const a = useText();
  const { busy, error, act, setError } = useAct();
  const [sent, setSent] = useState(false);
  if (!cloud.account || cloud.account.verified) return null;
  return (
    <section className="card stack p-4">
      <h2 className="section-title flex items-center gap-2">
        <ShieldAlert size={18} className="late" aria-hidden /> {a("verifyTitle")}
      </h2>
      <p className="help">{a("verifyHelp")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const now = await (await cloud.open()).refresh();
              cloud.setAccount(now);
              if (!now.verified) setError(a("verifyNotYet"));
            })
          }
        >
          {a("verifyDone")}
        </button>
        <button className="btn btn-sm" disabled={busy || sent} onClick={() => act(async () => (await (await cloud.open()).sendVerification(), setSent(true)))}>
          {a("verifySend")}
        </button>
      </div>
      {sent && (
        <p className="help" role="status">
          {a("linkSent")}
        </p>
      )}
      <Problem>{error}</Problem>
    </section>
  );
}

// ---------------------------------------------------------------- older copies

function VersionsCard() {
  const { ws, meta, toast } = useApp();
  const cloud = useCloud();
  const a = useText();
  const ask = useAsk();
  const { busy, error, act } = useAct();
  const [list, setList] = useState<Version[] | null>(null);
  const [currentId, setCurrent] = useState("");
  const link = meta?.cloud?.link;
  const load = async () => {
    const head = await cloud.head();
    setList([...(head?.versions ?? [])].sort((x, y) => y.rev - x.rev));
    setCurrent(head?.versionId ?? "");
  };
  const blocked = ["choose", "foreign"].includes(cloud.status);
  // A list on screen follows new saves.
  const shown = !!list;
  const reloadList = useRef(load);
  useEffect(() => {
    reloadList.current = load;
  });
  useEffect(() => {
    if (shown) void reloadList.current().catch(() => undefined);
  }, [link?.versionId, shown]);
  const back = (v: Version) =>
    act(async () => {
      if ((await ask({ title: a("putBackAsk"), message: a("putBackInfo"), confirmLabel: a("putBack") })) === null) return;
      const s = await cloud.restore(v);
      await load();
      if (s?.kind === "saved" || s?.kind === "up_to_date") toast(a("putBackDone"));
    });
  return (
    <section className="card stack overflow-hidden p-4">
      <h2 className="section-title">{a("versions")}</h2>
      <p className="help">{a("versionsHelp")}</p>
      {!list ? (
        <button className="btn btn-sm w-fit" disabled={busy} onClick={() => act(load)}>
          {a("versionsShow")}
        </button>
      ) : list.length === 0 ? (
        <p className="help">{a("none")}</p>
      ) : (
        <div className="-mx-4">
          {list.map((v) => (
            <div key={v.id} className="row">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  <bdi className="num">{formatDateTime(v.at, ws?.timezone)}</bdi> {v.id === currentId && <span className="chip chip-owed">{a("current")}</span>} {v.pinned && <span className="chip">{a("pinned")}</span>}
                </span>
                <span className="help block">
                  <Amounts people={v.people} entries={v.entries} /> · <bdi>{v.device}</bdi>
                </span>
              </span>
              {v.id !== currentId && (
                <button className="btn btn-sm" disabled={busy || blocked} onClick={() => back(v)}>
                  {a("putBack")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <Problem>{error}</Problem>
    </section>
  );
}

// ---------------------------------------------------------------- ways to sign in, leaving

function MethodsCard() {
  const { toast } = useApp();
  const cloud = useCloud();
  const a = useText();
  const { busy, error, act } = useAct();
  const ask = useAsk();
  const acc = cloud.account!;
  const unlink = () =>
    act(async () => {
      if ((await ask({ title: a("unlinkGoogle") + "?", message: a("unlinkInfo"), confirmLabel: a("unlinkGoogle"), danger: true })) === null) return;
      cloud.setAccount(await (await cloud.open()).unlinkGoogle());
    });
  const [form, setForm] = useState<"none" | "add" | "change">("none");
  const [now, setNow] = useState("");
  const [next, setNext] = useState("");
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const c = await cloud.open();
      if (form === "add") cloud.setAccount(await c.linkPassword(next));
      else {
        await c.confirm(now);
        await c.changePassword(next);
      }
      setForm("none");
      setNow("");
      setNext("");
      toast(a("done"));
    });
  };
  return (
    <section className="card stack p-4">
      <h2 className="section-title">{a("methods")}</h2>
      <p className="help">
        {a("methodsHelp")} {(acc.google ? 1 : 0) + (acc.password ? 1 : 0) < 2 && <b className="late">{a("onlyOne")}</b>}
      </p>
      <div className="flex flex-wrap gap-2">
        {acc.google ? (
          <span className="chip chip-owed">
            Google ✓ <bdi dir="ltr">{acc.googleEmail}</bdi>
          </span>
        ) : (
          <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => cloud.setAccount(await (await cloud.open()).linkGoogle()))}>
            {a("addGoogle")}
          </button>
        )}
        {acc.password && <span className="chip chip-owed">{a("password")} ✓</span>}
        <button className="btn btn-sm" disabled={busy} onClick={() => setForm(form === "none" ? (acc.password ? "change" : "add") : "none")}>
          {a(acc.password ? "changePassword" : "addPassword")}
        </button>
        {acc.google && acc.password && (
          <button className="btn btn-sm" disabled={busy} onClick={unlink}>
            {a("unlinkGoogle")}
          </button>
        )}
      </div>
      {acc.googleEmail && acc.googleEmail.toLowerCase() !== acc.email.toLowerCase() && <p className="banner banner-warn">{a("notYours")}</p>}
      {form !== "none" && (
        <form className="stack" onSubmit={save}>
          <input type="text" autoComplete="username" value={acc.email} readOnly hidden />
          {form === "change" && <PasswordInput value={now} onChange={setNow} label={a("currentPassword")} autoComplete="current-password" />}
          <PasswordInput value={next} onChange={setNext} label={a("newPassword")} help={a("passwordHelp")} autoComplete="new-password" />
          <button className="btn btn-primary btn-sm" disabled={busy || next.length < MIN_PASSWORD || (form === "change" && !now)}>
            {a(form === "add" ? "addPassword" : "changePassword")}
          </button>
        </form>
      )}
      <Problem>{error}</Problem>
    </section>
  );
}

function LeaveCard() {
  const { toast } = useApp();
  const cloud = useCloud();
  const a = useText();
  const ask = useAsk();
  const { busy, error, act, setError } = useAct();
  const deleting = useAct();
  const photos = usePhotosWarning();
  const [password, setPassword] = useState("");
  const acc = cloud.account!;
  const remove = () =>
    act(async () => {
      // The cloud must have it now; checked once more after the question.
      const s = await cloud.syncNow();
      if (!s || ["choose", "foreign", "again"].includes(s.kind)) return setError(a("notAllSaved"));
      if ((await ask({ title: a("removeAsk"), message: a("removeInfo") + photos, confirmLabel: a("signOutRemove"), danger: true })) === null) return;
      await cloud.signOut(true);
    });
  const destroy = () =>
    deleting.act(async () => {
      if ((await ask({ title: a("deleteAsk"), message: a("deleteHelp"), confirmLabel: a("deleteTitle"), danger: true })) === null) return;
      await cloud.deleteAccount(acc.password ? password : undefined);
      toast(a("deleted"));
    });
  return (
    <>
      <section className="card stack p-4">
        <h2 className="section-title">{a("signOut")}</h2>
        <p className="help">{a("signOutHelp")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button className="btn btn-sm whitespace-normal" disabled={busy} onClick={() => act(async () => (await cloud.signOut(false), toast(a("keptHere"))))}>
            {a("signOutKeep")}
          </button>
          {cloud.status !== "foreign" && (
            <button className="btn btn-sm btn-danger whitespace-normal" disabled={busy} onClick={remove}>
              {a("signOutRemove")}
            </button>
          )}
        </div>
        <Problem>{error}</Problem>
      </section>
      <details className="card p-4">
        <summary className="section-title cursor-pointer">{a("deleteTitle")}</summary>
        <div className="stack mt-3">
          <p className="help">{a("deleteHelp")}</p>
          {acc.password && <PasswordInput value={password} onChange={setPassword} label={a("password")} autoComplete="current-password" />}
          <Problem>{deleting.error}</Problem>
          <button className="btn btn-sm btn-danger w-fit" disabled={busy || deleting.busy || (acc.password && !password)} onClick={destroy}>
            {a("deleteTitle")}
          </button>
        </div>
      </details>
    </>
  );
}

export function AccountPage() {
  const { t, meta } = useApp();
  const cloud = useCloud();
  const a = useText();
  const signedIn = !!cloud.account;
  return (
    <>
      <h1 className="text-[22px] font-bold">{a("title")}</h1>
      {!cloud.available ? (
        <p className="banner">{t("notAvailable")}</p>
      ) : signedIn ? (
        <>
          <StatusCard />
          <ForeignCard />
          <ChooseCard />
          <VerifyCard />
          {cloud.status !== "foreign" && <VersionsCard />}
          <MethodsCard />
          <LeaveCard />
        </>
      ) : cloud.signedIn === null && meta?.cloud ? (
        <p className="help">{t("loading")}</p>
      ) : (
        <>
          {meta?.cloud && <p className="banner banner-late">{a("st_out")}</p>}
          <SignInCard start={meta?.cloud ? "in" : "up"} />
        </>
      )}
      <DriveCard />
    </>
  );
}

/** First launch: somebody who already has an account. */
export function FirstSignIn() {
  const cloud = useCloud();
  const a = useText();
  const { lang } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  // It opens below the buttons, out of sight on a small phone.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" }); // a promise in newer browsers: not returned to React
  }, []);
  if (!cloud.available) return null;
  if (!cloud.account)
    return (
      <div ref={ref}>
        <SignInCard start="in" />
      </div>
    );
  return (
    <section className="card stack p-4" role="status" aria-live="polite">
      <p className="font-bold">
        <bdi dir="ltr">{cloud.account.email}</bdi>
      </p>
      <p>{cloud.status === "empty" ? a("noNotebook") : cloud.error ? accountError(lang, cloud.error) : a(`st_${cloud.status}` as AKey)}</p>
      <div className="flex gap-2">
        <button className="btn btn-sm" disabled={cloud.status === "working"} onClick={() => void cloud.syncNow().catch(() => undefined)}>
          ↻
        </button>
        <button className="btn btn-sm" onClick={() => void cloud.signOut(false)}>
          {a("signOut")}
        </button>
      </div>
      {cloud.status === "error" && <VersionsCard />}
    </section>
  );
}
