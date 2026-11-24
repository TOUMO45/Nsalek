"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Mic, Pencil, RotateCcw, Square } from "lucide-react";
import { newCommandId, useApp, type Prefs } from "@/lib/ui/state";
import { useSheet } from "@/lib/ui/sheets";
import { Money, Seg, Sheet } from "@/lib/ui/components";
import { listen, speechCtor, type SpeechProblem } from "@/lib/ui/speech";
import { errorMessage, type Key } from "@/lib/ui/i18n";
import { partyBalance } from "@/lib/core/ledger";
import { formatDate } from "@/lib/core/dates";
import { toInputValue } from "@/lib/core/money";
import { settle, understand, type VoiceContext, type VoiceFix, type VoiceIntent, type VoiceIssue } from "@/lib/core/voice";
import type { Direction } from "@/lib/core/types";

const AUTO_SAVE_SECONDS = 5;

type Saved = { kind: "debt" | "payment"; id: string; partyId: string; direction: Direction; amount: number; currency: string; undone?: boolean };

export function VoiceSheet({ onClose }: { onClose: () => void }) {
  const { t, prefs, idx, today, ws, lang, run, setPrefs } = useApp();
  const openSheet = useSheet();
  const [supported] = useState(() => !!speechCtor());
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [problem, setProblem] = useState<SpeechProblem | null>(null);
  const [typed, setTyped] = useState("");
  const [heard, setHeard] = useState<{ text: string }[] | null>(null);
  const [fix, setFix] = useState<VoiceFix>({});
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const saving = useRef(false);

  const aliases = useMemo(() => prefs.voiceAliases[ws?.id ?? ""] ?? {}, [prefs.voiceAliases, ws?.id]);
  const ctx = useMemo<VoiceContext | null>(() => (idx && ws ? { idx, today, currency: ws.defaultCurrency, unit: prefs.voiceUnit, aliases } : null), [idx, ws, today, prefs.voiceUnit, aliases]);
  const base = useMemo(() => (heard && ctx ? understand(heard, ctx) : null), [heard, ctx]);
  const intent = useMemo(() => (base && ctx ? settle(base, fix, ctx) : null), [base, fix, ctx]);
  // One id per sentence, so a retry after an error never records it twice.
  const ids = useRef({ party: newCommandId(), op: newCommandId() });

  const take = useCallback((alternatives: { text: string }[]) => {
    ids.current = { party: newCommandId(), op: newCommandId() };
    setFix({});
    setHeld(false);
    setError(null);
    setSaved(null);
    setHeard(alternatives);
  }, []);

  const start = useCallback(() => {
    if (!speechCtor()) return;
    stop.current?.();
    setHeard(null);
    setSaved(null);
    setProblem(null);
    setPartial("");
    setListening(true);
    try {
      stop.current = listen(prefs.voiceLang, {
        onPartial: setPartial,
        onFinal: take,
        onError: setProblem,
        onEnd: () => setListening(false),
      });
    } catch {
      setListening(false);
      setProblem("other");
    }
  }, [prefs.voiceLang, take]);

  const consent = prefs.voiceConsent;
  useEffect(() => {
    // Opening the sheet is the user's tap on the microphone: listen at once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (supported && consent) start();
    return () => stop.current?.();
    // Only when the sheet opens or the user has just agreed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, consent]);

  const save = useCallback(
    async (i: VoiceIntent) => {
      if (saving.current || !ws || i.issues.length || i.amount === null || !i.direction || (i.kind !== "debt" && i.kind !== "payment")) return;
      saving.current = true;
      setBusy(true);
      setError(null);
      try {
        const partyId = i.partyId ?? (await run<{ partyId: string }>("createParty", { workspaceId: ws.id, displayName: i.spokenName }, ids.current.party)).partyId;
        const common = { workspaceId: ws.id, partyId, direction: i.direction, currency: i.currency, date: i.date };
        const text = i.transcript.slice(0, 200);
        const id =
          i.kind === "debt"
            ? (await run<{ obligationId: string }>("createObligation", { ...common, principal: i.amount, description: text }, ids.current.op)).obligationId
            : (await run<{ paymentId: string }>("recordPayment", { ...common, amount: i.amount, note: text, allocations: "auto" }, ids.current.op)).paymentId;
        // A spoken name is remembered once the user confirmed it, never when several people share it.
        const single = base && (base.issues.includes("party_check") || base.issues.includes("party_new"));
        if (single && base.spokenKey) setPrefs({ voiceAliases: { ...prefs.voiceAliases, [ws.id]: { ...aliases, [base.spokenKey]: partyId } } });
        setSaved({ kind: i.kind, id, partyId, direction: i.direction, amount: i.amount, currency: i.currency });
        setHeard(null);
        navigator.vibrate?.(60);
      } catch (e) {
        setHeld(true);
        setError(errorMessage(lang, e));
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [ws, run, base, setPrefs, prefs.voiceAliases, aliases, lang],
  );

  const undo = async () => {
    if (!saved) return;
    setBusy(true);
    try {
      if (saved.kind === "debt") await run("voidObligation", { obligationId: saved.id, reason: t("voiceUndoReason") });
      else await run("reversePayment", { paymentId: saved.id, reason: t("voiceUndoReason") });
      setSaved({ ...saved, undone: true });
    } catch (e) {
      setError(errorMessage(lang, e));
    } finally {
      setBusy(false);
    }
  };

  const edit = (i: VoiceIntent) => {
    const amount = i.amount !== null ? toInputValue(i.amount, i.currency, lang) : "";
    if (i.kind === "payment") openSheet({ kind: "payment", direction: i.direction ?? "receivable", partyId: i.partyId ?? undefined, currency: i.currency, prefill: { amount, note: i.transcript.slice(0, 200), date: i.date } });
    else openSheet({ kind: "debt", direction: i.direction ?? "receivable", partyId: i.partyId ?? undefined, prefill: { name: i.partyId ? undefined : i.spokenName, amount: i.currency === ws?.defaultCurrency ? amount : "", description: i.transcript.slice(0, 200), date: i.date } });
  };

  const ready = !!intent && !intent.issues.length && (intent.kind === "debt" || intent.kind === "payment");

  return (
    <Sheet title={t("voice")} onClose={onClose}>
      <div className="stack">
        {supported && !consent ? (
          <div className="banner banner-warn flex-col">
            <p>{t("voiceConsentText")}</p>
            <button className="btn btn-primary w-full" onClick={() => setPrefs({ voiceConsent: true })}>
              <Mic size={18} aria-hidden /> {t("voiceConsentYes")}
            </button>
          </div>
        ) : supported ? (
          <div className="grid justify-items-center gap-2 py-2">
            <button className={`mic ${listening ? "mic-on" : ""}`} onClick={() => (listening ? (stop.current?.(), setListening(false)) : start())} aria-pressed={listening} aria-label={t(listening ? "voiceStop" : "voiceStart")} disabled={busy}>
              {listening ? <Square size={28} /> : <Mic size={34} />}
            </button>
            <p className="text-center font-semibold" aria-live="polite">
              {listening ? partial || t("voiceListening") : t("voiceStart")}
            </p>
          </div>
        ) : (
          <p className="banner banner-warn">{t("voiceUnsupported")}</p>
        )}
        {problem && <p className="banner banner-warn">{t(`voiceErr_${problem}` as Key)}</p>}

        {saved && <SavedCard saved={saved} busy={busy} onUndo={undo} onAgain={supported && consent ? start : undefined} />}

        {!saved && intent && (
          <>
            <p className="help">« {intent.transcript} »</p>
            {intent.kind === "balance" && intent.partyId ? <BalanceCard partyId={intent.partyId} onClose={onClose} /> : <IntentCard intent={intent} />}
            <Doubts key={intent.transcript} intent={intent} onFix={(f) => setFix((old) => ({ ...old, ...f }))} onEdit={() => edit(intent)} />
            {ready && <SaveBar intent={intent} auto={prefs.voiceAutoSave && !held} busy={busy} onSave={() => void save(intent)} onHold={() => setHeld(true)} onEdit={() => edit(intent)} />}
            {error && (
              <div className="banner banner-late flex-col">
                <p>{error}</p>
                <button className="btn btn-sm" onClick={() => edit(intent)}>
                  <Pencil size={16} aria-hidden /> {t("voiceEdit")}
                </button>
              </div>
            )}
          </>
        )}

        {!heard && !saved && <p className="help text-center">{t("voiceExamples")}</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            stop.current?.();
            setListening(false);
            setProblem(null);
            take([{ text: typed }]);
            setTyped("");
          }}
        >
          <input className="input flex-1" dir="auto" aria-label={t("voiceType")} placeholder={t("voiceType")} value={typed} onChange={(e) => (setTyped(e.target.value), setHeld(true))} />
          <button className="btn" disabled={!typed.trim() || busy}>
            {t("voiceUnderstand")}
          </button>
        </form>
        <VoiceSettings />
      </div>
    </Sheet>
  );
}

const kindLabel = (kind: "debt" | "payment", d: Direction): Key => (kind === "debt" ? (d === "receivable" ? "owedToMe" : "iOwe") : d === "receivable" ? "repaymentReceived" : "repaymentPaid");

function IntentCard({ intent }: { intent: VoiceIntent }) {
  const { t, idx, lang, today } = useApp();
  if (intent.kind !== "debt" && intent.kind !== "payment") return null;
  const name = intent.partyId ? idx?.party.get(intent.partyId)?.displayName : intent.spokenName;
  return (
    <div className="card stack p-4" aria-live="polite">
      {intent.direction && <p className={`font-bold ${intent.direction === "receivable" ? "owed" : "owe"}`}>{t(kindLabel(intent.kind, intent.direction))}</p>}
      <p className="text-[19px] font-bold">
        <bdi>{name || "?"}</bdi>
      </p>
      <p className="hero-amount">{intent.amount !== null ? <Money minor={intent.amount} currency={intent.currency} /> : "?"}</p>
      <p className="help">
        {t("date")}: {formatDate(intent.date, lang)}
        {intent.date === today && ` (${t("p_due_today")})`}
      </p>
    </div>
  );
}

function BalanceCard({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { t, idx, today } = useApp();
  const balances = idx ? [...partyBalance(idx, partyId, today)].filter(([, b]) => b.receivable || b.payable || b.advanceReceived || b.advancePaid) : [];
  return (
    <div className="card stack p-4" aria-live="polite">
      <p className="text-[19px] font-bold">
        <bdi>{idx?.party.get(partyId)?.displayName}</bdi>
      </p>
      {!balances.length && <p>{t("voiceNoBalance")}</p>}
      {balances.map(([currency, b]) => (
        <div key={currency}>
          {b.receivable > 0 && (
            <p className="owed font-semibold">
              {t("owedToMe")}: <Money minor={b.receivable} currency={currency} />
            </p>
          )}
          {b.payable > 0 && (
            <p className="owe font-semibold">
              {t("iOwe")}: <Money minor={b.payable} currency={currency} />
            </p>
          )}
          {b.advanceReceived > 0 && (
            <p className="help">
              {t("advance")}: <Money minor={b.advanceReceived} currency={currency} />
            </p>
          )}
        </div>
      ))}
      <a className="btn btn-sm w-fit" href={`#/people/${partyId}`} onClick={onClose}>
        {t("voiceOpenPerson")}
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- doubts

const BLOCKING: VoiceIssue[] = ["nothing", "negation", "future"];
const FORM_ONLY: VoiceIssue[] = ["no_balance", "overpayment"];

function Doubts({ intent, onFix, onEdit }: { intent: VoiceIntent; onFix: (f: VoiceFix) => void; onEdit: () => void }) {
  const { t, idx, prefs, setPrefs } = useApp();
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState(intent.spokenName);
  const has = (...l: VoiceIssue[]) => l.some((i) => intent.issues.includes(i));
  const Edit = (
    <button className="btn btn-sm" onClick={onEdit}>
      <Pencil size={16} aria-hidden /> {t("voiceEdit")}
    </button>
  );
  if (!intent.issues.length) return null;
  const blocked = BLOCKING.find((i) => has(i));
  if (blocked)
    return (
      <div className="banner banner-warn flex-col">
        <p>{t(`voiceAsk_${blocked}` as Key)}</p>
        {blocked !== "nothing" && Edit}
      </div>
    );
  const pickAmount = (minor: number) => {
    if (remember && intent.amounts.length === 2 && has("amount_unit")) setPrefs({ voiceUnit: minor === Math.max(...intent.amounts) ? "dinar" : "centime" });
    onFix({ amount: minor });
  };
  const formIssue = FORM_ONLY.find((i) => has(i));
  return (
    <div className="stack">
      {has("party_check") && intent.partyId && (
        <div className="banner banner-warn flex-col">
          <p>
            {t("voiceAsk_party_check")} <b>{idx?.party.get(intent.partyId)?.displayName}</b>
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm btn-primary" onClick={() => onFix({ partyId: intent.partyId! })}>
              {t("voiceYes")}
            </button>
            <button className="btn btn-sm" onClick={() => onFix({ newName: intent.spokenName })}>
              {t("voiceNewPerson")}: {intent.spokenName}
            </button>
            {Edit}
          </div>
        </div>
      )}
      {has("party") && (
        <div className="banner banner-warn flex-col">
          <p>{t("voiceAsk_party")}</p>
          <div className="flex flex-wrap gap-2">
            {intent.candidates.slice(0, 5).map((id) => (
              <button key={id} className="btn btn-sm" onClick={() => onFix({ partyId: id })}>
                {idx?.party.get(id)?.displayName}
              </button>
            ))}
            {Edit}
          </div>
        </div>
      )}
      {has("party_new") && (
        <div className="banner banner-warn flex-col">
          <p>{t("voiceAsk_party_new")}</p>
          <form
            className="flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onFix({ newName: name });
            }}
          >
            <input className="input flex-1" dir="auto" aria-label={t("person")} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={!name.trim()}>
              {t("voiceCreate")}
            </button>
          </form>
          {Edit}
        </div>
      )}
      {has("kind", "direction") && (
        <div className="banner banner-warn flex-col">
          <p>{t("voiceAsk_kind")}</p>
          <div className="grid w-full grid-cols-2 gap-2">
            {(
              [
                ["debt", "receivable"],
                ["debt", "payable"],
                ["payment", "receivable"],
                ["payment", "payable"],
              ] as const
            ).map(([kind, direction]) => (
              <button key={kind + direction} className="btn btn-wrap py-2" onClick={() => onFix({ kind, direction })}>
                {t(kindLabel(kind, direction))}
              </button>
            ))}
          </div>
        </div>
      )}
      {has("amount", "amount_unit", "amount_heard") && (
        <div className="banner banner-warn flex-col">
          <p>{t(has("amount_heard") ? "voiceAsk_amount_heard" : has("amount_unit") ? "voiceAsk_amount_unit" : "voiceAsk_amount")}</p>
          {intent.amounts.length > 0 && (
            <div className="flex w-full flex-wrap gap-2">
              {intent.amounts.map((m) => (
                <button key={m} className="btn flex-1 text-[17px] font-bold" onClick={() => pickAmount(m)}>
                  <Money minor={m} currency={intent.currency} />
                </button>
              ))}
            </div>
          )}
          {has("amount_unit") && intent.amounts.length === 2 && prefs.voiceUnit === "ask" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t("voiceRemember")}
            </label>
          )}
          {Edit}
        </div>
      )}
      {has("words", "date") && (
        <div className="banner banner-warn flex-col">
          <p>{t(has("date") ? "voiceAsk_date" : "voiceAsk_words")}</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm btn-primary" onClick={() => onFix({ confirmed: true })}>
              {t("voiceConfirm")}
            </button>
            {Edit}
          </div>
        </div>
      )}
      {formIssue && (
        <div className="banner banner-warn flex-col">
          <p>{t(`voiceAsk_${formIssue}` as Key)}</p>
          {Edit}
        </div>
      )}
    </div>
  );
}

function SaveBar({ intent, auto, busy, onSave, onHold, onEdit }: { intent: VoiceIntent; auto: boolean; busy: boolean; onSave: () => void; onHold: () => void; onEdit: () => void }) {
  const { t } = useApp();
  const [left, setLeft] = useState(AUTO_SAVE_SECONDS);
  const latest = useRef({ onSave, onHold });
  useEffect(() => {
    latest.current = { onSave, onHold };
  });
  // The countdown belongs to what is on screen: any change starts it again.
  const signature = [intent.transcript, intent.partyId, intent.spokenName, intent.kind, intent.direction, intent.amount, intent.date].join("|");
  useEffect(() => {
    if (!auto) return;
    let n = AUTO_SAVE_SECONDS;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLeft(n);
    const timer = setInterval(() => {
      n--;
      setLeft(n);
      if (n <= 0) {
        clearInterval(timer);
        latest.current.onSave();
      }
    }, 1000);
    // Nothing is saved while nobody can see it.
    const hide = () => document.hidden && latest.current.onHold();
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [auto, signature]);
  return (
    <div className="stack">
      {auto && (
        <p className="text-center font-semibold" role="timer">
          {t("voiceSavesIn").replace("{n}", String(Math.max(0, left)))}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={onSave}>
          <Check size={18} aria-hidden /> {t("voiceSaveNow")}
        </button>
        {auto ? (
          <button className="btn" disabled={busy} onClick={onHold}>
            {t("voiceWait")}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={onEdit}>
            <Pencil size={16} aria-hidden /> {t("voiceEdit")}
          </button>
        )}
      </div>
    </div>
  );
}

function SavedCard({ saved, busy, onUndo, onAgain }: { saved: Saved; busy: boolean; onUndo: () => void; onAgain?: () => void }) {
  const { t, idx, today } = useApp();
  const b = idx ? partyBalance(idx, saved.partyId, today).get(saved.currency) : undefined;
  const rest = (saved.direction === "receivable" ? b?.receivable : b?.payable) ?? 0;
  return (
    <div className="card stack p-4" aria-live="polite">
      <p className={`flex items-center gap-2 font-bold ${saved.undone ? "muted" : "owed"}`}>
        {saved.undone ? <RotateCcw size={18} aria-hidden /> : <Check size={18} aria-hidden />} {t(saved.undone ? "voiceUndone" : "voiceSaved")}
      </p>
      <p className={saved.undone ? "line-through" : ""}>
        {t(kindLabel(saved.kind, saved.direction))} · <bdi>{idx?.party.get(saved.partyId)?.displayName}</bdi> · <Money minor={saved.amount} currency={saved.currency} />
      </p>
      <p className="help">
        {t("remaining")}: <Money minor={rest} currency={saved.currency} />
      </p>
      <div className="flex flex-wrap gap-2">
        {onAgain && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={onAgain}>
            <Mic size={16} aria-hidden /> {t("voiceAgain")}
          </button>
        )}
        {!saved.undone && (
          <button className="btn btn-sm" disabled={busy} onClick={onUndo}>
            <RotateCcw size={16} aria-hidden /> {t("voiceUndo")}
          </button>
        )}
      </div>
    </div>
  );
}

function VoiceSettings() {
  const { t, prefs, setPrefs, ws } = useApp();
  return (
    <details>
      <summary className="help cursor-pointer font-semibold">{t("voiceSettings")}</summary>
      <div className="stack mt-2">
        <Seg<Prefs["voiceLang"]>
          value={prefs.voiceLang}
          onChange={(v) => setPrefs({ voiceLang: v })}
          options={[
            { value: "ar-DZ", label: "الدارجة" },
            { value: "fr-FR", label: "Français" },
            { value: "en-US", label: "English" },
          ]}
          label={t("voiceLangLabel")}
        />
        {ws?.defaultCurrency === "DZD" && (
          <>
            <Seg<Prefs["voiceUnit"]>
              value={prefs.voiceUnit}
              onChange={(v) => setPrefs({ voiceUnit: v })}
              options={[
                { value: "ask", label: t("voiceUnitAsk") },
                { value: "dinar", label: t("voiceUnitDinar") },
                { value: "centime", label: t("unitCentimes") },
              ]}
              label={t("voiceUnitLabel")}
            />
            <p className="help">{t("voiceUnitHelp")}</p>
          </>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={prefs.voiceAutoSave} onChange={(e) => setPrefs({ voiceAutoSave: e.target.checked })} /> {t("voiceAuto")}
        </label>
      </div>
    </details>
  );
}
