/* Desk Forex : calculs du Dashboard (purs, sans DOM ni reseau, testes avec node --test).
 * Reutilise les trades du journal (journal-core.js) : il n'y a qu'un seul journal.
 * Regle : un depot ou un retrait change le SOLDE, mais n'est jamais un gain ou une perte
 * (il n'entre ni dans le P&L, ni dans les statistiques, ni dans le drawdown).
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./journal-core.js") : root.JournalCore, isNode ? require("./challenge-core.js") : root.ChallengeCore);
  if (isNode) module.exports = api; else root.DashboardCore = api;
})(typeof self !== "undefined" ? self : this, function (JC, CC) {
  "use strict";

  const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(+v) ? +v : null);

  /** Mouvement d'argent nettoye : {id, t, type: "deposit"|"withdrawal", amount > 0, note} ou null. */
  function sanitizeCashflow(o) {
    if (!o || typeof o !== "object") return null;
    const amount = num(o.amount), t = num(o.t);
    if (!(amount > 0) || !(t > 0)) return null;
    return { id: String(o.id || "cf" + t.toString(36)).slice(0, 60), t, type: o.type === "withdrawal" ? "withdrawal" : "deposit",
      amount: Math.round(amount * 100) / 100, note: String(o.note || "").slice(0, 120) };
  }
  const signed = (f) => (f.type === "withdrawal" ? -f.amount : f.amount);
  const flowsOf = (account) => (account.cashflows || []).map(sanitizeCashflow).filter(Boolean).sort((a, b) => a.t - b.t);

  /**
   * Chronologie du compte : trades clos (resultat net) et mouvements d'argent, dans l'ordre.
   * Chaque point donne le solde, le P&L cumule (trades seulement) et les mouvements cumules.
   */
  function timeline(account, list) {
    const start = num(account.startBalance) || 0;
    const ev = [];
    list.filter((x) => x.t.accountId === account.id && x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime)
      .forEach((x) => ev.push({ t: x.t.exitTime, kind: "trade", amount: x.m.net, id: x.t.id, symbol: x.t.symbol }));
    flowsOf(account).forEach((f) => ev.push({ t: f.t, kind: f.type, amount: signed(f), id: f.id, note: f.note }));
    ev.sort((a, b) => a.t - b.t || (a.kind === "trade" ? 1 : -1));    // a la meme heure, le mouvement d'argent d'abord
    let balance = start, pnl = 0, flows = 0;
    return ev.map((e) => {
      balance += e.amount;
      if (e.kind === "trade") pnl += e.amount; else flows += e.amount;
      return Object.assign({}, e, { balance, pnl, flows });
    });
  }

  /** Resume du compte a un instant donne (par defaut : maintenant). */
  function summary(account, list, atMs) {
    const at = atMs == null ? Infinity : atMs;
    const start = num(account.startBalance) || 0;
    const tl = timeline(account, list).filter((e) => e.t <= at);
    const last = tl[tl.length - 1];
    const pnl = last ? last.pnl : 0, netFlows = last ? last.flows : 0;
    const capital = start + netFlows;                    // capital investi : depart + depots - retraits
    const flows = flowsOf(account).filter((f) => f.t <= at);
    return {
      start, balance: start + pnl + netFlows, pnl, netFlows, capital,
      pnlPct: capital > 0 ? pnl / capital * 100 : null,
      deposits: flows.filter((f) => f.type === "deposit").reduce((s, f) => s + f.amount, 0),
      withdrawals: flows.filter((f) => f.type === "withdrawal").reduce((s, f) => s + f.amount, 0),
      tradesClosed: tl.filter((e) => e.kind === "trade").length,
    };
  }

  // ------------------------------------------------------------------ etape 2 : cartes et statistiques
  /** Debuts du jour, de la semaine (lundi) et du mois en cours, heure du Benin, en ms UTC. */
  function periodStarts(nowMs) {
    const l = JC.local(nowMs), off = JC.LOCAL_OFFSET_MIN * 60000;
    return { day: Date.UTC(l.y, l.m - 1, l.d) - off, week: JC.weekStart(nowMs), month: Date.UTC(l.y, l.m - 1, 1) - off };
  }
  /** Resultat net des trades CLOSED du compte depuis le debut du jour, de la semaine et du mois. */
  function periodPnl(account, list, nowMs) {
    const p = periodStarts(nowMs);
    const closed = list.filter((x) => x.t.accountId === account.id && x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime && x.t.exitTime <= nowMs);
    const out = {};
    Object.entries(p).forEach(([k, from]) => {
      const items = closed.filter((x) => x.t.exitTime >= from);
      const balStart = summary(account, list, from - 1).balance;
      const net = items.reduce((s, x) => s + x.m.net, 0);
      out[k] = { net, n: items.length, from, pct: balStart > 0 ? net / balStart * 100 : null };
    });
    return out;
  }
  /** Statistiques des trades du compte (moteur du journal) + ratio gain moyen / perte moyenne. */
  function accountStats(account, list) {
    const mine = list.filter((x) => x.t.accountId === account.id);
    const s = JC.stats(mine, num(account.startBalance) || 0);
    s.payoffRatio = s.avgWin != null && s.avgLoss != null && s.avgLoss < 0 ? s.avgWin / -s.avgLoss : null;
    return s;
  }

  // ------------------------------------------------------------------ etape 3 : courbe et drawdown
  const PERIODS = { "7d": "7 jours", "30d": "30 jours", "3m": "3 mois", all: "Tout" };
  /** Debut d'une periode ("7d", "30d", "3m", "all") en ms UTC ; null pour "all". */
  function rangeStart(key, nowMs) {
    if (key === "7d") return nowMs - 7 * 86400000;
    if (key === "30d") return nowMs - 30 * 86400000;
    if (key === "3m") {                                           // meme jour, 3 mois plus tot (heure du Benin)
      const off = JC.LOCAL_OFFSET_MIN * 60000, l = JC.local(nowMs);
      let y = l.y, m = l.m - 3; if (m < 1) { m += 12; y--; }
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return Date.UTC(y, m - 1, Math.min(l.d, days), l.h, l.min) - off;
    }
    return null;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  /**
   * Courbe du solde sur une periode, avec son drawdown.
   * Le drawdown ne compte que les trades : un depot ou un retrait deplace aussi le sommet,
   * donc il ne cree ni ne cache aucun drawdown. Sommet de depart = solde au debut de la periode.
   */
  function curve(account, list, fromMs) {
    const start = num(account.startBalance) || 0;
    const from = fromMs == null ? -Infinity : fromMs;
    const tl = timeline(account, list);
    const before = tl.filter((e) => e.t < from), inside = tl.filter((e) => e.t >= from);
    const b0 = before.length ? before[before.length - 1].balance : start;
    const t0 = from === -Infinity ? (inside.length ? inside[0].t : null) : from;
    let peak = b0, maxDD = 0, maxDDPct = 0, troughT = null, pnl = 0, flows = 0;
    const points = [{ t: t0, balance: b0, kind: "start", amount: 0, dd: 0, ddPct: 0, peak }];
    inside.forEach((e) => {
      if (e.kind === "trade") pnl += e.amount; else { flows += e.amount; peak += e.amount; }
      peak = Math.max(peak, e.balance);
      const dd = r2(Math.min(0, e.balance - peak)), ddPct = peak > 0 ? dd / peak * 100 : 0;
      if (dd < maxDD) { maxDD = dd; troughT = e.t; }
      maxDDPct = Math.min(maxDDPct, ddPct);
      points.push({ t: e.t, balance: e.balance, kind: e.kind, amount: e.amount, symbol: e.symbol, note: e.note, dd, ddPct, peak });
    });
    const last = points[points.length - 1];
    // % du resultat : comme la carte du haut, divise par le capital engage (solde de depart + mouvements de la periode)
    return {
      points, startBalance: b0, endBalance: last.balance, pnl: r2(pnl), flows: r2(flows),
      pnlPct: b0 + flows > 0 ? pnl / (b0 + flows) * 100 : null, trades: inside.filter((e) => e.kind === "trade").length,
      maxDD, maxDDPct, troughT, currentDD: last.dd, currentDDPct: last.ddPct,
    };
  }

  // ------------------------------------------------------------------ etape 4 : calendrier et repartitions
  const closedOf = (account, list) => list.filter((x) => x.t.accountId === account.id && x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime);
  /** Calendrier d'un mois (heure du Benin) pour un compte : resultat net par jour et resume du mois. */
  function monthCalendar(account, list, year, month) {
    const days = JC.calendar(closedOf(account, list), year, month);
    const rawTotal = Object.values(days).reduce((s, d) => s + d.net, 0);   // total avant arrondi des jours (comme la carte "Ce mois")
    Object.values(days).forEach((d) => { d.net = r2(d.net); });
    const rows = Object.keys(days).sort().map((k) => Object.assign({ day: k }, days[k]));
    const best = rows.reduce((b, d) => (d.net > 0 && (!b || d.net > b.net) ? d : b), null);
    const worst = rows.reduce((w, d) => (d.net < 0 && (!w || d.net < w.net) ? d : w), null);
    return {
      year, month, days, total: r2(rawTotal), trades: rows.reduce((s, d) => s + d.n, 0),
      green: rows.filter((d) => d.net > 0).length, red: rows.filter((d) => d.net < 0).length, best, worst,
    };
  }
  /** Trades clotures d'un jour donne ("AAAA-MM-JJ", heure du Benin), dans l'ordre de cloture. */
  function dayTrades(account, list, dayKey) {
    return closedOf(account, list).filter((x) => JC.localDay(x.t.exitTime) === dayKey).sort((a, b) => a.t.exitTime - b.t.exitTime);
  }
  /** Repartitions par symbole, jour de la semaine et session (avec l'echelle commune des barres). */
  function breakdowns(account, list) {
    const s = accountStats(account, list);
    const scale = (rows) => Math.max(0, ...rows.map((g) => Math.abs(g.net)));
    const bySymbol = s.bySymbol.slice().sort((a, b) => b.net - a.net);
    return {
      bySymbol, byWeekday: s.byWeekday, bySession: s.bySession,
      scale: { symbol: scale(bySymbol), weekday: scale(s.byWeekday), session: scale(s.bySession) },
    };
  }

  // ------------------------------------------------------------------ etape 5 : regles prop firm
  /**
   * Suivi des 4 regles principales d'un challenge, a partir des regles du compte (saisies par l'utilisateur,
   * les memes que dans l'onglet Comptes) et du moteur ChallengeCore. Trades seulement (pas les depots/retraits).
   * Statut de chaque regle : "ok", "warn" (ATTENTION : plus de la moitie de la marge utilisee),
   * "fail" (ECHEC : limite franchie, meme un jour passe), "progress" (EN COURS), "off" (non reglee).
   */
  function propRules(account, list, nowMs, news) {
    const ev = CC.evaluate(account, list.filter((x) => x.t.accountId === account.id), { nowMs, news: news || [] });
    const r = ev.rules, clamp = (v) => Math.max(0, Math.min(1, v));
    const fails = (name) => ev.violations.filter((v) => v.rule === name).map((v) => v.detail);
    const items = [];
    // perte journaliere maximale
    if (r.dailyLossPct) {
      const d = ev.daily, f = fails("Perte journalière maximale"), used = clamp(1 - d.remainFrac);
      items.push({ key: "daily", pct: r.dailyLossPct, limit: r2(d.limit), value: r2(d.todayPnl), remain: r2(d.remain), used,
        status: f.length ? "fail" : used < 0.5 ? "ok" : "warn", fails: f });
    } else items.push({ key: "daily", status: "off" });
    // perte totale maximale (drawdown max du challenge : plancher statique ou suiveur)
    if (r.maxDDPct) {
      const d = ev.dd, f = fails("Drawdown maximal"), used = clamp(1 - d.remainFrac);
      items.push({ key: "total", pct: r.maxDDPct, limit: r2(account.startBalance * r.maxDDPct / 100), floor: r2(d.floor), remain: r2(d.remain),
        value: r2(ev.basisValue), mode: d.mode, basis: d.basis, used, status: f.length ? "fail" : used < 0.5 ? "ok" : "warn", fails: f });
    } else items.push({ key: "total", status: "off" });
    // objectif de profit
    if (r.profitTargetPct) {
      const done = ev.profit >= ev.target - 1e-9;
      items.push({ key: "target", pct: r.profitTargetPct, limit: r2(ev.target), value: r2(ev.profit), used: clamp(ev.progress || 0),
        status: done ? "ok" : "progress", fails: [] });
    } else items.push({ key: "target", status: "off" });
    // jours de trading minimum
    if (r.minTradingDays) {
      items.push({ key: "days", limit: r.minTradingDays, value: ev.tradingDays, used: clamp(ev.tradingDays / r.minTradingDays),
        status: ev.tradingDays >= r.minTradingDays ? "ok" : "progress", fails: [] });
    } else items.push({ key: "days", status: "off" });
    const main = new Set(["Perte journalière maximale", "Drawdown maximal"]);
    return {
      status: ev.status, items, balance: r2(ev.balance), profit: r2(ev.profit), alerts: ev.alerts, notes: ev.notes,
      otherFails: ev.violations.filter((v) => !main.has(v.rule)),     // autres regles reglees dans Comptes (duree, annonces...)
      active: items.some((i) => i.status !== "off"),
    };
  }

  return { sanitizeCashflow, signed, flowsOf, timeline, summary, periodStarts, periodPnl, accountStats, PERIODS, rangeStart, curve, monthCalendar, dayTrades, breakdowns, propRules };
});
