/* Desk Forex : calculs du Dashboard (purs, sans DOM ni reseau, testes avec node --test).
 * Reutilise les trades du journal (journal-core.js) : il n'y a qu'un seul journal.
 * Regle : un depot ou un retrait change le SOLDE, mais n'est jamais un gain ou une perte
 * (il n'entre ni dans le P&L, ni dans les statistiques, ni dans le drawdown).
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./journal-core.js") : root.JournalCore);
  if (isNode) module.exports = api; else root.DashboardCore = api;
})(typeof self !== "undefined" ? self : this, function (JC) {
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

  return { sanitizeCashflow, signed, flowsOf, timeline, summary };
});
