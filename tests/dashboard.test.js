// Tests deterministes du Dashboard (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const JC = require("../journal-core.js");
const DB = require("../dashboard-core.js");
const T = (s) => Date.parse(s);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const acc = { id: "a1", startBalance: 1000, cashflows: [
  { id: "d1", t: T("2026-11-10T09:00:00Z"), type: "deposit", amount: 500, note: "virement" },
  { id: "w1", t: T("2026-11-19T09:00:00Z"), type: "withdrawal", amount: 200 },
  { id: "bad", t: T("2026-11-19T09:00:00Z"), type: "deposit", amount: -5 },   // montant invalide ignore
] };
const tr = (id, exitIso, net, extra) => Object.assign({ id, accountId: "a1", status: "CLOSED", symbol: "EUR/USD", side: "buy", lots: 0.1,
  entry: 1.09, sl: 1.089, exit: 1.091, grossOverride: net, entryTime: T(exitIso) - 3600000, exitTime: T(exitIso) }, extra || {});
const trades = [tr("t1", "2026-11-12T10:00:00Z", 120), tr("t2", "2026-11-18T10:00:00Z", -50),
  tr("t3", "2026-11-20T10:00:00Z", 30), tr("autre", "2026-11-18T10:00:00Z", 999, { accountId: "a2" }),
  tr("ouvert", "2026-11-20T10:00:00Z", 0, { status: "OPEN", exit: null, exitTime: null, grossOverride: null })];
const list = JC.enrich(trades, [acc, { id: "a2", startBalance: 0 }], 2);

test("mouvements d'argent : nettoyage et signe", () => {
  assert.deepEqual(DB.sanitizeCashflow({ t: 5, amount: "12.345", type: "withdrawal", note: "x" }), { id: "cf5", t: 5, type: "withdrawal", amount: 12.35, note: "x" });
  assert.equal(DB.sanitizeCashflow({ t: 5, amount: 0 }), null);
  assert.equal(DB.sanitizeCashflow({ amount: 10 }), null);
  assert.equal(DB.sanitizeCashflow({ t: 5, amount: 10, type: "pirate" }).type, "deposit");
  assert.equal(DB.flowsOf(acc).length, 2);
  assert.deepEqual(DB.flowsOf(acc).map(DB.signed), [500, -200]);
});

test("chronologie : trades du compte et mouvements, dans l'ordre", () => {
  const tl = DB.timeline(acc, list);
  assert.deepEqual(tl.map((e) => e.id), ["d1", "t1", "t2", "w1", "t3"]);   // l'autre compte et le trade ouvert sont exclus
  assert.deepEqual(tl.map((e) => e.balance), [1500, 1620, 1570, 1370, 1400]);
  assert.deepEqual(tl.map((e) => e.pnl), [0, 120, 70, 70, 100]);          // les mouvements ne changent pas le P&L
  assert.deepEqual(tl.map((e) => e.flows), [500, 500, 500, 300, 300]);
});

test("profit du jour, de la semaine et du mois (heure du Benin)", () => {
  const now = T("2026-11-20T15:00:00Z");                    // vendredi 20/11, 16:00 au Benin
  const p = DB.periodStarts(now);
  assert.equal(p.day, T("2026-11-19T23:00:00Z"));          // 20/11 00:00 au Benin
  assert.equal(p.week, T("2026-11-15T23:00:00Z"));         // lundi 16/11 00:00
  assert.equal(p.month, T("2026-10-31T23:00:00Z"));        // 01/11 00:00
  const r = DB.periodPnl(acc, list, now);
  assert.deepEqual([r.day.net, r.day.n], [30, 1]);          // t3 seulement
  assert.deepEqual([r.week.net, r.week.n], [-20, 2]);       // t2 (-50) + t3 (+30)
  assert.deepEqual([r.month.net, r.month.n], [100, 3]);
  near(r.day.pct, 30 / 1370 * 100);                         // solde au debut du jour : 1370 (apres le retrait)
  // un trade clos a 23:30 UTC le 19/11 = 00:30 le 20/11 au Benin : il compte pour le 20
  const late = JC.enrich(trades.concat([tr("tard", "2026-11-19T23:30:00Z", 5)]), [acc], 2);
  assert.equal(DB.periodPnl(acc, late, now).day.n, 2);
});

test("statistiques du compte et ratio gain/perte", () => {
  const s = DB.accountStats(acc, list);
  assert.equal(s.n, 3);                                     // les trades de l'autre compte sont exclus
  assert.deepEqual([s.wins, s.losses, s.longestWin, s.longestLoss], [2, 1, 1, 1]);
  near(s.avgWin, 75); near(s.avgLoss, -50); near(s.payoffRatio, 1.5);
  near(s.profitFactor, 150 / 50); near(s.expectancyUsd, 100 / 3);
  assert.equal(DB.accountStats({ id: "vide", startBalance: 0 }, list).payoffRatio, null);
});

test("resume : solde avec mouvements, P&L et % sur le capital investi", () => {
  const s = DB.summary(acc, list);
  assert.deepEqual([s.start, s.balance, s.pnl, s.netFlows, s.capital, s.deposits, s.withdrawals, s.tradesClosed],
    [1000, 1400, 100, 300, 1300, 500, 200, 3]);
  near(s.pnlPct, 100 / 1300 * 100);
  const mid = DB.summary(acc, list, T("2026-11-15T00:00:00Z"));          // a une date passee
  assert.deepEqual([mid.balance, mid.pnl, mid.capital], [1620, 120, 1500]);
  const empty = DB.summary({ id: "x", startBalance: 0 }, list);
  assert.deepEqual([empty.balance, empty.pnlPct], [0, null]);
});

test("debut des periodes du graphique (7 jours, 30 jours, 3 mois, tout)", () => {
  const now = T("2026-11-20T15:00:00Z");
  assert.equal(DB.rangeStart("7d", now), T("2026-11-13T15:00:00Z"));
  assert.equal(DB.rangeStart("30d", now), T("2026-10-21T15:00:00Z"));
  assert.equal(DB.rangeStart("3m", now), T("2026-08-20T15:00:00Z"));
  assert.equal(DB.rangeStart("3m", T("2026-05-31T10:00:00Z")), T("2026-02-28T10:00:00Z"));   // fevrier plus court
  assert.equal(DB.rangeStart("3m", T("2026-01-15T10:00:00Z")), T("2025-10-15T10:00:00Z"));   // changement d'annee
  assert.equal(DB.rangeStart("all", now), null);
});

test("courbe : le drawdown ignore les depots et retraits", () => {
  const c = DB.curve(acc, list, null);
  assert.deepEqual(c.points.map((p) => p.balance), [1000, 1500, 1620, 1570, 1370, 1400]);
  assert.deepEqual(c.points.map((p) => p.dd), [0, 0, 0, -50, -50, -20]);   // le retrait de 200 ne compte pas comme une perte
  assert.equal(c.maxDD, -50);
  near(c.maxDDPct, -50 / 1420 * 100);
  assert.equal(c.troughT, T("2026-11-18T10:00:00Z"));
  assert.equal(c.currentDD, -20);
  assert.equal(c.pnl, 100); assert.equal(c.flows, 300); assert.equal(c.trades, 3);
  // periode a partir du 15/11 : depart au solde de ce jour-la
  const p = DB.curve(acc, list, T("2026-11-15T00:00:00Z"));
  assert.equal(p.startBalance, 1620); assert.equal(p.points[0].t, T("2026-11-15T00:00:00Z"));
  assert.equal(p.pnl, -20); assert.equal(p.trades, 2); assert.equal(p.maxDD, -50);
  near(p.pnlPct, -20 / 1420 * 100);                  // solde de depart + mouvements de la periode
  near(c.pnlPct, DB.summary(acc, list).pnlPct);       // sur tout l'historique : meme % que la carte du haut
  // a partir du 19/11 : le sommet repart du solde de ce jour, aucun drawdown
  assert.equal(DB.curve(acc, list, T("2026-11-19T00:00:00Z")).maxDD, 0);
  // un depot pendant un drawdown ne l'efface pas
  const a3 = { id: "a3", startBalance: 1000, cashflows: [{ id: "d", t: T("2026-11-11T09:00:00Z"), type: "deposit", amount: 500 }] };
  const l3 = JC.enrich([tr("x1", "2026-11-10T10:00:00Z", -100, { accountId: "a3" }), tr("x2", "2026-11-12T10:00:00Z", 50, { accountId: "a3" })], [a3], 2);
  assert.deepEqual(DB.curve(a3, l3, null).points.map((q) => q.dd), [0, -100, -100, -50]);
  // compte sans trade
  const vide = DB.curve({ id: "z", startBalance: 500 }, list, null);
  assert.equal(vide.points.length, 1); assert.equal(vide.maxDD, 0); assert.equal(vide.endBalance, 500);
});

test("calendrier du mois : jours verts et rouges, heure du Benin, trades d'un jour", () => {
  const more = JC.enrich(trades.concat([tr("t4", "2026-11-20T23:30:00Z", -15), tr("t5", "2026-11-12T16:00:00Z", -20, { symbol: "XAU/USD" }),
    tr("oct", "2026-10-31T23:30:00Z", 40)]), [acc, { id: "a2", startBalance: 0 }], 2);
  const m = DB.monthCalendar(acc, more, 2026, 11);
  assert.deepEqual(Object.keys(m.days).sort(), ["2026-11-01", "2026-11-12", "2026-11-18", "2026-11-20", "2026-11-21"]);
  assert.deepEqual(m.days["2026-11-12"], { net: 100, n: 2 });     // 120 - 20 le meme jour
  assert.equal(m.days["2026-11-18"].net, -50);                     // le trade de l'autre compte (999) est exclu
  assert.equal(m.days["2026-11-21"].net, -15);                     // 23:30 UTC = 00:30 le lendemain au Benin
  assert.equal(m.days["2026-11-01"].net, 40);                      // 31/10 23:30 UTC = 1er novembre 00:30 au Benin
  assert.equal(m.total, 105); assert.equal(m.trades, 6);
  assert.equal(m.green, 3); assert.equal(m.red, 2);
  assert.equal(m.best.day, "2026-11-12"); assert.equal(m.worst.day, "2026-11-18");
  assert.equal(DB.monthCalendar(acc, more, 2026, 10).trades, 0);
  assert.equal(DB.monthCalendar(acc, more, 2026, 10).best, null);
  assert.deepEqual(DB.dayTrades(acc, more, "2026-11-12").map((x) => x.t.id), ["t1", "t5"]);
  assert.deepEqual(DB.dayTrades(acc, more, "2026-11-19"), []);
  // le total du mois egale le resultat du mois des cartes du haut (pas d'erreur d'arrondi jour par jour)
  const cents = JC.enrich([tr("c1", "2026-11-02T10:00:00Z", 0.004), tr("c2", "2026-11-03T10:00:00Z", 0.004), tr("c3", "2026-11-04T10:00:00Z", 0.004)], [acc], 2);
  assert.equal(DB.monthCalendar(acc, cents, 2026, 11).total, Math.round(cents.reduce((s, x) => s + x.m.net, 0) * 100) / 100);
});

test("repartitions par symbole, jour et session du compte choisi", () => {
  const more = JC.enrich(trades.concat([tr("t5", "2026-11-12T16:00:00Z", -20, { symbol: "XAU/USD" })]), [acc, { id: "a2", startBalance: 0 }], 2);
  const b = DB.breakdowns(acc, more);
  assert.deepEqual(b.bySymbol.map((g) => [g.key, g.n, g.net]), [["EUR/USD", 3, 100], ["XAU/USD", 1, -20]]);   // trie du meilleur au pire
  assert.deepEqual(b.byWeekday.map((g) => g.key), ["mercredi", "jeudi", "vendredi"]);                            // ordre de la semaine
  assert.equal(b.byWeekday.find((g) => g.key === "jeudi").net, 100);
  assert.equal(b.bySession.reduce((s, g) => s + g.n, 0), 4);
  assert.ok(b.bySession.every((g) => JC.SESSIONS.includes(g.key)));
  assert.equal(b.scale.symbol, 100); assert.equal(b.scale.weekday, 100);
  const vide = DB.breakdowns({ id: "z", startBalance: 0 }, more);
  assert.deepEqual(vide.bySymbol, []); assert.equal(vide.scale.symbol, 0);
});

test("regles prop firm : OK, ATTENTION, ECHEC, EN COURS et non reglee", () => {
  const pa = { id: "p1", startBalance: 10000, type: "challenge",
    rules: { dailyLossPct: 5, maxDDPct: 10, profitTargetPct: 8, minTradingDays: 3 } };
  const P = (id, iso, net) => tr(id, iso, net, { accountId: "p1" });
  const base = [P("p1", "2026-11-16T10:00:00Z", 300), P("p2", "2026-11-17T10:00:00Z", -200), P("p3", "2026-11-17T14:00:00Z", -100)];
  const st = (res, k) => res.items.find((i) => i.key === k);
  // le 17 a 15:00 : -300 sur une limite de 500 -> 60 % utilise -> ATTENTION
  let res = DB.propRules(pa, JC.enrich(base, [pa], 2), T("2026-11-17T15:00:00Z"));
  assert.equal(st(res, "daily").status, "warn"); near(st(res, "daily").used, 0.6);
  assert.equal(st(res, "daily").limit, 500); assert.equal(st(res, "daily").remain, 200);
  assert.equal(st(res, "total").status, "ok"); assert.equal(st(res, "total").floor, 9000);
  assert.equal(st(res, "target").status, "progress"); assert.equal(st(res, "days").status, "progress");
  assert.equal(st(res, "days").value, 2);
  // le 19 : nouveau jour gagnant -> perte du jour OK, 3 jours de trading -> OK, objectif encore en cours
  res = DB.propRules(pa, JC.enrich(base.concat([P("p4", "2026-11-19T10:00:00Z", 100)]), [pa], 2), T("2026-11-19T15:00:00Z"));
  assert.equal(st(res, "daily").status, "ok"); assert.equal(st(res, "daily").used, 0);
  assert.equal(st(res, "days").status, "ok"); assert.equal(st(res, "days").value, 3);
  near(st(res, "target").used, 100 / 800); assert.equal(res.status, "EN COURS"); assert.equal(res.active, true);
  // perte de 550 le 17 : ECHEC, meme vu le 19 (la limite a ete franchie un jour passe)
  res = DB.propRules(pa, JC.enrich(base.concat([P("p5", "2026-11-17T16:00:00Z", -250), P("p4", "2026-11-19T10:00:00Z", 100)]), [pa], 2), T("2026-11-19T15:00:00Z"));
  assert.equal(st(res, "daily").status, "fail"); assert.ok(st(res, "daily").fails[0].includes("17/11/2026"));
  assert.equal(res.status, "RÈGLE VIOLÉE");
  // perte totale : le solde passe sous le plancher de 9000 -> ECHEC
  res = DB.propRules(Object.assign({}, pa, { rules: { maxDDPct: 10 } }), JC.enrich([P("x", "2026-11-18T10:00:00Z", -1200)], [pa], 2), T("2026-11-19T15:00:00Z"));
  assert.equal(st(res, "total").status, "fail"); assert.equal(st(res, "daily").status, "off");
  // objectif atteint -> OK
  res = DB.propRules(pa, JC.enrich([P("a", "2026-11-16T10:00:00Z", 400), P("b", "2026-11-17T10:00:00Z", 300), P("c", "2026-11-18T10:00:00Z", 200)], [pa], 2), T("2026-11-18T15:00:00Z"));
  assert.equal(st(res, "target").status, "ok"); assert.equal(st(res, "target").used, 1); assert.equal(res.status, "OBJECTIF ATTEINT");
  // aucune regle reglee
  res = DB.propRules({ id: "p1", startBalance: 10000 }, JC.enrich(base, [pa], 2), T("2026-11-17T15:00:00Z"));
  assert.equal(res.active, false); assert.ok(res.items.every((i) => i.status === "off"));
});
