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
