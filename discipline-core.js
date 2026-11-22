/* Desk Forex : outils d'aide au trading (calculs purs, testes avec node --test).
 * LECTURE SEULE : aucun ordre n'est passe. Ces calculs aident a preparer un trade que tu executes toi-meme.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./rules.js") : root.Rules, isNode ? require("./fmt.js") : root.Fmt);
  if (isNode) module.exports = api; else root.DisciplineCore = api;
})(typeof self !== "undefined" ? self : this, function (R, F) {
  "use strict";
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(+v) ? +v : null);
  const r2 = (x) => Math.round(x * 100) / 100;

  // ------------------------------------------------------------------ calculateur de lot
  /** Symboles du calculateur : nom affiche -> symbole du site. La valeur du pip vient des reglages du site. */
  const LOT_SYMBOLS = { XAUUSD: "XAU/USD", EURUSD: "EUR/USD" };
  /**
   * Lot pour un risque donne. i : {balance, riskPct, stopPips, pipValuePerLot, rr (2 par defaut)}
   * Le lot est arrondi vers le bas (pas de 0,01 lot) : le risque reel ne depasse jamais le risque choisi.
   */
  function lotCalc(i) {
    const balance = num(i.balance), riskPct = num(i.riskPct), stop = num(i.stopPips), pv = num(i.pipValuePerLot) || 10;
    const rr = num(i.rr) || 2;
    if (!(balance > 0) || !(riskPct > 0) || !(stop > 0)) {
      return { ok: false, reason: "INVALID_INPUT", message: "Indique ton solde, ton risque en % et ton stop en pips." };
    }
    if (riskPct > 10) return { ok: false, reason: "RISK_TOO_HIGH", message: "Risque supérieur à 10 % du solde : ce n'est pas raisonnable, même en démo." };
    const maxRiskUsd = r2(balance * riskPct / 100);
    const p = R.positionSize(balance, riskPct, stop, pv, 0.01, 0.01);
    if (!p.allowed) {
      return { ok: false, reason: p.reason, maxRiskUsd, minLotRiskUsd: p.riskUsd, minLotRiskPct: p.riskPct,
        message: `Même 0,01 lot risque ${F.money(p.riskUsd)} (${F.pct(p.riskPct)} du solde), plus que ton risque de ${F.money(maxRiskUsd)}. Réduis ton stop ou ne prends pas ce trade.` };
    }
    return {
      ok: true, lots: p.lots, riskUsd: p.riskUsd, riskPct: p.riskPct, maxRiskUsd, stopPips: stop, pipValuePerLot: pv,
      rr, targetPips: r2(stop * rr), targetUsd: r2(p.riskUsd * rr),
    };
  }

  return { LOT_SYMBOLS, lotCalc };
});
