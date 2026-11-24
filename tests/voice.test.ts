// Voice entries: from what the phone heard (Darija, French, English) to a debt or a repayment.
// An entry may be saved without a tap only when nothing is doubtful, so most of these tests check
// that doubtful sentences are stopped.
import test from "node:test";
import assert from "node:assert/strict";
import { listen, type SpeechLike } from "../lib/ui/speech.ts";
import { settle, soundKey, spokenAmounts, understand, type VoiceContext, type VoiceUnit } from "../lib/core/voice.ts";
import { harness, DA, TODAY } from "./helpers.ts";

async function shop() {
  const h = harness();
  const { workspaceId } = await h.run("createWorkspace", { name: "Hanout" });
  const add = async (displayName: string) => (await h.run("createParty", { workspaceId, displayName })).partyId as string;
  const p = {
    mohamed: await add("محمد"),
    samir: await add("سمير"),
    fatima: await add("فاطمة"),
    karim: await add("Karim Benali"),
    ali: await add("علي"),
    grossiste: await add("عمي الطاهر"),
  };
  const debt = (partyId: string, amount: number, direction = "receivable") =>
    h.run("createObligation", { workspaceId, partyId, direction, currency: "DZD", principal: DA(amount), date: "2026-11-01" });
  await debt(p.mohamed, 10_000);
  await debt(p.fatima, 4_000);
  await debt(p.grossiste, 50_000, "payable");
  const idx = await h.index(workspaceId);
  const ctx = (unit: VoiceUnit = "dinar", extra: Partial<VoiceContext> = {}): VoiceContext => ({ idx, today: TODAY, currency: "DZD", unit, aliases: {}, ...extra });
  const say = (text: string, unit?: VoiceUnit, extra?: Partial<VoiceContext>) => understand([{ text }], ctx(unit, extra));
  return { ...h, workspaceId, p, ctx, say };
}

// ---------------------------------------------------------------- numbers

const value = (s: string) => spokenAmounts(s).map((a) => a.value);

test("numbers: Darija words", () => {
  for (const [s, n] of [
    ["خمسة آلاف", 5000],
    ["خمس تالاف", 5000],
    ["ألف", 1000],
    ["ألفين", 2000],
    ["ألف وخمسمية", 1500],
    ["ألف وخمس مية", 1500],
    ["ألفين وميتين", 2200],
    ["خمسة وعشرين ألف", 25_000],
    ["عشرين ألف", 20_000],
    ["خمسطاش ألف", 15_000],
    ["مية وخمسين", 150],
    ["ميتين وخمسين ألف", 250_000],
    ["تلتمية", 300],
    ["مليون", 1_000_000],
    ["مليون ونص", 1_500_000],
    ["زوج ملاين", 2_000_000],
    ["مليون وميتين ألف", 1_200_000],
    ["ألف ونص", 1500],
  ] as const)
    assert.deepEqual(value(s), [n], s);
});

test("numbers: French, English, digits and digits with a scale word", () => {
  for (const [s, n] of [
    ["cinq mille", 5000],
    ["deux mille cinq cents", 2500],
    ["mille deux cent cinquante", 1250],
    ["quatre-vingt-dix", 90],
    ["soixante-quinze", 75],
    ["five thousand two hundred", 5200],
    ["5000", 5000],
    ["5 000", 5000],
    ["٥٠٠٠", 5000],
    ["20 ألف", 20_000],
    ["3 ملايين", 3_000_000],
    ["1500,50", 1500.5],
  ] as const)
    assert.deepEqual(value(s), [n], s);
});

test("numbers: small counts are not amounts, unless a currency follows", () => {
  assert.deepEqual(value("زوج خبزات"), []);
  assert.deepEqual(value("un client"), []);
  assert.deepEqual(value("خمسة دينار"), [5]);
});

test("numbers: unclear groups are flagged, never guessed", () => {
  for (const s of ["5,000", "5.000", "ألف مليون", "عشرين خمسين", "مليون وربع", "ألف إلا مية", "عشرين دورو"]) assert.equal(spokenAmounts(s)[0].unclear, true, s);
});

// ---------------------------------------------------------------- dinars or centimes

test("unit: without a spoken unit nothing is assumed until the user has chosen how they count", async () => {
  const { say } = await shop();
  const r = say("محمد دا عشرين ألف", "ask");
  assert.ok(r.issues.includes("amount_unit"));
  assert.equal(r.amount, null);
  assert.deepEqual(r.amounts, [DA(20_000), DA(200)]);
});

test("unit: the user's choice and the spoken unit decide", async () => {
  const { say } = await shop();
  assert.equal(say("محمد دا عشرين ألف", "dinar").amount, DA(20_000));
  assert.equal(say("محمد دا عشرين ألف", "centime").amount, DA(200));
  for (const unit of ["ask", "dinar", "centime"] as const) {
    assert.equal(say("محمد دا ألفين دينار", unit).amount, DA(2000), unit);
    assert.equal(say("محمد دا ألفين دج", unit).amount, DA(2000), unit);
    assert.equal(say("محمد دا مليون سنتيم", unit).amount, DA(10_000), unit);
    assert.equal(say("محمد دا عشرين ألف فرنك", unit).amount, DA(200), unit);
  }
});

test("unit: a bare مليون usually means centimes, so a dinar user is asked", async () => {
  const { say } = await shop();
  const r = say("محمد دا مليون", "dinar");
  assert.ok(r.issues.includes("amount_unit"));
  assert.deepEqual(r.amounts, [DA(10_000), DA(1_000_000)]);
  assert.equal(say("محمد دا مليون", "centime").amount, DA(10_000));
});

test("unit: a centime amount too small to be real is asked", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا ميتين", "centime").issues.includes("amount_unit"));
});

test("unit: euros are euros", async () => {
  const { say } = await shop();
  const r = say("محمد دا خمسين أورو", "ask");
  assert.deepEqual([r.currency, r.amount, r.issues], ["EUR", 5000, []]);
});

// ---------------------------------------------------------------- debts

test("debt: they owe me, in several Darija forms", async () => {
  const { say, p } = await shop();
  for (const s of ["محمد دا خمسة آلاف دينار", "سجل على محمد خمسة آلاف دينار", "نسال محمد خمسة آلاف دينار", "محمد عليه خمسة آلاف دينار", "محمد تسلف مني خمسة آلاف دينار", "سلفت لمحمد خمسة آلاف دينار", "كريدي محمد خمسة آلاف دينار"]) {
    const r = say(s);
    assert.deepEqual([r.kind, r.direction, r.partyId, r.amount, r.issues], ["debt", "receivable", p.mohamed, DA(5000), []], s);
  }
});

test("debt: I owe them", async () => {
  const { say, p } = await shop();
  for (const s of ["سمير يسالني ثلاثة آلاف دينار", "سمير سلفني ثلاثة آلاف دينار", "تسلفت من سمير ثلاثة آلاف دينار", "خذيت من سمير ثلاثة آلاف دينار", "عليا لسمير ثلاثة آلاف دينار"]) {
    const r = say(s);
    assert.deepEqual([r.kind, r.direction, r.partyId, r.amount, r.issues], ["debt", "payable", p.samir, DA(3000), []], s);
  }
});

test("debt: French and English sentences", async () => {
  const { say, p } = await shop();
  const fr = say("Karim Benali me doit cinq mille dinars");
  assert.deepEqual([fr.kind, fr.direction, fr.partyId, fr.amount, fr.issues], ["debt", "receivable", p.karim, DA(5000), []]);
  const en = say("I owe Karim Benali 2000 dinars");
  assert.deepEqual([en.kind, en.direction, en.amount, en.issues], ["debt", "payable", DA(2000), []]);
});

test("debt: yesterday is understood; a weekday is asked", async () => {
  const { say } = await shop();
  assert.equal(say("البارح محمد دا ألفين دينار").date, "2026-11-21");
  assert.ok(say("محمد دا ألفين دينار نهار الخميس").issues.includes("date"));
});

// ---------------------------------------------------------------- repayments

test("repayment: they paid me", async () => {
  const { say, p } = await shop();
  for (const s of ["محمد خلصني ألفين دينار", "خلصني محمد ألفين دينار", "محمد خلص ألفين دينار", "محمد رجعلي ألفين دينار", "محمد سلكني ألفين دينار", "محمد خلص ألفين دينار من الكريدي"]) {
    const r = say(s);
    assert.deepEqual([r.kind, r.direction, r.partyId, r.amount, r.issues], ["payment", "receivable", p.mohamed, DA(2000), []], s);
  }
});

test("repayment: I paid them", async () => {
  const { say, p } = await shop();
  const r = say("خلصت عمي الطاهر عشرة آلاف دينار");
  assert.deepEqual([r.kind, r.direction, r.partyId, r.amount, r.issues], ["payment", "payable", p.grossiste, DA(10_000), []]);
});

test("repayment: 'خلصت' can be 'she paid' or 'I paid'; the open balance decides", async () => {
  const { say, p } = await shop();
  const r = say("فاطمة خلصت ألف دينار");
  assert.deepEqual([r.kind, r.direction, r.partyId, r.issues], ["payment", "receivable", p.fatima, []]);
});

test("repayment: the whole balance", async () => {
  const { say } = await shop();
  const r = say("محمد خلصني كلش");
  assert.deepEqual([r.kind, r.amount, r.issues], ["payment", DA(10_000), []]);
});

test("repayment: more than what is due, or nothing due, is never saved alone", async () => {
  const { say } = await shop();
  assert.ok(say("محمد خلصني عشرين ألف دينار").issues.includes("overpayment"));
  assert.ok(say("سمير خلصني ألف دينار").issues.includes("no_balance"));
});

test("repayment: words that contradict the balance are asked", async () => {
  const { say } = await shop();
  assert.ok(say("عمي الطاهر خلصني ألف دينار").issues.includes("no_balance"));
});

// ---------------------------------------------------------------- sentences that must not be saved

test("safety: a negation is never a repayment", async () => {
  const { say } = await shop();
  for (const s of ["محمد ما خلصش ألفين دينار", "محمد ماخلصنيش ألفين دينار", "محمد مازال ما خلص ألفين دينار", "Karim Benali n'a pas payé deux mille dinars", "Karim Benali has not paid 2000 dinars"]) assert.ok(say(s).issues.includes("negation"), s);
});

test("safety: a promise for later is never a repayment", async () => {
  const { say } = await shop();
  for (const s of ["محمد غدوة يخلصني ألفين دينار", "محمد راح يخلصني ألفين دينار", "Karim Benali va payer demain 2000 dinars"]) {
    const r = say(s);
    assert.ok(r.issues.length > 0, s);
    assert.ok(r.issues.includes("future"), s);
  }
});

test("safety: 'gave' does not say whether it is a loan or a repayment", async () => {
  const { say } = await shop();
  for (const s of ["عطيت لمحمد ألفين دينار", "محمد عطاني ألفين دينار"]) assert.ok(say(s).issues.includes("kind"), s);
});

test("safety: two amounts are asked; one with a currency next to a quantity is not", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا ألفين ولا ثلاثة آلاف").issues.includes("amount"));
  assert.equal(say("محمد دا 2 خبزات ب 100 دينار").amount, DA(100));
});

test("safety: no amount, no person, no verb", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا سلعة").issues.includes("amount"));
  assert.ok(say("دا خمسة آلاف دينار").issues.includes("party"));
  assert.ok(say("محمد خمسة آلاف دينار").issues.includes("kind"));
  assert.ok(say("").issues.includes("nothing"));
});

test("safety: when the phone hesitates between two amounts, it is asked", async () => {
  const { ctx } = await shop();
  const r = understand([{ text: "محمد دا خمسين ألف دينار" }, { text: "محمد دا خمسة آلاف دينار" }], ctx());
  assert.ok(r.issues.includes("amount_heard"));
  assert.deepEqual(r.amounts, [DA(50_000), DA(5000)]);
});

test("recognition: the alternative that makes sense wins", async () => {
  const { ctx, p } = await shop();
  const r = understand([{ text: "محمد ضا خمسة آلاف دينار" }, { text: "محمد دا خمسة آلاف دينار" }], ctx());
  assert.deepEqual([r.partyId, r.kind, r.issues], [p.mohamed, "debt", []]);
});

// ---------------------------------------------------------------- people

test("people: a name written in Latin letters is found from Arabic speech, but confirmed once", async () => {
  const { say, p } = await shop();
  const r = say("كريم بن علي دا ألفين دينار");
  assert.equal(r.partyId, p.karim);
  assert.deepEqual(r.issues, ["party_check"]);
  // After one confirmation the spoken form is remembered.
  const learned = say("كريم بن علي دا ألفين دينار", "dinar", { aliases: { [r.spokenKey]: p.karim } });
  assert.deepEqual([learned.partyId, learned.issues], [p.karim, []]);
});

test("people: a first name alone is confirmed once", async () => {
  const { say, p } = await shop();
  const r = say("كريم دا ألفين دينار");
  assert.deepEqual([r.partyId, r.issues], [p.karim, ["party_check"]]);
});

test("people: علي (a person) and على (on) are told apart", async () => {
  const { say, p } = await shop();
  assert.equal(say("علي دا ألفين دينار").partyId, p.ali);
  assert.equal(say("سجل على محمد ألفين دينار").partyId, p.mohamed);
});

test("people: an unknown name is proposed, never created alone", async () => {
  const { say } = await shop();
  const r = say("بلقاسم دا ألفين دينار");
  assert.deepEqual([r.partyId, r.spokenName, r.issues], [null, "بلقاسم", ["party_new"]]);
});

test("people: two people with the same sound are offered as choices", async () => {
  const h = await shop();
  await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Samira" });
  await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Samir Haddad" });
  const idx = await h.index(h.workspaceId);
  const r = understand([{ text: "samir a pris 2000 dinars" }], { ...h.ctx(), idx });
  assert.ok(r.issues.includes("party"));
  assert.ok(r.candidates.length >= 2);
});

test("people: sound keys match across scripts", () => {
  for (const [a, b] of [
    ["كريم", "Karim"],
    ["سميرة", "Samira"],
    ["محمد", "Mohamed"],
    ["محمد", "Mohammed"],
    ["خالد", "Khaled"],
    ["يوسف", "Youcef"],
    ["شريف", "Cherif"],
    ["وليد", "Oualid"],
    ["عبد القادر", "Abdelkader"],
    ["جمال", "Djamel"],
  ] as const)
    assert.equal(soundKey(a), soundKey(b), `${a} / ${b}`);
  assert.notEqual(soundKey("سمير"), soundKey("كريم"));
});

// ---------------------------------------------------------------- questions

test("question: 'how much does Mohamed owe' shows a balance and saves nothing", async () => {
  const { say, p } = await shop();
  for (const s of ["شحال نسال محمد", "شحال عليه محمد", "combien me doit محمد"]) {
    const r = say(s);
    assert.deepEqual([r.kind, r.partyId, r.issues], ["balance", p.mohamed, []], s);
  }
});

// ---------------------------------------------------------------- sentences that would save the wrong thing

test("adversarial: 'I paid Mohamed' is not 'Mohamed paid', even though he owes me", async () => {
  const { say, p } = await shop();
  assert.ok(say("خلصت محمد ألفين دينار").issues.includes("direction"));
  assert.ok(say("عمي الطاهر خلصت ألف دينار").issues.includes("direction"));
  const she = say("فاطمة خلصت ألف دينار");
  assert.deepEqual([she.direction, she.partyId, she.issues], ["receivable", p.fatima, []]);
});

test("adversarial: 'she lent' and 'she took' are not 'I lent' and 'I took'", async () => {
  const { say } = await shop();
  for (const s of ["فاطمة سلفت ألفين دينار", "فاطمة رفدت ألفين دينار", "تسلفت فاطمة ألفين دينار"]) assert.ok(say(s).issues.length > 0, s);
});

test("adversarial: corrections and deductions are never saved as a new debt", async () => {
  const { say } = await shop();
  for (const s of ["نقص على محمد ألف دينار", "نحي على محمد ألف دينار", "محمد نقص عليه ألف دينار", "مسحت كريدي محمد ألف دينار", "غلطت محمد دا ألف دينار", "annule Karim Benali me doit 1000 dinars", "محمد زاد عليه ألف دينار"])
    assert.ok(say(s).issues.includes("kind"), s);
});

test("adversarial: a cash purchase is not a debt", async () => {
  const { say } = await shop();
  for (const s of ["محمد دا ألفين دينار كاش", "Karim Benali a pris 2000 dinars cash"]) assert.ok(say(s).issues.includes("kind"), s);
});

test("adversarial: two operations in one sentence are asked", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا ألفين دينار وخلص ألف دينار").issues.length > 0);
  assert.ok(say("محمد دا ألفين دينار وسمير دا ألف دينار").issues.includes("party"));
});

test("adversarial: 'he pays / will pay' is not 'he paid'", async () => {
  const { say } = await shop();
  for (const s of ["محمد يخلصني ألفين دينار", "محمد دا ألفين دينار ويخلصها غدوة"]) assert.ok(say(s).issues.length > 0, s);
});

test("adversarial: other days are asked, not recorded as today", async () => {
  const { say } = await shop();
  for (const s of ["أول البارح محمد دا ألفين دينار", "avant hier Karim Benali a pris 2000 dinars", "محمد دا ألفين دينار نهار 15", "محمد دا ألفين دينار الشهر الماضي"]) assert.ok(say(s).issues.includes("date"), s);
});

test("adversarial: a phone number is not an amount, and a very large amount is confirmed", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا 0661234567").issues.includes("amount"));
  assert.ok(say("محمد دا ستين مليون دينار").issues.includes("amount_unit"));
});

test("adversarial: someone else's payment is not guessed", async () => {
  const { say } = await shop();
  assert.ok(say("محمد خلص سمير ألفين دينار").issues.includes("party"));
});

test("adversarial: a word that is not understood around the person or the verb is always asked", async () => {
  const { say } = await shop();
  for (const s of [
    "إذا محمد خلص ألفين دينار", // if
    "محمد يقول خلصني ألفين دينار", // he says
    "واش محمد خلصني ألفين دينار", // did he?
    "est-ce que محمد a payé 2000 dinars",
    "محمد ولدو دا ألفين دينار", // his son
    "خو محمد دا ألفين دينار", // his brother
    "دات مرت محمد ألفين دينار", // his wife
    "محمد كان دا ألفين دينار", // had taken
    "محمد الخباز دا ألفين دينار", // another Mohamed
    "دا محمد الخباز ألفين دينار",
    "محمد رجع سلعة بألفين دينار", // returned goods
    "محمد دفعلي ألفين دينار على خوه", // for his brother
  ])
    assert.ok(say(s).issues.includes("words"), s);
});

test("adversarial: goods named after the verb are fine", async () => {
  const { say } = await shop();
  for (const [s, n] of [
    ["محمد دا شكارة سميد بألفين وخمسمية دينار", 2500],
    ["محمد دا زوج شكاير سميد بخمسة آلاف دينار", 5000],
    ["دا محمد خبز وحليب بمية وخمسين دينار", 150],
  ] as const) {
    const r = say(s);
    assert.deepEqual([r.amount, r.issues], [DA(n), []], s);
  }
});

test("adversarial: a number after the amount is not dropped", async () => {
  const { say } = await shop();
  assert.ok(say("محمد دا ألفين دينار و خمسين").issues.includes("amount"));
});

// ---------------------------------------------------------------- answering the questions

test("answers: choosing the amount settles it, and the balance is checked again", async () => {
  const { say, ctx } = await shop();
  const r = say("محمد خلصني عشرين ألف", "ask");
  assert.ok(r.issues.includes("amount_unit"));
  const small = settle(r, { amount: DA(200) }, ctx("ask"));
  assert.deepEqual([small.amount, small.issues], [DA(200), []]);
  assert.deepEqual(settle(r, { amount: DA(20_000) }, ctx("ask")).issues, ["overpayment"]);
});

test("answers: choosing the person or confirming words clears only that doubt", async () => {
  const { say, ctx, p } = await shop();
  const r = settle(say("بلقاسم دا ألفين دينار"), { partyId: p.samir }, ctx());
  assert.deepEqual([r.partyId, r.issues], [p.samir, []]);
  const named = settle(say("بلقاسم دا ألفين دينار"), { newName: "بلقاسم" }, ctx());
  assert.deepEqual([named.partyId, named.spokenName, named.issues], [null, "بلقاسم", []]);
  const words = settle(say("محمد كان دا ألفين دينار"), { confirmed: true }, ctx());
  assert.deepEqual(words.issues, []);
});

test("answers: choosing what happened, then a repayment without balance is still refused", async () => {
  const { say, ctx, p } = await shop();
  const r = say("عطيت لمحمد ألفين دينار");
  assert.deepEqual(settle(r, { kind: "debt", direction: "receivable" }, ctx()).issues, []);
  assert.deepEqual(settle(r, { kind: "payment", direction: "payable" }, ctx()).issues, ["no_balance"]);
  const she = settle(say("خلصت محمد ألفين دينار"), { kind: "payment", direction: "receivable" }, ctx());
  assert.deepEqual([she.partyId, she.direction, she.issues], [p.mohamed, "receivable", []]);
});

test("answers: a negation or a promise cannot be confirmed into an entry", async () => {
  const { say, ctx } = await shop();
  const all = { kind: "payment", direction: "receivable", amount: DA(2000), confirmed: true } as const;
  assert.ok(settle(say("محمد ما خلصش ألفين دينار"), all, ctx()).issues.includes("negation"));
  assert.ok(settle(say("محمد راح يخلصني ألفين دينار"), all, ctx()).issues.includes("future"));
});

// ---------------------------------------------------------------- the microphone

function fakeSpeech() {
  const made: FakeSpeech[] = [];
  class FakeSpeech implements SpeechLike {
    lang = "";
    continuous = true;
    interimResults = false;
    maxAlternatives = 1;
    onresult: SpeechLike["onresult"] = null;
    onerror: SpeechLike["onerror"] = null;
    onend: SpeechLike["onend"] = null;
    started = false;
    aborted = false;
    constructor() {
      made.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
    abort() {
      this.aborted = true;
    }
    emit(...results: { final: boolean; alts: string[] }[]) {
      this.onresult?.({ results: results.map((r) => Object.assign(r.alts.map((transcript) => ({ transcript, confidence: 0.8 })), { isFinal: r.final })) });
    }
  }
  return { made, Speech: FakeSpeech };
}
function session() {
  const log = { partial: [] as string[], final: [] as string[][], errors: [] as string[], ended: 0 };
  const { made, Speech } = fakeSpeech();
  const stop = listen("ar-DZ", { onPartial: (t) => log.partial.push(t), onFinal: (a) => log.final.push(a.map((x) => x.text)), onError: (e) => log.errors.push(e), onEnd: () => log.ended++ }, Speech);
  return { log, speech: made[0], stop };
}

test("microphone: words appear while speaking and alternatives arrive at the end, once", () => {
  const { log, speech } = session();
  assert.deepEqual([speech.lang, speech.started, speech.maxAlternatives >= 3], ["ar-DZ", true, true]);
  speech.emit({ final: false, alts: ["محمد"] });
  speech.emit({ final: true, alts: ["محمد دا ألف", "محمد دا ألفين"] });
  speech.onend?.();
  speech.onend?.();
  assert.deepEqual(log.partial, ["محمد", "محمد دا ألف"]);
  assert.deepEqual(log.final, [["محمد دا ألف", "محمد دا ألفين"]]);
  assert.equal(log.ended, 1);
});

test("microphone: a sentence heard in two pieces stays one sentence", () => {
  const { log, speech } = session();
  speech.emit({ final: true, alts: ["محمد دا", "محمد ضا"] }, { final: true, alts: ["ألفين دينار"] });
  speech.onend?.();
  assert.deepEqual(log.final, [["محمد دا ألفين دينار", "محمد ضا ألفين دينار"]]);
});

test("microphone: refusals and silence are reported, and closing the sheet stops everything", () => {
  const a = session();
  a.speech.onerror?.({ error: "not-allowed" });
  a.speech.onend?.();
  assert.deepEqual([a.log.errors, a.log.final], [["denied"], []]);
  const b = session();
  b.speech.onend?.();
  assert.deepEqual(b.log.errors, ["silence"]);
  const c = session();
  c.stop();
  c.speech.emit({ final: true, alts: ["محمد دا ألفين"] });
  c.speech.onend?.();
  assert.deepEqual([c.speech.aborted, c.log.final, c.log.errors], [true, [], []]);
});
