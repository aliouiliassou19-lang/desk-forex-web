// Tests des outils d'aide au trading (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const DC = require("../discipline-core.js");
const JC = require("../journal-core.js");
const T = (s) => Date.parse(s);

test("calculateur de lot : arrondi vers le bas, montant risque et objectif RR 2", () => {
  // EUR/USD : 1 000 $, 1 %, stop 20 pips, 10 $ par pip et par lot -> 10 $ / (20 x 10) = 0,05 lot
  let r = DC.lotCalc({ balance: 1000, riskPct: 1, stopPips: 20, pipValuePerLot: 10 });
  assert.equal(r.ok, true); assert.equal(r.lots, 0.05); assert.equal(r.riskUsd, 10); assert.equal(r.maxRiskUsd, 10);
  assert.equal(r.targetPips, 40); assert.equal(r.targetUsd, 20); assert.equal(r.rr, 2);
  // arrondi vers le bas : 10 977,31 $, 1 %, stop 25 pips -> 0,439 -> 0,43 lot (risque 107,50 $ <= 109,77 $)
  r = DC.lotCalc({ balance: 10977.31, riskPct: 1, stopPips: 25, pipValuePerLot: 10 });
  assert.equal(r.lots, 0.43); assert.equal(r.riskUsd, 107.5); assert.equal(r.maxRiskUsd, 109.77);
  assert.ok(r.riskUsd <= r.maxRiskUsd);
  assert.equal(r.targetPips, 50); assert.equal(r.targetUsd, 215);
  // or : 1 pip = 0,10 $ de prix, 10 $ par pip et par lot ; stop de 30 pips (3 $)
  r = DC.lotCalc({ balance: 5000, riskPct: 0.5, stopPips: 30, pipValuePerLot: 10 });
  assert.equal(r.lots, 0.08); assert.equal(r.riskUsd, 24);
  // RR personnalise
  assert.equal(DC.lotCalc({ balance: 1000, riskPct: 1, stopPips: 20, pipValuePerLot: 10, rr: 3 }).targetPips, 60);
});

test("calculateur de lot : refus clairs", () => {
  // petit compte : meme 0,01 lot depasse le risque
  let r = DC.lotCalc({ balance: 68, riskPct: 1, stopPips: 30, pipValuePerLot: 10 });
  assert.equal(r.ok, false); assert.equal(r.reason, "MIN_LOT_EXCEEDS_RISK_LIMIT");
  assert.equal(r.minLotRiskUsd, 3); assert.match(r.message, /Même 0,01 lot risque 3,00\s\$ \(4,41\s%/);
  // donnees manquantes ou invalides
  for (const bad of [{}, { balance: 1000, riskPct: 1 }, { balance: -5, riskPct: 1, stopPips: 10 }, { balance: 1000, riskPct: 0, stopPips: 10 }, { balance: "abc", riskPct: 1, stopPips: 10 }]) {
    assert.equal(DC.lotCalc(bad).reason, "INVALID_INPUT");
  }
  assert.equal(DC.lotCalc({ balance: 1000, riskPct: 15, stopPips: 10 }).reason, "RISK_TOO_HIGH");
  assert.deepEqual(DC.LOT_SYMBOLS, { XAUUSD: "XAU/USD", EURUSD: "EUR/USD" });
});

test("regles et checklist de discipline", () => {
  assert.deepEqual(DC.normalizeDisc({}), { dailyLossPct: 2, maxConsecLosses: 2, riskPct: 1 });
  assert.deepEqual(DC.normalizeDisc({ dailyLossPct: "3.5", maxConsecLosses: 3.4, riskPct: 0.5 }), { dailyLossPct: 3.5, maxConsecLosses: 3, riskPct: 0.5 });
  assert.deepEqual(DC.normalizeDisc({ dailyLossPct: -1, maxConsecLosses: 0, riskPct: 99 }), { dailyLossPct: 2, maxConsecLosses: 2, riskPct: 10 });
  const items = DC.checklistItems({ riskPct: 1 });
  assert.equal(items.length, 5); assert.equal(items[4], "Risque ≤ 1 %");
  assert.equal(DC.checklistItems({ riskPct: 0.5 })[4], "Risque ≤ 0,5 %");
  const all = Object.fromEntries(items.map((i) => [i, true]));
  assert.equal(DC.checklistDone(all, items), true);
  assert.equal(DC.checklistDone(Object.assign({}, all, { "Liquidité prise": false }), items), false);
  assert.equal(DC.checklistDone({}, items), false);
});

test("etat du jour : perte max du jour et pertes d'affilee (heure du Benin)", () => {
  const acc = { id: "a", startBalance: 1000 };
  const tr = (id, iso, net) => ({ id, accountId: "a", status: "CLOSED", symbol: "EUR/USD", side: "buy", lots: 0.1, entry: 1.09, sl: 1.089, exit: 1.091,
    grossOverride: net, entryTime: T(iso) - 600000, exitTime: T(iso) });
  const now = T("2026-11-20T15:00:00Z");                       // vendredi 16:00 au Benin
  const L = (arr) => JC.enrich(arr.map((a) => tr(...a)), [acc], 2);
  // hier : +100 (solde de depart du jour = 1 100 $, limite 2 % = 22 $)
  let s = DC.dayStatus(acc, L([["y", "2026-11-19T10:00:00Z", 100], ["t1", "2026-11-20T09:00:00Z", -10]]), now, {});
  assert.equal(s.locked, false); assert.equal(s.startBalance, 1100); assert.equal(s.lossLimit, 22);
  assert.equal(s.netToday, -10); assert.equal(s.remaining, 12); assert.equal(s.consecLosses, 1); assert.equal(s.tradesToday, 1);
  // 2 pertes d'affilee -> blocage
  s = DC.dayStatus(acc, L([["y", "2026-11-19T10:00:00Z", 100], ["t1", "2026-11-20T09:00:00Z", -5], ["t2", "2026-11-20T10:00:00Z", -5]]), now, {});
  assert.equal(s.locked, true); assert.equal(s.reason, "streak"); assert.match(s.message, /^Stop pour aujourd'hui, reviens demain\. 2 pertes d'affilée/);
  // un gain entre les pertes remet la serie a zero
  s = DC.dayStatus(acc, L([["t1", "2026-11-20T09:00:00Z", -5], ["t2", "2026-11-20T10:00:00Z", 8], ["t3", "2026-11-20T11:00:00Z", -5]]), now, {});
  assert.equal(s.locked, false); assert.equal(s.consecLosses, 1);
  // perte du jour >= 2 % -> blocage meme sans serie
  s = DC.dayStatus(acc, L([["t1", "2026-11-20T09:00:00Z", -25]]), now, {});
  assert.equal(s.locked, true); assert.equal(s.reason, "loss"); assert.match(s.message, /limite de 2\s% \(−20,00\s\$\) est atteinte/);
  // regles reglees : 3 pertes autorisees, 5 % de perte max
  s = DC.dayStatus(acc, L([["t1", "2026-11-20T09:00:00Z", -5], ["t2", "2026-11-20T10:00:00Z", -5]]), now, { maxConsecLosses: 3, dailyLossPct: 5 });
  assert.equal(s.locked, false);
  // les trades d'hier et d'un autre compte ne comptent pas ; 23:30 UTC le 19 = 00:30 le 20 au Benin (compte aujourd'hui)
  s = DC.dayStatus(acc, L([["y1", "2026-11-19T20:00:00Z", -50], ["y2", "2026-11-19T21:00:00Z", -50], ["m", "2026-11-19T23:30:00Z", -4]]), now, {});
  assert.equal(s.tradesToday, 1); assert.equal(s.consecLosses, 1); assert.equal(s.locked, false);
  // demain, tout repart a zero
  assert.equal(DC.dayStatus(acc, L([["t1", "2026-11-20T09:00:00Z", -25]]), T("2026-11-21T08:00:00Z"), {}).locked, false);
  assert.equal(s.unlockAt, T("2026-11-20T23:00:00Z"));       // minuit au Benin
});

test("briefing du jour : 3 lignes (tendance, niveaux, annonces)", () => {
  const now = T("2026-11-20T09:00:00Z");                     // 10:00 au Benin
  const news = [
    { timeMs: T("2026-11-20T13:30:00Z"), currency: "USD", event: "CPI", impact: "high" },
    { timeMs: T("2026-11-20T09:30:00Z"), currency: "EUR", event: "PMI", impact: "high" },
    { timeMs: T("2026-11-20T15:00:00Z"), currency: "USD", event: "Discours", impact: "medium" },   // pas forte
    { timeMs: T("2026-11-21T13:30:00Z"), currency: "USD", event: "Demain", impact: "high" },       // pas aujourd'hui
    { timeMs: T("2026-11-20T08:00:00Z"), currency: "GBP", event: "BoE", impact: "high" },          // autre devise
  ];
  const tech = { price: 2650.4, dec: 2, pip: 0.1, tfs: [{ tf: "D1", trend: "haussière" }, { tf: "H4", trend: "haussière" }, { tf: "H1", trend: "haussière" }],
    resistances: [{ price: 2662.4, label: "Sommet H4 19/11" }], supports: [{ price: 2641.9, label: "Pivot S1" }] };
  let b = DC.briefLines("XAU/USD", tech, news, now);
  assert.equal(b.trend, "Tendance : haussière en H4 et en H1."); assert.equal(b.trendDir, "up");
  assert.match(b.levels, /^Niveaux clés : résistance 2\s662,40 \(Sommet H4 19\/11, à 120 pips\) · support 2\s641,90 \(Pivot S1, à 85 pips\) · prix 2\s650,40\.$/);
  assert.equal(b.newsCount, 1);                              // l'or : seulement le dollar
  assert.match(b.news, /14:30 USD CPI/);
  b = DC.briefLines("EUR/USD", Object.assign({}, tech, { tfs: [{ tf: "H4", trend: "baissière" }, { tf: "H1", trend: "haussière" }] }), news, now);
  assert.equal(b.trendDir, "mixed"); assert.match(b.trend, /mixte \(H4 baissière, H1 haussière\)/);
  assert.equal(b.newsCount, 2); assert.match(b.news, /10:30 EUR PMI · 14:30 USD CPI/);
  // sans cle (pas d'analyse) : seulement les annonces
  b = DC.briefLines("EUR/USD", null, [], now);
  assert.equal(b.trend, null); assert.equal(b.levels, null); assert.match(b.news, /aucune annonce forte/);
});

test("sessions de Londres et New York : heures du Benin et compte a rebours", () => {
  // vendredi 20/11, 15:00 UTC (16:00 au Benin) : Londres ouverte jusqu'a 17:00 UTC (18:00 Benin), New York jusqu'a 22:00 UTC
  let c = DC.sessionClock(T("2026-11-20T15:00:00Z"));
  const lon = c.find((s) => s.name === "Londres"), ny = c.find((s) => s.name === "New York");
  assert.equal(lon.open, true); assert.equal(lon.closesAt, T("2026-11-20T17:00:00Z")); assert.equal(lon.label, "ferme dans 2 h 00 min");
  assert.equal(lon.hours, "09:00 – 18:00");
  assert.equal(ny.open, true); assert.equal(ny.closesAt, T("2026-11-20T22:00:00Z")); assert.equal(ny.hours, "14:00 – 23:00");
  // samedi : Londres rouvre lundi 08:00 (heure d'hiver) = 09:00 au Benin
  c = DC.sessionClock(T("2026-11-21T12:00:00Z"));
  const lon2 = c.find((s) => s.name === "Londres");
  assert.equal(lon2.open, false); assert.equal(lon2.opensAt, T("2026-11-23T08:00:00Z")); assert.equal(lon2.label, "ouvre dans 1 j 20 h");
  // ete (heure d'ete a Londres et New York) : Londres ouvre a 07:00 UTC = 08:00 au Benin
  c = DC.sessionClock(T("2026-07-15T05:30:00Z"));
  const lon3 = c.find((s) => s.name === "Londres"), ny3 = c.find((s) => s.name === "New York");
  assert.equal(lon3.open, false); assert.equal(lon3.opensAt, T("2026-07-15T07:00:00Z")); assert.equal(lon3.label, "ouvre dans 1 h 30 min");
  assert.equal(ny3.opensAt, T("2026-07-15T12:00:00Z"));
  assert.equal(DC.fmtDuration(45 * 60000), "45 min"); assert.equal(DC.fmtDuration(0), "0 min");
});

test("analyse de mes erreurs : 10 trades minimum, constats simples", () => {
  const acc = { id: "e", startBalance: 1000 };
  // entree en heure UTC : 09:00 UTC = Londres (hiver) ; 15:00 UTC = chevauchement ; 01:00 UTC = Asie
  const tr = (id, entryIso, net, extra) => Object.assign({ id, accountId: "e", status: "CLOSED", symbol: "EUR/USD", side: "buy", lots: 0.1, entry: 1.09, sl: 1.089, exit: 1.091,
    grossOverride: net, entryTime: T(entryIso), exitTime: T(entryIso) + 1800000, checklist: {} }, extra || {});
  const ok = { checklist: { a: true } }, ko = { checklist: { a: false } };
  const base = [
    // vendredis perdants (20/11, 13/11, 06/11), en Asie, sans checklist complete
    tr("f1", "2026-11-20T01:00:00Z", -40, ko), tr("f2", "2026-11-13T01:00:00Z", -35, ko), tr("f3", "2026-11-06T01:00:00Z", -30, ko),
    // mardis gagnants a Londres avec checklist
    tr("m1", "2026-11-17T09:00:00Z", 50, ok), tr("m2", "2026-11-10T09:00:00Z", 45, ok), tr("m3", "2026-11-03T09:00:00Z", 40, ok),
    // mercredis mitiges
    tr("w1", "2026-11-18T15:00:00Z", 10, ok), tr("w2", "2026-11-11T15:00:00Z", -5, ko), tr("w3", "2026-11-04T15:00:00Z", 5, ok),
  ];
  const L = (arr) => JC.enrich(arr, [acc], 2);
  let r = DC.insights(acc, L(base));
  assert.equal(r.enough, false); assert.equal(r.n, 9); assert.equal(r.needed, 10);
  r = DC.insights(acc, L(base.concat([tr("t1", "2026-11-19T09:00:00Z", 20, ok)]))); // jeudi, Londres
  assert.equal(r.enough, true); assert.equal(r.n, 10);
  const texts = r.items.map((i) => i.text);
  assert.ok(texts.includes("Tu perds surtout le vendredi."), texts.join(" / "));
  assert.ok(texts.includes("Ta meilleure session est Londres."), texts.join(" / "));
  assert.ok(texts.includes("Tes trades sans checklist perdent plus."), texts.join(" / "));
  assert.ok(texts.includes("Tu perds pendant la session asiatique."), texts.join(" / "));
  assert.ok(texts.includes("Ton meilleur jour est le mardi."), texts.join(" / "));
  assert.equal(r.items[0].tone, "bad");                     // les points a corriger d'abord
  const fri = r.items.find((i) => i.text === "Tu perds surtout le vendredi.");
  assert.match(fri.detail, /−105,00\s\$ sur 3 trades, 0\s% de réussite/);
  // un autre compte n'est pas compte ; un symbole perdant ressort
  const more = base.concat([tr("x1", "2026-11-19T09:00:00Z", -20, Object.assign({ symbol: "XAU/USD" }, ok)), tr("x2", "2026-11-12T09:00:00Z", -25, Object.assign({ symbol: "XAU/USD" }, ok)),
    tr("x3", "2026-11-05T09:00:00Z", -30, Object.assign({ symbol: "XAU/USD" }, ok)), tr("other", "2026-11-19T09:00:00Z", 999, { accountId: "z" })]);
  r = DC.insights(acc, JC.enrich(more, [acc, { id: "z", startBalance: 0 }], 2));
  assert.equal(r.n, 12);
  assert.ok(r.items.some((i) => i.text === "Tu perds surtout sur XAU/USD."));
});
