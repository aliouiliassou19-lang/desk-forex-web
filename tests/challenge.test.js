// Tests deterministes des regles de challenge (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const JC = require("../journal-core.js");
const C = require("../challenge-core.js");
const T = (s) => Date.parse(s);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// trade EUR/USD clos avec un resultat net impose (resultat brut du courtier), stop de 10 pips sur 0,01 lot
let seq = 0;
const tr = (exitIso, net, extra) => {
  const exitTime = T(exitIso);
  return Object.assign({ id: "c" + (++seq), accountId: "ch", status: "CLOSED", symbol: "EUR/USD", side: "buy", lots: 0.01,
    entry: 1.09, sl: 1.089, exit: 1.091, grossOverride: net, entryTime: exitTime - 30 * 60000, exitTime }, extra || {});
};
const run = (trades, rules, opts, acc) => {
  const account = Object.assign({ id: "ch", startBalance: 10000, rules }, acc || {});
  const list = JC.enrich(trades, [account], 2);
  return C.evaluate(account, list, Object.assign({ nowMs: T("2026-11-20T12:00:00Z"), news: [] }, opts || {}));
};

test("regles vides : aucune limite, compte EN COURS", () => {
  const r = run([tr("2026-11-18T10:00:00Z", -900)], {});
  assert.equal(r.status, "EN COURS");
  assert.equal(r.daily, null); assert.equal(r.dd, null); assert.equal(r.target, null);
  near(r.balance, 9100);
  assert.deepEqual(C.normalizeRules({ dailyLossPct: "0", maxDDPct: "-3", ddMode: "x" }).dailyLossPct, null);
});

test("perte journaliere : violation sur le pire moment de la journee", () => {
  const trades = [tr("2026-11-16T10:00:00Z", 400), tr("2026-11-16T11:00:00Z", 200),
    tr("2026-11-17T10:00:00Z", -300), tr("2026-11-17T11:00:00Z", -250), tr("2026-11-17T15:00:00Z", 300)];
  const r = run(trades, { dailyLossPct: 5 });                       // limite 500 (5 % du solde initial)
  assert.equal(r.status, "RÈGLE VIOLÉE");
  assert.equal(r.violations[0].rule, "Perte journalière maximale");
  assert.match(r.violations[0].detail, /2026-11-17 : perte de 550\.00/);
  // base "debut de journee" : 5 % de 10 600 = 530 -> toujours violee (550)
  assert.equal(run(trades, { dailyLossPct: 5, dailyBase: "dayStart" }).status, "RÈGLE VIOLÉE");
  assert.equal(run(trades, { dailyLossPct: 6 }).status, "EN COURS");   // limite 600
});

test("marge journaliere du jour, jauge et alerte sous 30 %", () => {
  const r = run([tr("2026-11-20T09:00:00Z", -300)], { dailyLossPct: 5 });
  near(r.daily.limit, 500); near(r.daily.remain, 200); near(r.daily.remainFrac, 0.4);
  assert.equal(r.daily.level, "warn"); assert.equal(r.alerts.length, 0);
  const r2 = run([tr("2026-11-20T09:00:00Z", -300), tr("2026-11-20T10:00:00Z", -100)], { dailyLossPct: 5 });
  near(r2.daily.remainFrac, 0.2); assert.equal(r2.daily.level, "danger");
  assert.match(r2.alerts[0], /Perte journalière : il ne reste que 100\.00/);
  // un gain du jour augmente la marge (mesuree depuis le debut de journee)
  near(run([tr("2026-11-20T09:00:00Z", 200)], { dailyLossPct: 5 }).daily.remain, 700);
});

test("drawdown statique, suiveur, suiveur arrete au solde initial", () => {
  const trades = [tr("2026-11-16T10:00:00Z", 1500), tr("2026-11-17T10:00:00Z", -1100)];   // pic 11 500 puis 10 400
  const s = run(trades, { maxDDPct: 10 });
  assert.equal(s.status, "EN COURS"); near(s.dd.floor, 9000); near(s.dd.remain, 1400);
  const t = run(trades, { maxDDPct: 10, ddMode: "trailing" });
  assert.equal(t.status, "RÈGLE VIOLÉE"); assert.equal(t.violations[0].rule, "Drawdown maximal");
  assert.match(t.violations[0].detail, /sous le plancher de 10500\.00/);
  const l = run(trades, { maxDDPct: 10, ddMode: "trailing", trailLock: true });
  assert.equal(l.status, "EN COURS"); near(l.dd.floor, 10000); near(l.dd.remain, 400);
});

test("drawdown sur l'equite : valeur saisie plus recente que le dernier trade", () => {
  const trades = [tr("2026-11-19T10:00:00Z", -500)];
  const snap = { equitySnapshots: [{ t: T("2026-11-20T08:00:00Z"), equity: 9200, balance: 9500 }] };
  const e = run(trades, { maxDDPct: 10, ddBasis: "equity" }, {}, snap);
  near(e.equity, 9200); near(e.dd.remain, 200); assert.equal(e.dd.level, "danger");
  assert.match(e.alerts[0], /Drawdown : il ne reste que 200\.00/);
  const b = run(trades, { maxDDPct: 10, ddBasis: "balance" }, {}, snap);
  near(b.dd.remain, 500); assert.equal(b.dd.level, "ok");
  const old = run(trades, { maxDDPct: 10, ddBasis: "equity" }, {}, { equitySnapshots: [{ t: T("2026-11-18T08:00:00Z"), equity: 9900 }] });
  assert.equal(old.equity, null);
  assert.ok(old.notes.some((n) => /Équité inconnue/.test(n)));
});

test("objectif : jours minimum et consistance requis", () => {
  const trades = [tr("2026-11-16T10:00:00Z", 900), tr("2026-11-17T10:00:00Z", 100), tr("2026-11-18T10:00:00Z", 50)];
  const c = run(trades, { profitTargetPct: 10, minTradingDays: 3, consistencyPct: 50 });
  assert.equal(c.status, "EN COURS");                       // meilleur jour = 86 % du profit
  assert.ok(c.pending.some((p) => /Consistance : le meilleur jour fait 86 %/.test(p)));
  near(c.progress, 1.05);
  assert.equal(run(trades, { profitTargetPct: 10, minTradingDays: 3, consistencyPct: 90 }).status, "OBJECTIF ATTEINT");
  const d = run(trades, { profitTargetPct: 10, minTradingDays: 4 });
  assert.equal(d.status, "EN COURS");
  assert.ok(d.pending.some((p) => /Jours de trading : 3 sur 4/.test(p)));
});

test("annonces interdites, duree limite, risque par trade, debut du challenge", () => {
  const news = [{ timeMs: T("2026-11-18T13:30:00Z"), currency: "USD", event: "CPI", impact: "high" },
    { timeMs: T("2026-11-18T15:00:00Z"), currency: "USD", event: "Moyen", impact: "medium" }];
  const near1 = tr("2026-11-18T14:00:00Z", 50, { entryTime: T("2026-11-18T13:31:00Z") });
  const r = run([near1, tr("2026-11-18T15:30:00Z", 10, { entryTime: T("2026-11-18T15:01:00Z") })], { newsBan: true, newsWindowMin: 2 }, { news });
  assert.equal(r.status, "RÈGLE VIOLÉE");
  assert.equal(r.newsTrades.length, 1);                    // l'annonce d'impact moyen ne compte pas
  assert.match(r.violations[0].detail, /USD CPI/);
  const dur = run([tr("2026-11-10T10:00:00Z", 100)], { maxDays: 5, profitTargetPct: 10 }, {}, { startDate: T("2026-11-10T00:00:00Z") });
  assert.equal(dur.status, "RÈGLE VIOLÉE"); assert.equal(dur.violations[0].rule, "Durée limite");
  const risk = run([tr("2026-11-18T10:00:00Z", 10, { lots: 1 })], { maxRiskPerTradePct: 0.5 });   // 10 pips x 10 $ = 100 $ = 1 %
  assert.equal(risk.overRisk.length, 1); assert.ok(risk.notes.some((n) => /au-delà de 0.5 %/.test(n)));
  const before = run([tr("2026-11-01T10:00:00Z", -900), tr("2026-11-18T10:00:00Z", 100)], { dailyLossPct: 5 }, {}, { startDate: T("2026-11-15T00:00:00Z") });
  near(before.balance, 10100);                             // les trades d'avant le debut du challenge sont ignores
});

test("jour de trading avec heure de remise a zero", () => {
  const t = T("2026-11-17T23:30:00Z");                     // 00:30 le 18 au Benin
  assert.equal(C.dayKey(t, 0), "2026-11-18");
  assert.equal(C.dayKey(t, 2), "2026-11-17");
  assert.deepEqual([C.level(0.6), C.level(0.35), C.level(0.1), C.level(null)], ["ok", "warn", "danger", "off"]);
});

test("donnees de demo : deterministes, valides, challenge sans violation", () => {
  const now = T("2026-11-21T12:00:00Z");
  const a = JC.demoData(now), b = JC.demoData(now);
  assert.deepEqual(a, b);
  assert.equal(a.account.id, JC.DEMO_ACCOUNT_ID);
  assert.ok(a.trades.length >= 15);
  assert.ok(a.trades.every((t) => t.source === "demo" && t.accountId === JC.DEMO_ACCOUNT_ID && /fictif/.test(t.notes)));
  assert.ok(a.trades.every((t) => t.entryTime < now));
  const closed = a.trades.filter((t) => t.status === "CLOSED");
  assert.ok(closed.every((t) => [1, 2, 3, 4, 5].includes(JC.local(t.entryTime).wd)), "pas de trade le week-end");
  const list = JC.enrich(a.trades, [a.account], 2);
  assert.ok(list.filter((x) => x.t.status === "CLOSED").every((x) => x.m.errors.length === 0 && x.m.net != null && x.m.r != null));
  assert.deepEqual([...new Set(a.trades.map((t) => t.status))].sort(), ["CLOSED", "REJECT", "UNFILLED", "WATCH"]);
  const ev = C.evaluate(a.account, list, { nowMs: now, news: [] });
  assert.notEqual(ev.status, "RÈGLE VIOLÉE", JSON.stringify(ev.violations));
  assert.ok(ev.daily && ev.dd && ev.target);
  const s = JC.stats(list, a.account.startBalance);
  assert.ok(s.errorCost.length > 0 && s.bySetup.length >= 3);
});

test("lot maximum selon la marge la plus faible", () => {
  const m = C.maxLot({ stopPips: 20, spreadPips: 1, pipValue: 10,
    limits: [{ name: "perte journalière", amount: 200 }, { name: "drawdown", amount: 500 }, { name: "risque par trade", amount: 100 }] });
  assert.equal(m.binding.name, "risque par trade"); assert.equal(m.lots, 0.47); near(m.risk, 98.7);
  assert.equal(C.maxLot({ stopPips: 20, pipValue: 10, limits: [{ name: "drawdown", amount: 0 }] }).allowed, false);
  assert.match(C.maxLot({ stopPips: 20, pipValue: 10, limits: [{ name: "drawdown", amount: 1 }] }).reason, /même 0.01 lot/);
  assert.equal(C.maxLot({ stopPips: 0, pipValue: 10, limits: [] }).error, "stop (pips) et valeur du pip requis");
});
