// Tests deterministes des moteurs d'analyse (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analysis.js");
const T = (s) => Date.parse(s);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("valeur du pip en USD et conversion", () => {
  near(A.pipValueUsd("EUR/USD", 1.08), 10);
  near(A.pipValueUsd("USD/JPY", 150), 1000 / 150);
  near(A.pipValueUsd("USD/CHF", 0.8), 12.5);
  near(A.pipValueUsd("EUR/GBP", 0.85, 1.27), 12.7);
  near(A.pipValueUsd("EUR/JPY", 162, 150), 1000 / 150);
  near(A.pipValueUsd("XAU/USD", 2650), 10);
  near(A.pipValueUsd("XAG/USD", 31), 50);
  assert.equal(A.pipValueUsd("EUR/GBP", 0.85), null);
  assert.equal(A.conversionNeeded("EUR/GBP"), "GBP/USD");
  assert.equal(A.conversionNeeded("GBP/JPY"), "USD/JPY");
  assert.equal(A.conversionNeeded("USD/JPY"), null);
  assert.equal(A.conversionNeeded("XAU/USD"), null);
});

test("bougies Twelve Data : ordre croissant, dates jour et heure", () => {
  const b = A.parseTimeSeries({ status: "ok", values: [
    { datetime: "2026-11-20 15:00:00", open: "2", high: "3", low: "1", close: "2.5" },
    { datetime: "2026-11-20 14:00:00", open: "1", high: "2", low: "0.5", close: "2" },
    { datetime: "cassé", open: "x", high: "1", low: "1", close: "1" }] });
  assert.equal(b.length, 2);
  assert.equal(b[0].t, T("2026-11-20T14:00:00Z"));
  assert.equal(A.parseTimeSeries({ values: [{ datetime: "2026-11-20", open: 1, high: 1, low: 1, close: 1 }] })[0].t, T("2026-11-20T00:00:00Z"));
  assert.equal(A.parseTimeSeries({ status: "error", code: 401 }), null);
});

test("indicateurs : EMA, RSI, ATR, efficacite, Bollinger, pivots", () => {
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  const e = A.emaSeries(v, 10);
  assert.equal(e[8], null); near(e[9], 5.5); near(e[10], 11 * (2 / 11) + 5.5 * (9 / 11));
  assert.equal(A.rsiSeries(v)[19], 100);
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 1, h: 1.1, l: 0.9, c: 1 }));
  near(A.atr(flat, 14), 0.2);
  near(A.efficiency(v, 10), 1);
  const bb = A.bollinger(Array(20).fill(5)); near(bb.high, 5); near(bb.low, 5);
  const p = A.pivots({ h: 12, l: 8, c: 10 });
  near(p.P, 10); near(p.R1, 12); near(p.S1, 8); near(p.R2, 14); near(p.S2, 6);
});

test("sommets et creux (swings)", () => {
  const prices = [1, 2, 3, 5, 3, 2, 1, 2, 3, 2, 1, 0, 1, 2];
  const bars = prices.map((c, i) => ({ t: i, o: c, h: c, l: c, c }));
  const s = A.swings(bars, 3);
  assert.deepEqual(s.highs.map((x) => x.p), [5, 3]);   // 3 (rang 8) domine aussi ses 3 voisins de chaque cote
  assert.deepEqual(s.lows.map((x) => x.p), [1]);
});

function trendBars(n, startMs, stepMs, start, drift, noise = 0.0003) {
  let c = start, out = [];
  for (let i = 0; i < n; i++) {
    const o = c; c = c + drift + Math.sin(i / 3) * noise;
    out.push({ t: startMs + i * stepMs, o, h: Math.max(o, c) + noise, l: Math.min(o, c) - noise, c });
  }
  return out;
}

test("synthese technique : tendance haussiere, niveaux tries", () => {
  const end = T("2026-11-20T21:00:00Z");
  const d1 = trendBars(300, end - 300 * 86400000, 86400000, 1.0, 0.0004, 0.002);
  const h4 = trendBars(300, end - 300 * 14400000, 14400000, d1[200].c, 0.0003, 0.0008);
  const h1 = trendBars(500, end - 500 * 3600000, 3600000, h4[250].c, 0.0001, 0.0002);
  const r = A.technical("EUR/USD", { h1, h4, d1 });
  assert.ok(!r.error, r.error);
  assert.match(r.bias, /^Haussier/);
  assert.equal(r.tfs.length, 3);
  assert.ok(r.resistances.every((l, i, a) => l.price > r.price && (i === 0 || l.price >= a[i - 1].price)));
  assert.ok(r.supports.every((l, i, a) => l.price < r.price && (i === 0 || l.price <= a[i - 1].price)));
  assert.ok(r.notes.some((n) => n.startsWith("Régime journalier")));
  assert.equal(A.technical("EUR/USD", { h1: h1.slice(0, 10), d1 }).error, "Historique insuffisant pour l'analyse.");
});

test("fondamental : Fed NY, BLS, BCE, Eurostat, anciennete, synthese", () => {
  near(A.parseNyFedEffr({ refRates: [{ effectiveDate: "2026-11-19", percentRate: 3.88 }] }).value, 3.88);
  const bls = { Results: { series: [{ data: [
    { year: "2026", period: "M10", value: "330.0" }, { year: "2026", period: "M09", value: "329.0" },
    { year: "2025", period: "M10", value: "320.0" }, { year: "2025", period: "M13", value: "999" }] }] } };
  const y = A.blsYoY(bls); near(y.value, (330 / 320 - 1) * 100); assert.equal(y.date, "2026-10");
  const gap = { Results: { series: [{ data: [{ year: "2026", period: "M10", value: "337.5" }, { year: "2026", period: "M09", value: "336.9" },
    { year: "2025", period: "M10", value: "-" }, { year: "2025", period: "M09", value: "324.8" }] }] } };
  const g = A.blsYoY(gap);                                 // octobre 2025 manquant -> septembre 2026
  assert.equal(g.date, "2026-09"); near(g.value, (336.9 / 324.8 - 1) * 100);
  assert.deepEqual(A.blsLatest(bls), { value: 330, date: "2026-10" });
  const ecb = { dataSets: [{ series: { "0:0": { observations: { 0: [2.5, 0] } } } }],
    structure: { dimensions: { observation: [{ values: [{ id: "2026-11-21" }] }] } } };
  assert.deepEqual(A.parseEcbSeries(ecb), { value: 2.5, date: "2026-11-21" });
  const es = { dimension: { time: { category: { index: { "2026-09": 0, "2026-10": 1 } } } }, value: { 0: 2.1, 1: 2.2 } };
  assert.deepEqual(A.parseEurostat(es), { value: 2.2, date: "2026-10" });
  const now = T("2026-11-21T12:00:00Z");
  assert.equal(A.ageDays("2026-11-19", now), 2);
  assert.equal(A.ageDays("2026-10", now), 21);
  assert.equal(A.ageDays("2026-Q1", now), 235);
  const s = A.fundamentalSummary({ usdRate: { value: 3.88, date: "2026-11-19" }, eurRate: { value: 2.5, date: "2026-11-21" },
    usdCpi: { value: 3.1, date: "2026-10" }, eurCpi: { value: 1.9, date: "2025-12" }, usdUnemp: { error: "x" } }, now);
  near(s.diff, 1.38);
  assert.ok(s.notes.some((n) => /dollar rémunère davantage/.test(n)));
  assert.deepEqual(s.stale, ["Inflation zone euro"]);
  assert.ok(s.notes.some((n) => /Pas un conseil/.test(n)));
});

test("sessions : chevauchement, week-end, rollover, heure d'ete", () => {
  const w = A.sessionsAt(T("2026-11-18T14:00:00Z"));
  assert.deepEqual(w.sessions.filter((s) => s.open).map((s) => s.name), ["Londres", "New York"]);
  assert.ok(w.notes.some((n) => /Chevauchement/.test(n)));
  assert.equal(A.sessionsAt(T("2026-11-21T12:00:00Z")).weekend, true);
  assert.ok(A.sessionsAt(T("2026-11-18T21:50:00Z")).notes.some((n) => /rollover/.test(n)));   // 16:50 NY
  assert.deepEqual(A.sessionsAt(T("2026-11-18T02:00:00Z")).sessions.filter((s) => s.open).map((s) => s.name), ["Sydney", "Tokyo"]);
  assert.ok(A.sessionsAt(T("2026-07-15T12:30:00Z")).sessions.find((s) => s.name === "New York").open);       // ete : 08:30 NY
});

test("plan de trade : spread compris, lot minimal, week-end, annonces, verdict", () => {
  const base = { pair: "EUR/USD", dir: "buy", entry: 1.085, stop: 1.0837, rr: [2], spreadPips: 1.2, balance: 68,
    riskPct: 2, pipValue: 10, nowMs: T("2026-11-18T10:00:00Z"), news: [] };
  const p1 = A.plan(base);                         // 13 + 1.2 = 14.2 pips -> 0.0096 lot < 0.01
  assert.equal(p1.verdict, "NON");
  assert.equal(p1.size.allowed, false);
  const p2 = A.plan(Object.assign({}, base, { stop: 1.0838 }));   // 12 + 1.2 pips -> 0.01 lot
  assert.equal(p2.size.lots, 0.01);
  near(p2.size.riskUsd, 1.32);
  assert.equal(p2.verdict, "OK");
  near(p2.targets[0].price, 1.085 + 0.0024);
  const p3 = A.plan(Object.assign({}, base, { stop: 1.0838, nowMs: T("2026-11-21T10:00:00Z") }));
  assert.equal(p3.verdict, "NON");
  const p4 = A.plan(Object.assign({}, base, { stop: 1.0838, news: [{ timeMs: T("2026-11-18T11:00:00Z"), currency: "USD", event: "CPI", impact: "high" }] }));
  assert.equal(p4.verdict, "À REVOIR");
  assert.ok(p4.checks.some((c) => /CPI/.test(c.msg)));
  const p5 = A.plan(Object.assign({}, base, { stop: null, stopAtr: 1.5, atr: 0.001, rr: [1] }));
  near(p5.stopPips, 15);
  assert.ok(p5.checks.some((c) => /gain\/risque net/.test(c.msg) && c.level === "ATTENTION"));
  assert.equal(A.plan(Object.assign({}, base, { stop: 1.09 })).error, "stop du mauvais côté du prix d'entrée");
  assert.ok(A.plan(Object.assign({}, base, { stop: 1.0838, pipValue: null })).checks.some((c) => /Valeur du pip inconnue/.test(c.msg)));
});

test("pre-test : cout, taux de reussite minimal, trades necessaires", () => {
  const r = A.pretest({ atrPips: 10, stopAtr: 1.5, rr: 2, spreadPips: 1.5, slippagePips: 0.5, commissionPerLot: 7, pipValuePerLot: 10, winRate: 0.45 });
  near(r.stopPips, 15); near(r.costPips, 2.7); near(r.costR, 0.18);
  near(r.breakeven, 1.18 / 3); near(r.target, 1.72 / 3);
  assert.equal(r.verdict, "DIFFICILE");
  near(r.expectancy, 0.17);
  assert.equal(r.tradesToProve, 309);
  assert.equal(A.pretest({ atrPips: 3, stopAtr: 1, rr: 1, spreadPips: 1.5 }).verdict, "INUTILE DE TESTER");
  assert.equal(A.pretest({ atrPips: 0, stopAtr: 1, rr: 1 }).error, "ATR, multiple de stop et objectif (R) requis.");
});

test("alertes de prix", () => {
  const al = [{ pair: "EUR/USD", side: "above", price: 1.09 }, { pair: "XAU/USD", side: "below", price: 2600 }];
  assert.equal(A.checkAlerts(al, { "EUR/USD": 1.085 }, 1).length, 0);
  const f = A.checkAlerts(al, { "EUR/USD": 1.0905, "XAU/USD": 2650 }, 2);
  assert.equal(f.length, 1);
  assert.equal(al[0].triggered, 2);
  assert.equal(A.checkAlerts(al, { "EUR/USD": 1.2 }, 3).length, 0);   // ne se declenche qu'une fois
});

test("aucun code d'ordre dans l'analyse", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "analysis.js"), "utf8").toLowerCase();
  for (const w of ["metatrader", "oanda", "place_order", "order_send", "create_order", "/order"]) assert.ok(!src.includes(w), w);
});
