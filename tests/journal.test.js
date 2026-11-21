// Tests deterministes du moteur de journal (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../journal-core.js");
const T = (s) => Date.parse(s);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const t1 = { id: "t1", accountId: "default", status: "CLOSED", symbol: "EUR/USD", side: "buy", lots: 0.01,
  entry: 1.085, sl: 1.0837, tp: 1.0876, exit: 1.087, commission: 0.1, swap: 0,
  entryTime: T("2026-11-18T13:30:00Z"), exitTime: T("2026-11-18T15:00:00Z"), setup: "Price action",
  checklist: { a: true, b: false }, errors: [] };
const t2 = { id: "t2", accountId: "default", status: "CLOSED", symbol: "XAU/USD", side: "sell", lots: 0.01,
  entry: 3530, sl: 3533, exit: 3533, entryTime: T("2026-11-18T08:00:00Z"), exitTime: T("2026-11-18T08:30:00Z"),
  setup: "SMC", errors: ["Sur-levier"] };
const t3 = { id: "t3", accountId: "default", status: "CLOSED", symbol: "USD/JPY", side: "buy", lots: 0.01,
  entry: 150, sl: 149.8, exit: 150.3, entryTime: T("2026-11-19T02:00:00Z"), exitTime: T("2026-11-19T05:00:00Z"),
  setup: "Price action", checklist: { a: true, b: true }, errors: [] };
const t4 = { id: "t4", accountId: "default", status: "CLOSED", symbol: "EUR/GBP", side: "buy", lots: 0.01,
  entry: 0.85, sl: 0.848, exit: 0.852, entryTime: T("2026-11-19T09:00:00Z"), exitTime: T("2026-11-19T10:00:00Z") };
const t5 = { id: "t5", accountId: "default", status: "OPEN", symbol: "EUR/USD", side: "buy", lots: 0.01, entry: 1.09, entryTime: T("2026-11-20T09:00:00Z") };
const t6 = { id: "t6", accountId: "default", status: "WATCH", symbol: "EUR/USD", side: "buy", entryTime: T("2026-11-20T10:00:00Z"), errors: ["FOMO"] };
const accounts = [{ id: "default", startBalance: 68 }];
const all = () => J.enrich([t1, t2, t3, t4, t5, t6], accounts, 2);

test("heure du Benin (UTC+1), saisie locale, duree, debut de semaine", () => {
  const l = J.local(t1.entryTime);
  assert.deepEqual([l.h, l.min, l.wd], [14, 30, 3]);
  assert.equal(J.fmtLocal(t1.entryTime), "18/11/2026 14:30");
  assert.equal(J.fmtUtc(t1.entryTime), "2026-11-18 13:30");
  assert.equal(J.parseLocalInput("2026-11-18T14:30"), t1.entryTime);
  assert.equal(J.toLocalInput(t1.entryTime), "2026-11-18T14:30");
  assert.equal(J.fmtDuration(90 * 60000), "1 h 30");
  assert.equal(J.fmtDuration(26 * 3600000), "1 j 2 h");
  assert.equal(J.weekStart(t1.entryTime), T("2026-11-15T23:00:00Z"));       // lundi 16/11 00:00 au Benin
  assert.equal(J.weekStart(T("2026-11-15T23:30:00Z")), T("2026-11-15T23:00:00Z"));
});

test("sessions et jour de la semaine", () => {
  assert.equal(J.sessionOf(t1.entryTime), "Chevauchement");
  assert.equal(J.sessionOf(t2.entryTime), "Londres");
  assert.equal(J.sessionOf(t3.entryTime), "Asie");
  assert.equal(J.sessionOf(T("2026-11-18T19:00:00Z")), "New York");
  assert.equal(J.sessionOf(T("2026-11-21T12:00:00Z")), "Hors session");   // samedi
});

test("chiffres d'un trade : risque, pips, R, net, plan", () => {
  const [a, b, c, d, e, f] = all();
  near(a.m.slPips, 13); near(a.m.riskUsd, 1.3);
  near(a.m.balanceAtEntry, 65); near(a.m.riskPct, 1.3 / 65 * 100);   // t2 (-3 $) est clos avant l'entree de t1
  near(a.m.pips, 20); near(a.m.gross, 2); near(a.m.net, 1.9); near(a.m.r, 1.9 / 1.3); near(a.m.plannedRR, 2);
  assert.equal(a.m.session, "Chevauchement"); assert.equal(a.m.weekday, "mercredi"); assert.equal(a.m.hour, 14);
  assert.equal(a.m.durationMs, 90 * 60000);
  assert.equal(a.m.inPlan, false);                         // une case de checklist non cochee
  near(b.m.net, -3); near(b.m.r, -1);
  assert.ok(b.m.warnings.some((w) => /supérieur à ta limite de 2 %/.test(w)));   // 3 $ sur 68 $
  assert.equal(b.m.inPlan, false);
  near(c.m.pipValueLot, 1000 / 150); near(c.m.net, 2); near(c.m.r, 1.5);
  near(c.m.balanceAtEntry, 68 - 3 + 1.9);                 // t2 et t1 clos avant l'entree de t3
  assert.equal(c.m.inPlan, true);
  assert.equal(d.m.net, undefined);                        // croisee sans valeur du pip
  assert.ok(d.m.warnings.some((w) => /valeur du pip inconnue/.test(w)));
  near(J.metrics(Object.assign({}, t4, { grossOverride: 5 }), 68, 2).net, 5);
  assert.ok(e.m.errors.some((x) => /stop-loss obligatoire/.test(x)));
  assert.deepEqual(f.m.errors, []);
  assert.ok(J.metrics(Object.assign({}, t1, { sl: 1.09 }), 68, 2).errors.some((x) => /mauvais côté/.test(x)));
  assert.ok(J.metrics(Object.assign({}, t1, { exit: null }), 68, 2).errors.some((x) => /prix de sortie manquant/.test(x)));
  assert.ok(J.metrics(Object.assign({}, t1, { exitTime: t1.entryTime - 1 }), 68, 2).errors.some((x) => /avant l'entrée/.test(x)));
});

test("statistiques : taux, esperance, profit factor, drawdown, series", () => {
  const s = J.stats(all(), 68);
  assert.equal(s.n, 3);                                     // t4 sans resultat net, t5 ouvert, t6 WATCH
  assert.deepEqual([s.wins, s.losses], [2, 1]);
  near(s.winRate, 2 / 3); near(s.avgWin, 1.95); near(s.avgLoss, -3);
  near(s.profitFactor, 3.9 / 3); near(s.expectancyUsd, 0.3); near(s.expectancyR, (1.9 / 1.3 - 1 + 1.5) / 3);
  near(s.maxDD, -3); near(s.maxDDPct, -3 / 68 * 100); near(s.endBalance, 68.9);
  assert.deepEqual([s.longestWin, s.longestLoss], [2, 1]);
  assert.deepEqual(s.curve.map((p) => Math.round(p.equity * 100) / 100), [68, 65, 66.9, 68.9]);
  assert.deepEqual(s.bySession.map((g) => g.key), ["Asie", "Londres", "Chevauchement"]);
  assert.deepEqual(s.bySetup.map((g) => [g.key, g.n]), [["Price action", 2], ["SMC", 1]]);
  assert.deepEqual(s.byWeekday.map((g) => g.key), ["mercredi", "jeudi"]);
  assert.deepEqual(s.errorCost, [{ key: "Sur-levier", n: 1, net: -3, losses: -3, avgR: -1 }]);
  assert.equal(s.plan.known, 3); near(s.plan.rate, 1 / 3);
  near(s.plan.inPlan.net, 2); near(s.plan.outPlan.net, -1.1);
  assert.equal(J.stats([], 100).n, 0);
});

test("filtres, calendrier mensuel et revue de la semaine", () => {
  const list = all();
  assert.equal(J.filterTrades(list, { symbol: "EUR/USD" }).length, 3);
  assert.equal(J.filterTrades(list, { setup: "Price action" }).length, 2);
  assert.equal(J.filterTrades(list, { session: "Asie" }).length, 1);
  assert.equal(J.filterTrades(list, { from: T("2026-11-19T00:00:00Z") }).length, 4);
  assert.equal(J.filterTrades(list, { status: "OPEN" }).length, 1);
  const cal = J.calendar(list, 2026, 11);
  near(cal["2026-11-18"].net, -1.1); assert.equal(cal["2026-11-18"].n, 2);
  near(cal["2026-11-19"].net, 2);
  assert.deepEqual(J.calendar(list, 2026, 10), {});
  const w = J.weeklyReview(list, t1.entryTime, 68);
  assert.equal(w.key, "2026-11-16");
  assert.deepEqual(w.best.map((x) => x.t.id), ["t3", "t1"]);
  assert.deepEqual(w.worst.map((x) => x.t.id), ["t2"]);
  assert.deepEqual(w.frequentErrors, [{ key: "Sur-levier", n: 1 }, { key: "FOMO", n: 1 }]);
  assert.equal(w.stats.n, 3);
  assert.equal(J.weeklyReview(list, T("2026-11-25T10:00:00Z"), 68).stats.n, 0);
});

test("export CSV, nettoyage a l'import, migration de l'ancien journal", () => {
  const csv = J.toCsv(J.enrich([Object.assign({}, t1, { notes: "=HYPERLINK(1)" })], accounts, 2));
  const [head, line] = csv.trim().split("\r\n");
  assert.match(head, /^id,compte,statut,symbole,sens,lots,entree_utc,entree_benin/);
  assert.match(line, /'=HYPERLINK\(1\)/);
  assert.match(line, /18\/11\/2026 14:30/);
  const s = J.sanitizeTrade({ id: "x", status: "PIRATE", symbol: "ZZZ/YYY", screenshot: "javascript:alert(1)", errors: "FOMO", lots: "abc" });
  assert.deepEqual([s.status, s.symbol, s.screenshot, s.errors, s.lots], ["WATCH", "EUR/USD", "", [], null]);
  assert.equal(J.sanitizeTrade({ id: "y", screenshot: "https://www.tradingview.com/x/abc/" }).screenshot, "https://www.tradingview.com/x/abc/");
  assert.equal(J.sanitizeTrade({ status: "OPEN" }), null);
  const v1 = J.migrateV1([{ id: 123, date: "2026-11-21T10:00:00.000Z", symbol: "EUR/USD", side: "buy", status: "CLOSED",
    entry: "1.08500", stop: "1.08370", lots: "0.01", exit: "1.08700", costs: "0.10", why: "Test guide" }], "default");
  assert.equal(v1.length, 1);
  assert.equal(v1[0].id, "v1-123"); assert.equal(v1[0].sl, 1.0837); assert.match(v1[0].notes, /Test guide/);
  near(J.metrics(v1[0], 68, 2).net, 1.9);
});
