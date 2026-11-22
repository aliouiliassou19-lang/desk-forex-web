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
