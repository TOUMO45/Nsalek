"use client";
// What a customer sees when they open the balance link the shop sent them. It needs nothing from
// this phone: everything is in the link. Read only.
import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { decodeSnapshot, type BalanceRow, type BalanceSnapshot } from "@/lib/core/balanceLink";
import { formatMoney } from "@/lib/core/money";
import { formatDate } from "@/lib/core/dates";

const W = {
  title: ["حسابك", "Votre compte", "Your account"],
  at: ["إلى غاية", "Au", "As of"],
  owesShop: ["عليك لـ {shop}", "Vous devez à {shop}", "You owe {shop}"],
  shopOwes: ["لك عند {shop}", "{shop} vous doit", "{shop} owes you"],
  credit: ["دفعت مسبقاً لـ {shop} (لم يُخصم بعد)", "Payé d’avance à {shop} (pas encore utilisé)", "Paid ahead to {shop} (not used yet)"],
  shopCredit: ["دفع لك {shop} مسبقاً", "{shop} vous a payé d’avance", "{shop} paid you ahead"],
  source: [
    "هذه الأرقام كتبها {shop} في دفتره. Nsalek لا يتحقق منها.",
    "Ces chiffres sont ceux que {shop} a notés dans son carnet. Nsalek ne les vérifie pas.",
    "These figures are what {shop} wrote in their notebook. Nsalek does not check them.",
  ],
  latest: ["آخر العمليات", "Dernières opérations", "Latest entries"],
  balance: ["الرصيد", "Solde", "Balance"],
  nothing: ["لا يوجد دين مسجّل.", "Aucune dette enregistrée.", "No debt recorded."],
  snapshot: [
    "هذه صورة للدفتر في هذا اليوم، وليست متابعة مباشرة. للأرقام الأحدث اسأل",
    "C’est une photo du carnet à cette date, pas un suivi en direct. Pour les derniers chiffres, demandez à",
    "This is a picture of the notebook on that day, not a live view. For the latest figures, ask",
  ],
  private: [
    "لا تُحفظ هذه الأرقام على أي خادم: هي داخل الرابط نفسه. من يملك الرابط يراها.",
    "Ces chiffres ne sont gardés sur aucun serveur : ils sont dans le lien lui-même. Qui a le lien peut les voir.",
    "These figures are not kept on any server: they are inside the link itself. Anyone with the link can see them.",
  ],
  bad: ["هذا الرابط غير كامل. اطلب رابطاً جديداً.", "Ce lien est incomplet. Demandez-en un nouveau.", "This link is incomplete. Ask for a new one."],
  k_obligation: ["دين", "Dette", "Debt"],
  k_payment: ["تسديد", "Remboursement", "Repayment"],
  k_advance_applied: ["تسبيق مخصوم", "Avance déduite", "Advance used"],
  k_increase: ["زيادة", "Augmentation", "Increase"],
  k_decrease: ["تخفيض", "Réduction", "Decrease"],
  k_waiver: ["إعفاء", "Remise", "Waived"],
  k_write_off: ["شطب", "Passé en perte", "Written off"],
  k_other: ["تعديل", "Correction", "Correction"],
} as const;

export function BalanceView({ code }: { code: string }) {
  const [s, setS] = useState<BalanceSnapshot | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    decodeSnapshot(code).then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, [code]);
  useEffect(() => {
    if (!s) return;
    const html = document.documentElement;
    const before = { lang: html.lang, dir: html.dir };
    html.lang = s.lang;
    html.dir = s.lang === "ar" ? "rtl" : "ltr";
    // Leaving the link: the app's own language and direction come back.
    return () => {
      html.lang = before.lang;
      html.dir = before.dir;
    };
  }, [s]);
  if (s === undefined) return null;
  const i = s ? { ar: 0, fr: 1, en: 2 }[s.lang] : 1;
  const w = (k: keyof typeof W) => W[k][i];
  const ws = (k: keyof typeof W) => w(k).replace("{shop}", s?.shop ?? "");
  const money = (minor: number, c: string) => {
    try {
      return formatMoney(minor, c, s?.lang ?? "fr");
    } catch {
      return String(minor);
    }
  };
  const kind = (k: string) => (`k_${k}` in W ? w(`k_${k}` as keyof typeof W) : w("k_other"));
  if (!s)
    return (
      <main className="mx-auto max-w-md p-6">
        <p className="banner banner-late">{W.bad.join(" · ")}</p>
      </main>
    );
  const rows = (list: BalanceRow[], c: string, cls: string) =>
    list.length > 0 && (
      <div className="card mt-2 overflow-hidden">
        {[...list].reverse().map((r, n) => (
          <div key={n} className="row text-[14px]">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{kind(r.k)}</span>
              <span className="help num block">{formatDate(r.d, s.lang)}</span>
            </span>
            <span className="text-end">
              <b className={`block ${r.a < 0 ? "" : cls}`}>
                <bdi dir="ltr">
                  {r.a < 0 ? "−" : "+"}
                  {money(Math.abs(r.a), c)}
                </bdi>
              </b>
              <span className="help block">
                {w("balance")}: <bdi dir="ltr">{money(r.b, c)}</bdi>
              </span>
            </span>
          </div>
        ))}
      </div>
    );
  return (
    <main className="mx-auto stack max-w-xl p-4">
      <div className="flex items-center gap-3">
        <span className="brand-mark">
          <BookOpen size={18} aria-hidden />
        </span>
        <div>
          <p className="text-[18px] font-bold leading-tight">{s.shop}</p>
          <p className="help">
            {w("title")} · {s.name}
          </p>
        </div>
      </div>
      <p className="help">
        {w("at")} <bdi className="num font-bold">{formatDate(s.at, s.lang)}</bdi>
      </p>
      {s.parts.length === 0 && <p className="banner">{w("nothing")}</p>}
      {s.parts.map((p) => (
        <section key={p.c} className="stack">
          <div className="hero">
            <div className="hero-row">
              <div className="hero-owed">
                <p className="hero-label">{ws("owesShop")}</p>
                <p className="hero-amount mt-2">
                  <bdi dir="ltr">{money(p.owed, p.c)}</bdi>
                </p>
              </div>
              {p.owe > 0 && (
                <div className="hero-owe">
                  <p className="font-bold owe">{ws("shopOwes")}</p>
                  <p className="owe hero-amount">
                    <bdi dir="ltr">{money(p.owe, p.c)}</bdi>
                  </p>
                </div>
              )}
            </div>
          </div>
          {!!p.cr && (
            <p className="banner">
              {ws("credit")}: <bdi dir="ltr" className="font-bold">{money(p.cr, p.c)}</bdi>
            </p>
          )}
          {!!p.cp && (
            <p className="banner">
              {ws("shopCredit")}: <bdi dir="ltr" className="font-bold">{money(p.cp, p.c)}</bdi>
            </p>
          )}
          {(p.r.length > 0 || p.p.length > 0) && <h2 className="section-title">{w("latest")}</h2>}
          {rows(p.r, p.c, "owed")}
          {rows(p.p, p.c, "owe")}
        </section>
      ))}
      <p className="help">
        {w("snapshot")} {s.shop}.
      </p>
      <p className="help">{ws("source")}</p>
      <p className="help">{w("private")}</p>
      <p className="help text-center">Nsalek · نسالك</p>
    </main>
  );
}
