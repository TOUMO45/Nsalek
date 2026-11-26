"use client";
// Sending a person the link to their own balance (see lib/core/balanceLink.ts).
import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { useApp } from "@/lib/ui/state";
import { balanceUrl, encodeSnapshot, makeSnapshot } from "@/lib/core/balanceLink";
import type { Lang } from "@/lib/core/money";

/** The link for this person in this language, made again when the figures change. */
export function useBalanceLink(partyId: string, lang: Lang, on: boolean, rows = 12): string | null {
  const { idx, ws, today } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const party = idx?.party.get(partyId);
    if (!on || !idx || !ws || !party) return;
    let live = true;
    encodeSnapshot(makeSnapshot(idx, party, ws, today, lang, rows)).then((code) => live && setUrl(balanceUrl(location.origin, code)));
    return () => {
      live = false;
    };
  }, [on, idx, ws, today, lang, partyId, rows]);
  return on ? url : null;
}

export function BalanceLinkButton({ partyId }: { partyId: string }) {
  const { t, lang, toast, idx } = useApp();
  const url = useBalanceLink(partyId, lang, true, 20);
  const party = idx?.party.get(partyId);
  const share = async () => {
    if (!url || !party) return;
    const text = `${t("balanceLinkText")} ${party.displayName}:`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: t("balanceLink"), text, url });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast(t("balanceLinkCopied"));
    } catch {
      window.prompt(t("balanceLink"), url);
    }
  };
  return (
    <button className="btn btn-sm" disabled={!url} onClick={share} title={t("balanceLinkHelp")}>
      <Link2 size={16} /> {t("balanceLink")}
    </button>
  );
}
