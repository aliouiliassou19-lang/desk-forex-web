// Tests des outils d'aide au trading (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const DC = require("../discipline-core.js");

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
