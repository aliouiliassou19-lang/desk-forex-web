/* Desk Forex : outils d'aide au trading (calculs purs, testes avec node --test).
 * LECTURE SEULE : aucun ordre n'est passe. Ces calculs aident a preparer un trade que tu executes toi-meme.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./rules.js") : root.Rules, isNode ? require("./fmt.js") : root.Fmt,
    isNode ? require("./journal-core.js") : root.JournalCore, isNode ? require("./dashboard-core.js") : root.DashboardCore,
    isNode ? require("./analysis.js") : root.Analysis);
  if (isNode) module.exports = api; else root.DisciplineCore = api;
})(typeof self !== "undefined" ? self : this, function (R, F, JC, DB, A) {
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

  // ------------------------------------------------------------------ briefing du jour
  const BRIEF_PAIRS = ["XAU/USD", "EUR/USD"];
  const pairCcys = (pair) => (pair.startsWith("XA") ? ["USD"] : pair.split("/"));
  /** Annonces fortes du jour (heure du Benin) qui concernent la paire. */
  function newsToday(pair, news, nowMs) {
    const day = JC.localDay(nowMs), ccy = new Set(pairCcys(pair));
    return (news || []).filter((e) => e && e.impact === "high" && ccy.has(e.currency) && Number.isFinite(e.timeMs) && JC.localDay(e.timeMs) === day)
      .sort((a, b) => a.timeMs - b.timeMs);
  }
  /**
   * Briefing en 3 lignes : tendance (H4 et H1), niveaux cles (support et resistance les plus proches), annonces du jour.
   * tech = Analysis.technical(...) ou null (pas de cle) ; aucune prediction de direction.
   */
  function briefLines(pair, tech, news, nowMs) {
    const out = { pair, trend: null, trendDir: null, levels: null, news: null };
    const today = newsToday(pair, news, nowMs);
    out.news = today.length
      ? "Annonces fortes aujourd'hui : " + today.map((e) => `${F.benin(e.timeMs)} ${e.currency} ${e.event}`).join(" · ") + " (pas de nouvelle position 15 min avant et après)."
      : "Annonces : aucune annonce forte enregistrée aujourd'hui pour cette paire (vérifie le calendrier dans Analyse → Annonces).";
    out.newsCount = today.length;
    if (!tech || tech.error) return out;
    const tf = (k) => (tech.tfs || []).find((t) => t.tf === k);
    const h4 = tf("H4"), h1 = tf("H1");
    const t4 = h4 ? h4.trend : null, t1 = h1 ? h1.trend : null;
    if (t4 && t1 && t4 === t1) { out.trend = `Tendance : ${t4} en H4 et en H1.`; out.trendDir = t4 === "haussière" ? "up" : t4 === "baissière" ? "down" : "flat"; }
    else if (t4 || t1) { out.trend = `Tendance : mixte (H4 ${t4 || "inconnue"}, H1 ${t1 || "inconnue"}) : prudence, pas de direction claire.`; out.trendDir = "mixed"; }
    else out.trend = "Tendance : historique insuffisant.";
    const dec = tech.dec, pip = tech.pip, price = tech.price;
    const lv = (l) => `${F.num(l.price, dec)} (${l.label}, à ${F.num(Math.abs(l.price - price) / pip, 0)} pips)`;
    const r1 = (tech.resistances || [])[0], s1 = (tech.supports || [])[0];
    out.levels = "Niveaux clés : " + [r1 ? "résistance " + lv(r1) : null, s1 ? "support " + lv(s1) : null].filter(Boolean).join(" · ") + ` · prix ${F.num(price, dec)}.`;
    if (!r1 && !s1) out.levels = "Niveaux clés : aucun niveau proche détecté.";
    return out;
  }

  /** Durée lisible : « 2 h 15 min », « 45 min », « 1 j 20 h ». */
  function fmtDuration(ms) {
    const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mn = m % 60;
    if (d) return `${d} j ${h} h`;
    if (h) return `${h} h ${String(mn).padStart(2, "0")} min`;
    return `${mn} min`;
  }
  const isOpen = (name, ms) => { const s = A.sessionsAt(ms).sessions.find((x) => x.name === name); return !!(s && s.open); };
  /** Prochain changement d'etat d'une session (ouverture ou fermeture), dans un sens donne, a la minute pres. */
  function nextChange(name, fromMs, dir) {
    const step = 5 * 60000, start = isOpen(name, fromMs);
    let t = fromMs;
    for (let i = 0; i < 8 * 288; i++) {
      const n = t + dir * step;
      if (isOpen(name, n) !== start) {
        let a = t, b = n;                                  // affine a la minute
        while (Math.abs(b - a) > 60000) { const mid = a + Math.round((b - a) / 2 / 60000) * 60000; if (isOpen(name, mid) === start) a = mid; else b = mid; }
        return dir > 0 ? b : a;                           // en avant : 1re minute du nouvel etat ; en arriere : 1re minute de l'etat actuel
      }
      t = n;
    }
    return null;
  }
  /**
   * Sessions de Londres et New York : ouverte ou fermee, prochaine ouverture / fermeture (heure du Benin) et compte a rebours.
   * L'heure d'ete est geree par les fuseaux de Londres et New York.
   */
  function sessionClock(nowMs) {
    const now = nowMs - (nowMs % 60000);
    return ["Londres", "New York"].map((name) => {
      const open = isOpen(name, now);
      const change = nextChange(name, now, 1);
      let opensAt, closesAt;
      if (open) { closesAt = change; opensAt = nextChange(name, now, -1); }
      else { opensAt = change; closesAt = change != null ? nextChange(name, change, 1) : null; }
      return { name, open, opensAt, closesAt, nextAt: change, inMs: change != null ? change - nowMs : null,
        label: change == null ? "horaire inconnu" : `${open ? "ferme" : "ouvre"} dans ${fmtDuration(change - nowMs)}`,
        hours: opensAt != null && closesAt != null ? `${F.benin(opensAt)} – ${F.benin(closesAt)}` : null };
    });
  }

  return { LOT_SYMBOLS, lotCalc, DISC_DEFAULTS, normalizeDisc, checklistItems, checklistDone, dayStatus,
    BRIEF_PAIRS, newsToday, briefLines, fmtDuration, sessionClock };
});
