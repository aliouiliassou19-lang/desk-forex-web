// Tests deterministes du moteur (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../rules.js");

const cfg = R.clone(R.DEFAULTS);
const T = (s) => Date.parse(s);
const WED = T("2026-11-18T13:00:00Z");
const base = (o = {}) => R.decide(Object.assign({ price: 1.08, marketOpen: true, stale: false, newsNear: false,
  spreadPips: 1.2, spreadStatus: "ASSUMED", maxSpreadPips: 3, controlDevPct: 0.1, maxControlDevPct: 1.5,
  move5mPips: 2, watchThresholdPips: 15 }, o));

test("donnees perimees, absentes ou dans le futur", () => {
  assert.equal(R.isStale(WED - 30000, WED, 180), false);
  assert.equal(R.isStale(WED - 600000, WED, 180), true);
  assert.equal(R.isStale(null, WED, 180), true);
  assert.equal(R.isStale(WED + 600000, WED, 180), true);
  // marche ouvert : une donnee perimee ne peut pas etre evaluee -> DATA_MISSING
  assert.deepEqual(base({ stale: true, move5mPips: 40 }), { decision: "DATA_MISSING", reasons: ["STALE_DATA"] });
  // marche ferme : prix fige normal -> REJECT (pas d'alerte le week-end)
  assert.deepEqual(base({ stale: true, marketOpen: false }), { decision: "REJECT", reasons: ["MARKET_CLOSED", "STALE_DATA"] });
});

test("pause WATCH par paire : un seul WATCH par mouvement", () => {
  const run = (cooldown) => {
    const c = R.withSettings(R.DEFAULTS, { watchCooldownMin: { "EUR/USD": cooldown, "XAU/USD": 10 } });
    const st = R.newEngineState(c);
    const prices = [1.08, 1.08, 1.08, 1.08, 1.08, 1.08, 1.082, 1.0825, 1.083, 1.083, 1.083, 1.083, 1.083, 1.083, 1.083, 1.083, 1.0855];
    return prices.map((p, i) => R.evaluate(st, { symbol: "EUR/USD", price: p, sourceMs: WED + i * 60000 - 5000, source: "SYNTHETIC" },
      WED + i * 60000, c, [], {}));
  };
  const rows = run(10);
  const watch = rows.filter((r) => r.decision === "WATCH").map((r) => r.fetched_at_utc.slice(11, 16));
  assert.deepEqual(watch, ["13:06", "13:16"]);           // 1er mouvement, puis nouveau mouvement apres 10 min
  assert.match(rows[7].reasons, /^WATCH_ALREADY_SIGNALED_13:06$/);
  assert.equal(rows[7].decision, "NO_ALERT");
  assert.ok(run(0).filter((r) => r.decision === "WATCH").length >= 4);   // pause 0 = chaque minute
});

test("reglages : pip de l'or, montants en $ conserves ; prix de depart de la demo", () => {
  const c = R.withSettings(R.DEFAULTS, { xauPipUsd: 0.01 });
  const x = c.symbols["XAU/USD"];
  assert.deepEqual([x.pipSize, x.pipValuePerLot, x.watchMove5mPips, x.assumedSpreadPips, x.maxSpreadPips], [0.01, 1, 300, 30, 80]);
  const d = R.withSettings(R.DEFAULTS, {}).symbols["XAU/USD"];
  assert.deepEqual([d.pipSize, d.pipValuePerLot, d.watchMove5mPips], [0.1, 10, 30]);
  assert.equal(R.withSettings(R.DEFAULTS, { xauPipUsd: 0.5 }).symbols["XAU/USD"].pipSize, 0.1);   // valeur refusee
  // 1 lot d'or, stop de 3 $ : risque identique quel que soit le pip choisi
  for (const pip of [0.01, 0.1, 1]) {
    const s = R.withSettings(R.DEFAULTS, { xauPipUsd: pip }).symbols["XAU/USD"];
    assert.ok(Math.abs((3 / s.pipSize) * s.pipValuePerLot - 300) < 1e-9);
  }
  const p = R.demoStartPrices({ demoStart: { "EUR/USD": null, "XAU/USD": 3600 } }, { "EUR/USD": 1.0968 });
  assert.deepEqual(p["XAU/USD"], { price: 3600, source: "réglage" });
  assert.deepEqual(p["EUR/USD"], { price: 1.0968, source: "dernier prix réel connu" });
  assert.deepEqual(R.demoStartPrices({}, {})["XAU/USD"], { price: R.DEMO_FALLBACK["XAU/USD"], source: "valeur par défaut" });
  const st = R.newEngineState(cfg), feed = R.SyntheticFeed(cfg, 42, { "XAU/USD": 3532.8 });
  const first = feed.step(0, WED).find((o) => o.symbol === "XAU/USD");
  assert.ok(Math.abs(first.price - 3532.8) < 5, "la demo part du prix demande");
});

test("bid/ask manquant -> spread ASSUMED ; croise -> REJECT", () => {
  const sc = cfg.symbols["EUR/USD"];
  assert.deepEqual(R.computeSpread(null, null, sc), { pips: 1.2, status: "ASSUMED" });
  assert.equal(R.checkBidAsk(1.0852, 1.085), "CROSSED");
  const sp = R.computeSpread(1.0852, 1.085, sc);
  assert.equal(sp.status, "INVALID_CROSSED");
  assert.equal(base({ spreadPips: null, spreadStatus: sp.status }).reasons[0], "BID_ASK_CROSSED");
  assert.ok(Math.abs(R.computeSpread(1.085, 1.08512, sc).pips - 1.2) < 1e-6);
  const obs = R.quoteToObservation("EUR/USD", { close: "1.085", timestamp: 1763470800, bid: "1", ask: "2" });
  assert.equal(obs.bid, null);
  assert.equal(obs.ask, null);
});

test("heures de marche (New York, heure d'hiver et d'ete)", () => {
  assert.equal(R.marketStatus(T("2026-11-21T12:00:00Z"), "EUR/USD"), "MARKET_CLOSED"); // samedi
  assert.equal(R.marketStatus(T("2026-11-20T21:59:00Z"), "EUR/USD"), "OPEN");          // ven 16:59 NY
  assert.equal(R.marketStatus(T("2026-11-20T22:00:00Z"), "EUR/USD"), "MARKET_CLOSED"); // ven 17:00 NY
  assert.equal(R.marketStatus(T("2026-11-22T21:59:00Z"), "EUR/USD"), "MARKET_CLOSED"); // dim 16:59 NY
  assert.equal(R.marketStatus(T("2026-11-22T22:00:00Z"), "EUR/USD"), "OPEN");          // dim 17:00 NY
  assert.equal(R.marketStatus(T("2026-07-03T21:00:00Z"), "EUR/USD"), "MARKET_CLOSED"); // ete : ven 17:00 NY = 21:00 UTC
  assert.equal(R.marketStatus(T("2026-07-03T20:59:00Z"), "EUR/USD"), "OPEN");
  assert.equal(R.marketStatus(T("2026-11-18T22:30:00Z"), "XAU/USD"), "MARKET_CLOSED"); // pause de l'or
  assert.equal(R.marketStatus(T("2026-11-18T22:30:00Z"), "EUR/USD"), "OPEN");
  assert.equal(R.marketStatus(T("2026-11-22T22:30:00Z"), "XAU/USD"), "MARKET_CLOSED"); // or rouvre a 18:00 NY
});

test("le week-end ne produit jamais de WATCH", () => {
  const st = R.newEngineState(cfg);
  const sat = T("2026-11-21T12:00:00Z");
  const rows = [1.08, 1.081, 1.082, 1.083, 1.084, 1.085].map((p, i) => R.evaluate(st,
    { symbol: "EUR/USD", price: p, sourceMs: sat + i * 60000 - 5000, source: "SYNTHETIC" }, sat + i * 60000, cfg, [], {}));
  assert.ok(rows.every((r) => r.market_status === "MARKET_CLOSED"));
  assert.ok(!rows.some((r) => r.decision === "WATCH"));
});

test("fenetre d'annonce, avant et apres, par devise", () => {
  const ev = [{ timeMs: T("2026-11-18T13:30:00Z"), currency: "USD", event: "NFP" }];
  assert.equal(R.newsProximity(WED + 20 * 60000, ["USD"], ev, 15).near, true);
  assert.match(R.newsProximity(WED + 40 * 60000, ["USD"], ev, 15).label, /T\+10min/);
  assert.equal(R.newsProximity(WED, ["USD"], ev, 15).near, false);
  assert.equal(R.newsProximity(WED + 25 * 60000, ["EUR"], ev, 15).near, false);
  assert.equal(base({ newsNear: true, move5mPips: 50 }).reasons[0], "NEWS_WINDOW");
});

test("import CSV des annonces (UTC obligatoire)", () => {
  const { events, errors } = R.parseNewsCsv("datetime_utc,currency,event,impact\n2026-11-25T13:30:00Z,usd,PCE,high\n\n2026-11-25 13:30,USD,X,high\nmauvais\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].currency, "USD");
  assert.equal(errors.length, 2);
});

test("quota : limite par minute et par jour, remise a zero a minuit UTC", () => {
  const mem = {}; const storage = { get: (k) => mem[k], set: (k, v) => (mem[k] = JSON.parse(JSON.stringify(v))) };
  const c = R.CreditTracker(storage, 8, 10);
  c.spend(8, WED);
  assert.equal(c.check(2, WED + 30000), "MINUTE");
  assert.equal(c.check(2, WED + 61000), "OK");
  c.spend(2, WED + 61000);
  assert.equal(c.check(2, WED + 120000), "DAILY");
  assert.equal(R.CreditTracker(storage, 8, 10).usedToday(WED + 3600000), 10);  // persistant
  assert.equal(R.CreditTracker(storage, 8, 10).usedToday(WED + 86400000), 0);  // jour suivant
  assert.equal(R.apiError({ status: "error", code: 429, message: "x" }).kind, "QUOTA");
  assert.equal(R.apiError({ status: "error", code: 401 }).kind, "AUTH");
  assert.equal(R.apiError({ symbol: "EUR/USD" }), null);
});

test("taille de position et limite de risque (68 $, 2 %)", () => {
  assert.deepEqual(R.positionSize(68, 2, 13, 10), { allowed: true, lots: 0.01, riskUsd: 1.3, riskPct: 1.91, reason: "OK" });
  const g = R.positionSize(68, 2, 30, 10);
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "MIN_LOT_EXCEEDS_RISK_LIMIT");
  assert.equal(R.positionSize(1000, 2, 15, 10).lots, 0.13);
  assert.equal(R.positionSize(1000, 2, 20, 10).riskUsd, 20);
  assert.equal(R.positionSize(68, 2, 0, 10).allowed, false);
  assert.equal(R.riskWithinLimit(68, 1.36, 2), true);
  assert.equal(R.riskWithinLimit(68, 1.37, 2), false);
});

test("journal papier : stop obligatoire, risque max 2 %, P&L seulement si sortie observee", () => {
  const ok = R.paperTradeCalc({ symbol: "EUR/USD", side: "buy", entry: "1.08500", stop: "1.08370", lots: "0.01",
    exit: "1.08700", costs: "0.10", status: "CLOSED" }, cfg, 68);
  assert.deepEqual([ok.stopPips, ok.riskUsd, ok.pnl, ok.errors.length], [13, 1.3, 1.9, 0]);
  const open = R.paperTradeCalc({ symbol: "EUR/USD", side: "buy", entry: "1.085", stop: "1.0837", lots: "0.01", status: "CLOSED" }, cfg, 68);
  assert.equal(open.pnl, null);
  assert.match(open.errors[0], /sortie non observée/);
  assert.match(R.paperTradeCalc({ symbol: "EUR/USD", side: "buy", entry: "1.085", lots: "0.01", status: "OPEN" }, cfg, 68).errors.join(), /stop-loss obligatoire/);
  assert.match(R.paperTradeCalc({ symbol: "XAU/USD", side: "buy", entry: "2650", stop: "2647", lots: "0.01", status: "OPEN" }, cfg, 68).errors.join(), /supérieur à 2 %/);
  assert.match(R.paperTradeCalc({ symbol: "EUR/USD", side: "sell", entry: "1.085", stop: "1.080", lots: "0.01", status: "OPEN" }, cfg, 68).errors.join(), /mauvais côté/);
  const sell = R.paperTradeCalc({ symbol: "EUR/USD", side: "sell", entry: "1.0850", stop: "1.0863", lots: "0.01", exit: "1.0840", status: "CLOSED" }, cfg, 68);
  assert.equal(sell.pnl, 1);
  assert.equal(R.paperTradeCalc({ symbol: "EUR/USD", side: "buy", status: "REJECT" }, cfg, 68).errors.length, 0);
});

test("decisions : WATCH, NO_ALERT, spread, controle, donnee manquante, jamais BUY/SELL", () => {
  assert.equal(base({ move5mPips: -16 }).decision, "WATCH");
  assert.equal(base().decision, "NO_ALERT");
  assert.deepEqual(base({ spreadPips: 4, spreadStatus: "OBSERVED" }).reasons, ["SPREAD_TOO_WIDE"]);
  assert.deepEqual(base({ controlDevPct: 2.5 }).reasons, ["PRICE_FAR_FROM_CONTROL"]);
  assert.deepEqual(base({ price: null, missingReason: "QUOTA" }), { decision: "DATA_MISSING", reasons: ["QUOTA"] });
  for (const o of [{}, { move5mPips: 99 }, { move5mPips: -99 }, { price: null }]) assert.ok(R.DECISIONS.includes(base(o).decision));
});

test("reponses Twelve Data groupees ou simples ; BCE", () => {
  const q = R.parseQuotePayload({ "EUR/USD": { symbol: "EUR/USD", close: "1.1" }, "XAU/USD": { status: "error", code: 400 } }, ["EUR/USD", "XAU/USD"]);
  assert.equal(q["EUR/USD"].close, "1.1");
  assert.equal(R.quoteToObservation("XAU/USD", q["XAU/USD"]).missingReason, "API_ERROR_400");
  assert.equal(R.parseQuotePayload({ symbol: "EUR/USD", close: "1" }, ["EUR/USD", "XAU/USD"])["XAU/USD"], null);
  const o = R.quoteToObservation("EUR/USD", { close: "1.1", timestamp: 1000, last_quote_at: 2000, is_market_open: true });
  assert.equal(o.sourceMs, 2000000);
  assert.equal(R.quoteToObservation("EUR/USD", { close: "" }).price, null);
  const ecb = { dataSets: [{ series: { "0:0:0:0:0": { observations: { 0: [1.099, 0] } } } }],
    structure: { dimensions: { observation: [{ values: [{ id: "2026-11-20" }] }] } } };
  assert.deepEqual(R.parseEcbJson(ecb), { price: 1.099, date: "2026-11-20" });
});

test("demo synthetique deterministe : WATCH, REJECT et DATA_MISSING", () => {
  const run = () => {
    const st = R.newEngineState(cfg), feed = R.SyntheticFeed(cfg, 42), rows = [];
    const news = [{ timeMs: T("2026-11-18T13:40:00Z"), currency: "USD", event: "EXEMPLE" }];
    for (let i = 0; i < 30; i++) for (const ob of feed.step(i, WED + i * 60000)) rows.push(R.evaluate(st, ob, WED + i * 60000, cfg, news, {}, { mode: "demo" }));
    return rows;
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
  const d = new Set(a.map((r) => r.decision));
  for (const k of ["WATCH", "REJECT", "DATA_MISSING"]) assert.ok(d.has(k), k);
  assert.ok(a.every((r) => r.source === "SYNTHETIC" && r.spread_status === "ASSUMED"));
  // les deux anomalies annoncees en demo sont bien en DATA_MISSING dans le journal
  const xauMissing = a.filter((r) => r.symbol === "XAU/USD" && r.decision === "DATA_MISSING");
  assert.deepEqual(xauMissing.map((r) => [r.fetched_at_utc.slice(11, 16), r.reasons]),
    [["13:15", "STALE_DATA"], ["13:18", "SYNTHETIC_MISSING_TICK"]]);
  // un seul WATCH pour le mouvement brusque injecte sur EUR/USD (minutes 4 a 6)
  assert.equal(a.filter((r) => r.symbol === "EUR/USD" && r.decision === "WATCH").length, 1);
});

test("CSV : protection contre les formules", () => {
  assert.equal(R.csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(R.csvCell("-0.2"), "-0.2");
  assert.equal(R.csvCell("-cmd"), "'-cmd");
  assert.equal(R.csvCell('a,"b"'), '"a,""b"""');
  assert.match(R.toCsv([{ a: 1, b: "x" }], ["a", "b"]), /^a,b\r\n1,x\r\n$/);
});

test("aucun code d'ordre dans le site", () => {
  const fs = require("node:fs"), path = require("node:path");
  for (const f of ["rules.js", "app.js", "index.html"]) {
    const p = path.join(__dirname, "..", f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8").toLowerCase();
    for (const w of ["metatrader", "oanda", "place_order", "order_send", "create_order", "/order"]) assert.ok(!src.includes(w), `${f}: ${w}`);
  }
});
