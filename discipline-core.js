/* Desk Forex : outils d'aide au trading (calculs purs, testes avec node --test).
 * LECTURE SEULE : aucun ordre n'est passe. Ces calculs aident a preparer un trade que tu executes toi-meme.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./rules.js") : root.Rules, isNode ? require("./fmt.js") : root.Fmt,
    isNode ? require("./journal-core.js") : root.JournalCore, isNode ? require("./dashboard-core.js") : root.DashboardCore);
  if (isNode) module.exports = api; else root.DisciplineCore = api;
})(typeof self !== "undefined" ? self : this, function (R, F, JC, DB) {
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

  // ------------------------------------------------------------------ assistant de discipline
  /** Regles personnelles (reglables) : perte max du jour en % du solde du debut de journee, pertes d'affilee, risque par trade. */
  const DISC_DEFAULTS = { dailyLossPct: 2, maxConsecLosses: 2, riskPct: 1 };
  function normalizeDisc(r) {
    const o = Object.assign({}, DISC_DEFAULTS, r || {});
    const clamp = (v, lo, hi, d) => { const n = num(v); return n == null || !(n > 0) ? d : Math.min(hi, Math.max(lo, n)); };
    return {
      dailyLossPct: r2(clamp(o.dailyLossPct, 0.1, 20, DISC_DEFAULTS.dailyLossPct)),
      maxConsecLosses: Math.round(clamp(o.maxConsecLosses, 1, 10, DISC_DEFAULTS.maxConsecLosses)),
      riskPct: r2(clamp(o.riskPct, 0.1, 10, DISC_DEFAULTS.riskPct)),
    };
  }
  /** Les 5 points de la checklist obligatoire (le dernier suit le risque regle). */
  function checklistItems(rules) {
    const r = normalizeDisc(rules);
    return ["Tendance H1/H4 confirmée", "Liquidité prise", "RR ≥ 2", "Pas d'annonce forte dans les 15 min", `Risque ≤ ${F.num(r.riskPct, r.riskPct % 1 ? 1 : 0)} %`];
  }
  /** Tout est coche ? checked : {libelle: bool} */
  const checklistDone = (checked, items) => items.length > 0 && items.every((it) => !!(checked && checked[it]));

  /**
   * Etat du jour (heure du Benin) pour un compte, a partir des trades CLOTURES aujourd'hui :
   * blocage si la perte du jour atteint la limite, ou apres N pertes d'affilee aujourd'hui.
   */
  function dayStatus(account, list, nowMs, rules) {
    const r = normalizeDisc(rules);
    const dayStart = DB.periodStarts(nowMs).day, dayEnd = dayStart + 86400000;
    const today = list.filter((x) => x.t.accountId === account.id && x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime >= dayStart && x.t.exitTime < Math.min(dayEnd, nowMs + 1))
      .sort((a, b) => a.t.exitTime - b.t.exitTime);
    const netToday = r2(today.reduce((s, x) => s + x.m.net, 0));
    const startBalance = DB.summary(account, list, dayStart - 1).balance;
    const lossLimit = r2(Math.max(0, startBalance) * r.dailyLossPct / 100);
    let consec = 0;
    for (let i = today.length - 1; i >= 0 && today[i].m.net < 0; i--) consec++;
    const lossHit = lossLimit > 0 && netToday <= -lossLimit + 1e-9;
    const streakHit = consec >= r.maxConsecLosses;
    const reason = lossHit ? "loss" : streakHit ? "streak" : null;
    const message = !reason ? "Tu peux trader : tes règles du jour sont respectées."
      : "Stop pour aujourd'hui, reviens demain. " + (lossHit
        ? `Perte du jour ${F.money(netToday)} : ta limite de ${F.pct(r.dailyLossPct, r.dailyLossPct % 1 ? 1 : 0)} (${F.money(-lossLimit)}) est atteinte.`
        : `${consec} pertes d'affilée aujourd'hui : ta limite est de ${r.maxConsecLosses}.`);
    return {
      locked: !!reason, reason, message, rules: r, tradesToday: today.length, netToday, startBalance: r2(startBalance), lossLimit,
      remaining: r2(lossLimit + netToday), consecLosses: consec, unlockAt: dayEnd,
    };
  }

  return { LOT_SYMBOLS, lotCalc, DISC_DEFAULTS, normalizeDisc, checklistItems, checklistDone, dayStatus };
});
