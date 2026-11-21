/* Desk Forex : regles de compte et de challenge prop firm (calculs purs, testes avec node --test).
 * AUCUNE regle de vraie prop firm n'est codee : toutes les limites sont saisies par l'utilisateur.
 * Une limite vide (null ou 0) est desactivee. Ce code ne passe aucun ordre.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./journal-core.js") : root.JournalCore, isNode ? require("./analysis.js") : root.Analysis,
    isNode ? require("./fmt.js") : root.Fmt);
  if (isNode) module.exports = api; else root.ChallengeCore = api;
})(typeof self !== "undefined" ? self : this, function (JC, A, F) {
  "use strict";
  const nb = (v, d) => F.num(v, d);                        // messages affiches : nombres au format francais
  const frDay = (k) => k.split("-").reverse().join("/");     // "2026-11-17" -> "17/11/2026"

  const ACCOUNT_TYPES = { demo: "Démo", challenge: "Challenge", funded: "Compte financé", live: "Réel personnel" };
  const EMPTY_RULES = {
    profitTargetPct: null,      // objectif de profit (%)
    dailyLossPct: null,         // perte journaliere max (%)
    dailyBase: "initial",       // "initial" : % du solde initial ; "dayStart" : % du solde en debut de journee
    maxDDPct: null,             // drawdown max (%)
    ddMode: "static",           // "static" ou "trailing" (suiveur)
    ddBasis: "balance",         // "balance" (solde) ou "equity" (equite)
    trailLock: false,           // le plancher suiveur s'arrete au solde initial
    minTradingDays: null, maxDays: null,
    consistencyPct: null,       // aucun jour ne doit depasser X % du profit total
    newsBan: false, newsWindowMin: 2,
    maxRiskPerTradePct: null,   // risque max par trade que je m'impose
    dayResetHourLocal: 0,       // heure de remise a zero journaliere (heure du Benin)
  };
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(+v) ? +v : null);
  const on = (v) => num(v) != null && num(v) > 0;

  function normalizeRules(r) {
    const o = Object.assign({}, EMPTY_RULES, r || {});
    ["profitTargetPct", "dailyLossPct", "maxDDPct", "minTradingDays", "maxDays", "consistencyPct", "maxRiskPerTradePct"].forEach((k) => {
      const v = num(o[k]); o[k] = v != null && v > 0 ? v : null;
    });
    o.dailyBase = o.dailyBase === "dayStart" ? "dayStart" : "initial";
    o.ddMode = o.ddMode === "trailing" ? "trailing" : "static";
    o.ddBasis = o.ddBasis === "equity" ? "equity" : "balance";
    o.trailLock = !!o.trailLock; o.newsBan = !!o.newsBan;
    o.newsWindowMin = Math.max(0, Math.min(120, num(o.newsWindowMin) != null ? num(o.newsWindowMin) : 2));
    o.dayResetHourLocal = Math.max(0, Math.min(23, Math.round(num(o.dayResetHourLocal) || 0)));
    return o;
  }
  /** Jour de trading (AAAA-MM-JJ) avec une remise a zero a resetHour (heure du Benin). */
  const dayKey = (ms, resetHour) => JC.localDay(ms - (resetHour || 0) * 3600000);
  /** Niveau d'une jauge selon la marge restante (0-1) : ok / warn / danger. */
  const level = (remainFrac) => (remainFrac == null ? "off" : remainFrac >= 0.5 ? "ok" : remainFrac >= 0.3 ? "warn" : "danger");

  /**
   * Evalue un compte. list = trades enrichis (JournalCore.enrich) de CE compte.
   * opts : {nowMs, news:[{timeMs,currency,event,impact}]}
   * account : {startBalance, startDate (ms), rules, equitySnapshots:[{t, equity, balance}]}
   */
  function evaluate(account, list, opts) {
    const r = normalizeRules(account.rules);
    const now = opts.nowMs, start = num(account.startBalance) || 0;
    const startDate = num(account.startDate) || null;
    const mine = list.filter((x) => !startDate || (x.t.entryTime || 0) >= startDate);
    const closed = mine.filter((x) => x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime).sort((a, b) => a.t.exitTime - b.t.exitTime);
    const violations = [], pending = [], alerts = [], notes = [];

    // ----- solde au fil du temps
    let bal = start, peak = start, ddBreach = null;
    const ddAmount = on(r.maxDDPct) ? start * r.maxDDPct / 100 : null;
    const floorAt = (pk) => {
      if (ddAmount == null) return null;
      if (r.ddMode === "static") return start - ddAmount;
      const f = pk - ddAmount;
      return r.trailLock ? Math.min(f, start) : f;
    };
    const days = {};
    closed.forEach((x) => {
      bal += x.m.net;
      const k = dayKey(x.t.exitTime, r.dayResetHourLocal);
      const d = (days[k] = days[k] || { net: 0, worst: 0, startBal: bal - x.m.net, n: 0 });
      d.net += x.m.net; d.n++; d.worst = Math.min(d.worst, d.net);
      const floor = floorAt(peak);
      if (floor != null && bal < floor - 1e-9 && !ddBreach) ddBreach = { t: x.t.exitTime, value: bal, floor };
      peak = Math.max(peak, bal);
    });
    const balance = bal;

    // ----- equite : derniere valeur saisie (ou MT5) si elle est plus recente que le dernier trade clos
    const snaps = (account.equitySnapshots || []).filter((s) => num(s.equity) != null && (!startDate || s.t >= startDate)).sort((a, b) => a.t - b.t);
    const lastSnap = snaps[snaps.length - 1];
    const lastClose = closed.length ? closed[closed.length - 1].t.exitTime : 0;
    const equity = lastSnap && lastSnap.t >= lastClose ? num(lastSnap.equity) : null;
    if (r.ddBasis === "equity") {
      snaps.forEach((s) => {
        const pk = Math.max(peak, ...snaps.filter((o) => o.t <= s.t).map((o) => num(o.equity)));
        const floor = floorAt(r.ddMode === "trailing" ? pk : peak);
        if (floor != null && num(s.equity) < floor - 1e-9 && !ddBreach) ddBreach = { t: s.t, value: num(s.equity), floor };
      });
      if (equity == null) notes.push("Équité inconnue (aucune valeur récente) : calculs faits sur le solde. Saisis l'équité actuelle ou importe-la depuis MT5.");
    }
    const peakAll = r.ddBasis === "equity" && snaps.length ? Math.max(peak, ...snaps.map((s) => num(s.equity))) : peak;
    const basisValue = r.ddBasis === "equity" && equity != null ? equity : balance;
    const floatPnl = equity != null ? equity - balance : 0;

    // ----- perte journaliere
    const todayKey = dayKey(now, r.dayResetHourLocal);
    const today = days[todayKey] || { net: 0, worst: 0, startBal: balance, n: 0 };
    const dailyLimitFor = (d) => (on(r.dailyLossPct) ? r.dailyLossPct / 100 * (r.dailyBase === "dayStart" ? d.startBal : start) : null);
    let daily = null;
    if (on(r.dailyLossPct)) {
      Object.entries(days).forEach(([k, d]) => {
        const lim = dailyLimitFor(d);
        if (d.worst <= -lim + 1e-9) violations.push({ rule: "Perte journalière maximale", detail: `${frDay(k)} : perte de ${nb(-d.worst, 2)} pour une limite de ${nb(lim, 2)}` });
      });
      const limit = dailyLimitFor(today);
      const pnlNow = today.net + (r.ddBasis === "equity" ? floatPnl : 0);
      const remain = limit + pnlNow;
      daily = { limit, todayPnl: pnlNow, remain, remainFrac: Math.max(0, Math.min(1, remain / limit)), level: level(Math.max(0, Math.min(1, remain / limit))) };
      if (remain <= 0 && !violations.some((v) => v.rule === "Perte journalière maximale")) violations.push({ rule: "Perte journalière maximale", detail: `aujourd'hui : ${nb(pnlNow, 2)} pour une limite de ${nb(limit, 2)}` });
      if (daily.remainFrac < 0.3 && remain > 0) alerts.push(`Perte journalière : il ne reste que ${nb(remain, 2)} (${Math.round(daily.remainFrac * 100)} % de la marge).`);
    }

    // ----- drawdown maximal
    let dd = null;
    if (ddAmount != null) {
      const floor = floorAt(r.ddMode === "trailing" ? peakAll : peak);
      const remain = basisValue - floor;
      const frac = Math.max(0, Math.min(1, remain / ddAmount));
      dd = { floor, remain, remainFrac: frac, level: level(frac), mode: r.ddMode, basis: r.ddBasis, peak: peakAll };
      if (ddBreach) violations.push({ rule: "Drawdown maximal", detail: `${JC.fmtLocal(ddBreach.t)} : ${nb(ddBreach.value, 2)} sous le plancher de ${nb(ddBreach.floor, 2)}` });
      else if (remain <= 0) violations.push({ rule: "Drawdown maximal", detail: `valeur actuelle ${nb(basisValue, 2)} sous le plancher de ${nb(floor, 2)}` });
      if (frac < 0.3 && remain > 0) alerts.push(`Drawdown : il ne reste que ${nb(remain, 2)} avant le plancher de ${nb(floor, 2)} (${Math.round(frac * 100)} % de la marge).`);
    }

    // ----- objectif, jours, duree, consistance
    const profit = balance - start;
    const target = on(r.profitTargetPct) ? start * r.profitTargetPct / 100 : null;
    const progress = target ? Math.max(0, profit / target) : null;
    const tradingDays = new Set(mine.filter((x) => (x.t.status === "OPEN" || x.t.status === "CLOSED") && x.t.entryTime)
      .map((x) => dayKey(x.t.entryTime, r.dayResetHourLocal))).size;
    const daysOk = !on(r.minTradingDays) || tradingDays >= r.minTradingDays;
    const firstDay = startDate || (mine.length ? Math.min(...mine.map((x) => x.t.entryTime || now)) : now);
    const daysElapsed = Math.floor((now - firstDay) / 86400000) + 1;
    const bestDay = Math.max(0, ...Object.values(days).map((d) => d.net));
    const consistencyRatio = profit > 0 ? bestDay / profit * 100 : null;
    const consistencyOk = !on(r.consistencyPct) || consistencyRatio == null || consistencyRatio <= r.consistencyPct + 1e-9;
    const targetReached = target != null && profit >= target - 1e-9;
    if (on(r.maxDays) && daysElapsed > r.maxDays && !(targetReached && daysOk && consistencyOk))
      violations.push({ rule: "Durée limite", detail: `${daysElapsed} jours écoulés pour une limite de ${r.maxDays}` });
    if (target != null && !targetReached) pending.push(`Objectif : ${nb(profit, 2)} sur ${nb(target, 2)} (${Math.round((progress || 0) * 100)} %)`);
    if (!daysOk) pending.push(`Jours de trading : ${tradingDays} sur ${r.minTradingDays} minimum`);
    if (!consistencyOk) pending.push(`Consistance : le meilleur jour fait ${nb(consistencyRatio, 0)} % du profit (maximum ${r.consistencyPct} %)`);

    // ----- annonces
    const newsTrades = [];
    if (r.newsBan) {
      const win = r.newsWindowMin * 60000;
      const high = (opts.news || []).filter((e) => e.impact === "high");
      mine.filter((x) => x.t.status === "OPEN" || x.t.status === "CLOSED").forEach((x) => {
        const [b, q] = x.t.symbol.split("/");
        const rel = new Set(x.t.symbol.startsWith("XA") ? ["USD"] : [b, q]);
        const hit = high.find((e) => rel.has(e.currency) && [x.t.entryTime, x.t.exitTime].some((t) => t && Math.abs(t - e.timeMs) <= win));
        if (hit) newsTrades.push({ id: x.t.id, symbol: x.t.symbol, event: `${hit.currency} ${hit.event}`, at: hit.timeMs });
      });
      newsTrades.forEach((n) => violations.push({ rule: "Trading pendant une annonce", detail: `${n.symbol} près de « ${n.event} » (${JC.fmtLocal(n.at)})` }));
    }

    // ----- risque par trade (regle personnelle)
    const overRisk = on(r.maxRiskPerTradePct) ? mine.filter((x) => x.m.riskPct != null && x.m.riskPct > r.maxRiskPerTradePct + 1e-9) : [];
    if (overRisk.length) notes.push(`Règle personnelle : ${overRisk.length} trade(s) au-delà de ${r.maxRiskPerTradePct} % de risque.`);

    const status = violations.length ? "RÈGLE VIOLÉE"
      : target != null && targetReached && daysOk && consistencyOk ? "OBJECTIF ATTEINT" : "EN COURS";
    return { rules: r, status, violations, pending, alerts, notes, balance, equity, basisValue, profit, target, progress,
      daily, dd, tradingDays, daysElapsed, consistencyRatio, consistencyOk, newsTrades, overRisk: overRisk.map((x) => x.t.id),
      closedCount: closed.length };
  }

  /**
   * Lot maximum pour un trade : la perte au stop (spread compris) ne doit depasser aucune des marges.
   * limits : [{name, amount}] (montants restants, en devise du compte = USD ici)
   */
  function maxLot(i) {
    const stop = num(i.stopPips), spread = num(i.spreadPips) || 0, pv = num(i.pipValue);
    const step = num(i.lotStep) || 0.01, minLot = num(i.minLot) || 0.01;
    const lim = (i.limits || []).filter((l) => num(l.amount) != null);
    if (!(stop > 0) || !(pv > 0)) return { error: "stop (pips) et valeur du pip requis" };
    if (!lim.length) return { error: "aucune limite définie pour ce compte" };
    const binding = lim.reduce((a, b) => (num(b.amount) < num(a.amount) ? b : a));
    const perLot = (stop + spread) * pv;
    if (!(binding.amount > 0)) return { lots: 0, allowed: false, binding, perLot, reason: `plus de marge sur « ${binding.name} »` };
    const lots = Math.floor(binding.amount / perLot / step + 1e-9) * step;
    if (lots < minLot - 1e-12) return { lots: 0, allowed: false, binding, perLot, reason: `même ${minLot} lot dépasserait « ${binding.name} »` };
    return { lots: Math.round(lots * 100) / 100, allowed: true, binding, perLot, risk: Math.round(lots * perLot * 100) / 100 };
  }

  return { ACCOUNT_TYPES, EMPTY_RULES, normalizeRules, dayKey, level, evaluate, maxLot };
});
