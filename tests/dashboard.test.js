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
