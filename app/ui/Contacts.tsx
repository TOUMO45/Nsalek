"use client";
// People from the phone's contacts: the browser's picker where it exists (Chrome on Android), or a
// .vcf file exported from any contacts app. Shown first, created only for the ones ticked.
import { useState } from "react";
import { Contact as ContactIcon, FileUp, UserPlus } from "lucide-react";
import { useApp, newCommandId } from "@/lib/ui/state";
import { displayPhone } from "@/lib/ui/components";
import { errorMessage } from "@/lib/ui/i18n";
import { fromPicker, parseVcf, planContacts, type Contact } from "@/lib/core/contacts";

type Picker = { select(props: string[], opts: { multiple: boolean }): Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]>; getProperties?(): Promise<string[]> };
const picker = (): Picker | null => (typeof navigator !== "undefined" ? ((navigator as unknown as { contacts?: Picker }).contacts ?? null) : null);

export const canPickContacts = () => typeof picker()?.select === "function";

/** Opens the phone's own contact list (needs a tap). */
export async function pickContacts(multiple: boolean): Promise<Contact[]> {
  const p = picker();
  if (!p) return [];
  const have = (await p.getProperties?.().catch(() => null)) ?? ["name", "tel"];
  const props = ["name", "tel", "email"].filter((x) => have.includes(x));
  return fromPicker(await p.select(props, { multiple }));
}

const MAX = 1000;

export function ContactsImport({ onClose }: { onClose: () => void }) {
  const { t, lang, ws, data, run, toast } = useApp();
  // Planned once when the list arrives: the people added meanwhile must not re-plan every row.
  const [rows, setRows] = useState<ReturnType<typeof planContacts> | null>(null);
  const [total, setTotal] = useState(0);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);
  const chosen = (rows ?? []).filter((r) => !r.problem && !r.duplicates.length && !off.has(r.key));
  const load = (list: Contact[]) => {
    setDone(null);
    setError(null);
    setOff(new Set());
    setTotal(list.length);
    setRows(planContacts(list.slice(0, MAX), data.parties.filter((p) => p.workspaceId === ws?.id), ws?.country ?? "DZ"));
  };
  const add = async () => {
    if (!ws) return;
    setBusy(true);
    let added = 0;
    let skipped = 0;
    for (const r of chosen) {
      try {
        await run("createParty", { workspaceId: ws.id, displayName: r.name, phones: r.phonesE164, email: r.email }, newCommandId());
        added++;
      } catch {
        skipped++; // a duplicate made meanwhile, or a field the notebook refuses
      }
    }
    setBusy(false);
    setDone({ added, skipped });
    setRows(null);
    toast(t("saved"));
  };
  return (
    <section className="card stack p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="section-title">{t("contactsImport")}</h2>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      <p className="help">{t("contactsHelp")}</p>
      <div className="flex flex-wrap gap-2">
        {canPickContacts() && (
          <button
            className="btn btn-primary"
            onClick={() =>
              pickContacts(true).then(load, (e) => {
                if ((e as Error)?.name !== "AbortError") setError(errorMessage(lang, e));
              })
            }
          >
            <ContactIcon size={18} aria-hidden /> {t("contactsPick")}
          </button>
        )}
        <label className="btn cursor-pointer">
          <FileUp size={18} aria-hidden /> {t("contactsFile")}
          <input
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const list = parseVcf(await f.text());
              if (!list.length) setError(t("contactsNone"));
              else load(list);
            }}
          />
        </label>
      </div>
      {error && <p className="banner banner-late">{error}</p>}
      {done && (
        <p className="banner">
          {t("contactsAdded")}: <b className="num">{done.added}</b>
          {done.skipped > 0 && (
            <>
              {" · "}
              {t("contactsSkipped")}: <b className="num">{done.skipped}</b>
            </>
          )}
        </p>
      )}
      {rows && (
        <>
          {total > MAX && <p className="banner banner-warn">{t("contactsTooMany")}</p>}
          <div className="card max-h-[50vh] overflow-y-auto">
            {rows.map((r) => {
              const blocked = !!r.problem || r.duplicates.length > 0;
              return (
                <label key={r.key} className="row cursor-pointer" style={blocked ? { opacity: 0.65 } : undefined}>
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    disabled={blocked}
                    checked={!blocked && !off.has(r.key)}
                    onChange={(e) =>
                      setOff((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.delete(r.key);
                        else n.add(r.key);
                        return n;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{r.name || "—"}</span>
                    <span className="help num block truncate">{r.phonesE164.length ? r.phonesE164.map(displayPhone).join(" · ") : r.phones.join(" · ")}</span>
                    {!r.phonesE164.length && r.phones.length > 0 && <span className="chip chip-soon mt-1">{t("contactsBadNumber")}</span>}
                    {r.duplicates.length > 0 && (
                      <span className="chip chip-soon mt-1">
                        {t("contactsAlready")}: {r.duplicates[0].displayName}
                      </span>
                    )}
                    {r.problem && <span className="chip chip-late mt-1">{t("contactsNoName")}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <button className="btn btn-primary" disabled={busy || !chosen.length} onClick={add}>
            <UserPlus size={18} aria-hidden /> {busy ? t("saving") : `${t("contactsAdd")} (${chosen.length})`}
          </button>
        </>
      )}
    </section>
  );
}
