// Tests deterministes de l'import MT5 (aucun reseau, aucun MT5). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../mt5-core.js");
const JC = require("../journal-core.js");
const T = (s) => Date.parse(s);

// lignes d'un rapport d'historique MT5 (structure du rapport : Positions, Ordres, Transactions)
const ROWS = [
  ["Trade History Report"],
  ["Name:", "Démo"], ["Account:", "51234567 (USD, Broker-Demo, demo, Hedge)"],
  ["Positions"],
  ["Time", "Position", "Symbol", "Type", "Volume", "Price", "S / L", "T / P", "Time", "Price", "Commission", "Swap", "Profit"],
  ["2026.11.18 16:30:05", "1001", "EURUSD", "buy", "0.10", "1.08500", "1.08370", "1.08760", "2026.11.18 18:02:41", "1.08700", "-0.70", "0.00", "20.00"],
  ["2026.11.19 10:00:00", "1002", "XAUUSD.m", "sell", "0.01", "3 530.00", "", "", "2026.11.19 11:15:00", "3 533.00", "0.00", "-0.20", "-3.00"],
  ["2026.11.19 12:00:00", "1003", "US30", "buy", "1.00", "44 000.0", "", "", "2026.11.19 13:00:00", "44 100.0", "0.00", "0.00", "100.00"],
  ["Orders"],
  ["Open Time", "Order", "Symbol", "Type", "Volume", "Price", "S / L", "T / P", "Time", "State", "Comment"],
  ["2026.11.18 16:30:05", "2001", "EURUSD", "buy", "0.10 / 0.10", "market", "1.08370", "1.08760", "2026.11.18 16:30:05", "filled", ""],
  ["Deals"],
  ["Time", "Deal", "Symbol", "Type", "Direction", "Volume", "Price", "Order", "Commission", "Fee", "Swap", "Profit", "Balance", "Comment"],
  ["2026.11.18 16:30:05", "3001", "EURUSD", "buy", "in", "0.10", "1.08500", "2001", "-0.35", "0.00", "0.00", "0.00", "10 000.00", ""],
];

test("symboles du courtier vers les paires du site", () => {
  assert.equal(M.mapSymbol("EURUSD"), "EUR/USD");
  assert.equal(M.mapSymbol("EURUSDm"), "EUR/USD");
  assert.equal(M.mapSymbol("eurusd.pro"), "EUR/USD");
  assert.equal(M.mapSymbol("XAUUSD.m"), "XAU/USD");
  assert.equal(M.mapSymbol("GOLD"), "XAU/USD");
  assert.equal(M.mapSymbol("SILVERcash"), "XAG/USD");
  assert.equal(M.mapSymbol("US30"), null);
  assert.equal(M.mapSymbol("BTCUSD"), null);
});

test("nombres et heures du serveur MT5", () => {
  assert.equal(M.num("1 234.56"), 1234.56); assert.equal(M.num("-0.70"), -0.7); assert.equal(M.num("1234,5"), 1234.5);
  assert.equal(M.num(""), null); assert.equal(M.num("abc"), null);
  assert.equal(M.parseMt5Time("2026.11.18 16:30:05", 2), T("2026-11-18T14:30:05Z"));   // serveur UTC+2
  assert.equal(M.parseMt5Time("2026.11.18 16:30", 0), T("2026-11-18T16:30:00Z"));
  assert.equal(M.parseMt5Time("pas une date", 2), null);
});

test("rapport MT5 : seules les positions sont lues, colonnes vides conservees", () => {
  const r = M.parseReportRows(ROWS, 2);
  assert.equal(r.login, "51234567"); assert.equal(r.currency, "USD");
  assert.equal(r.positions.length, 3);                       // ordres et transactions ignores
  const [p1, p2] = r.positions;
  assert.deepEqual([p1.ticket, p1.side, p1.volume, p1.openPrice, p1.sl, p1.tp, p1.closePrice, p1.commission, p1.profit],
    ["1001", "buy", 0.1, 1.085, 1.0837, 1.0876, 1.087, 0.7, 20]);
  assert.equal(p1.openTime, T("2026-11-18T14:30:05Z"));
  assert.deepEqual([p2.openPrice, p2.sl, p2.tp, p2.closePrice, p2.swap], [3530, null, null, 3533, -0.2]);
  // rapport en francais
  const fr = M.parseReportRows([["Compte :", "51234567 (USD, Broker-Demo, demo)"],
    ["2026.11.18 16:30:05", "1001", "EURUSD", "achat", "0.10", "1.08500", "1.08370", "", "2026.11.18 18:02:41", "1.08700", "-0.70", "0.00", "20.00"]], 2);
  assert.equal(fr.positions[0].side, "buy"); assert.equal(fr.positions[0].tp, null);
});

test("vers le journal : nouveaux trades, symboles ignores, calculs du journal", () => {
  const r = M.parseReportRows(ROWS, 2);
  const out = M.toTrades(r, "acc1", [], 1000);
  assert.equal(out.created, 2); assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].symbol, "US30");
  const t1 = out.upserts.find((t) => t.ticket === "1001");
  assert.deepEqual([t1.id, t1.accountId, t1.status, t1.symbol, t1.source], ["mt5-51234567-1001", "acc1", "CLOSED", "EUR/USD", "mt5"]);
  const m = JC.enrich([t1], [{ id: "acc1", startBalance: 10000 }], 2)[0].m;
  assert.equal(m.net, 19.3);                                  // 20 de profit - 0,70 de commission
  assert.ok(Math.abs(m.riskUsd - 13) < 1e-9);                 // 13 pips x 10 $ x 0,10 lot
});

test("dedoublonnage par ticket : champs manuels gardes, position ouverte puis close", () => {
  const exportOpen = M.normalizeExport({ app: "desk-forex", kind: "mt5", exportedAt: "2026-11-18T15:00:00Z", serverOffsetHours: 2,
    account: { login: 51234567, currency: "USD", balance: 10000, equity: 10012.5, mode: "demo" },
    positions: [], open: [{ ticket: 1001, symbol: "EURUSD", side: "buy", volume: 0.1, openTime: T("2026-11-18T14:30:05Z"), openPrice: 1.085, sl: 1.0837, tp: 1.0876 }] });
  assert.deepEqual(exportOpen.snapshot, { t: T("2026-11-18T15:00:00Z"), equity: 10012.5, balance: 10000, source: "MT5" });
  const first = M.toTrades(exportOpen, "acc1", [], 1);
  assert.equal(first.upserts[0].status, "OPEN");
  // l'utilisateur complete la fiche
  const edited = Object.assign({}, first.upserts[0], { setup: "SMC", errors: ["FOMO"], notes: "ma note", screenshot: "https://x.y/z", accountId: "acc2" });
  // meme position, close ensuite (rapport)
  const r = M.parseReportRows(ROWS, 2);
  const second = M.toTrades(r, "acc1", [edited], 2);
  const t = second.upserts.find((x) => x.ticket === "1001");
  assert.equal(second.updated, 1);
  assert.deepEqual([t.status, t.exit, t.setup, t.errors, t.notes, t.screenshot, t.accountId], ["CLOSED", 1.087, "SMC", ["FOMO"], "ma note", "https://x.y/z", "acc2"]);
  // reimport identique : rien a mettre a jour
  const third = M.toTrades(r, "acc1", second.upserts.concat([edited]).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).map((x) => (x.id === t.id ? t : x)), 3);
  assert.equal(third.upserts.filter((x) => x.ticket === "1001").length, 0);
  // une position close ne redevient jamais ouverte
  assert.equal(M.toTrades(exportOpen, "acc1", [t], 4).upserts.length, 0);
});

test("export du script : verification et compte lie au login", () => {
  assert.throws(() => M.normalizeExport({ app: "autre" }), /pas un export MT5/);
  const accounts = [{ id: "a", mt5Login: "51234567" }, { id: "b" }];
  assert.equal(M.accountForLogin(accounts, "51234567").id, "a");
  assert.equal(M.accountForLogin(accounts, "999"), null);
  assert.equal(M.accountForLogin(accounts, null), null);
});

test("aucun appel d'ordre dans l'import", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "mt5-core.js"), "utf8").toLowerCase();
  for (const w of ["order_send", "order_check", "place_order", "create_order", "/order"]) assert.ok(!src.includes(w), w);
});
