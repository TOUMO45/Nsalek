"use client";
// Renders a multi-page statement from synthetic demo data in memory (nothing is stored).
// Used to preview the statement design and to verify PDF output (Arabic shaping, repeated
// table headers) with a headless browser.
import { useEffect, useState } from "react";
import { execute } from "@/lib/core/commands";
import { MemoryStore } from "@/lib/core/store";
import { loadLedger } from "@/lib/core/restore";
import { buildIndex, buildStatement } from "@/lib/core/ledger";
import { addDays, todayIn } from "@/lib/core/dates";
import type { Lang } from "@/lib/core/money";
import { seedDemo } from "@/lib/demo";
import { StatementView } from "../ui/Statement";

type Built = Parameters<typeof StatementView>[0];

export function SampleStatement() {
  const [built, setBuilt] = useState<Built | null>(null);
  useEffect(() => {
    (async () => {
      const lang = (new URLSearchParams(window.location.search).get("lang") as Lang) || "ar";
      const store = new MemoryStore();
      let n = 0;
      const run = async <T,>(type: string, payload: Record<string, unknown>) => (await execute<T>(store, { id: `s${++n}`, type, payload })).result;
      const today = todayIn("Africa/Algiers");
      const ws = await seedDemo(run as never, { lang, mode: "business", today });
      const parties = (await loadLedger(store)).parties;
      const karim = parties.find((p) => p.displayName === "Karim Benali")!;
      // 70 extra movements over a year so the table spans several pages.
      for (let i = 0; i < 35; i++) {
        const date = addDays(today, -360 + i * 9);
        await run("createObligation", { workspaceId: ws, partyId: karim.id, direction: "receivable", currency: "DZD", principal: 125_050 + i * 1_000, date, description: i % 2 ? "Ciment / إسمنت" : "Fournitures — مواد", reference: `BL-${2000 + i}` });
        await run("recordPayment", { workspaceId: ws, partyId: karim.id, direction: "receivable", currency: "DZD", amount: 100_000, date: addDays(date, 3), method: i % 3 ? "cash" : "ccp_baridimob" });
      }
      const data = await loadLedger(store);
      const idx = buildIndex(data, ws);
      const st = buildStatement(idx, karim.id, "DZD", addDays(today, -300), today);
      setBuilt({ ws: data.workspaces[0], party: idx.party.get(karim.id)!, st, idx, lang, generatedAt: new Date().toISOString() });
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
      document.documentElement.dataset.theme = "light";
    })();
  }, []);
  if (!built) return <p style={{ padding: 24 }}>…</p>;
  return (
    <div data-ready="true">
      <p className="no-print" style={{ padding: "8px 16px", background: "#fbf1df" }}>
        Sample statement — synthetic demo data · كشف تجريبي ببيانات وهمية
      </p>
      <StatementView {...built} />
    </div>
  );
}
