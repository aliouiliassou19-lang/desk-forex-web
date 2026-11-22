// Tests du briefing IA du matin : faux prix, faux Claude (aucun appel reel, aucune cle reelle).
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../outils/briefing.js");

const NOW = Date.parse("2026-11-25T06:00:00Z");              // mercredi 7 h au Benin
const KEY = "FAKEKEY123";

// bougies synthetiques en hausse reguliere (format Twelve Data : ordre decroissant)
function payload(start, step, n, minutes) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - i) * minutes * 60000, c = start + i * step + Math.sin(i / 3) * step * 4;
    values.push({ datetime: new Date(t).toISOString().slice(0, 19).replace("T", " "), open: c - step, high: c + step * 3, low: c - step * 3, close: c });
  }
  return { status: "ok", values: values.reverse() };
}
function fakeFetch(calls, fail) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url), sym = u.searchParams.get("symbol"), iv = u.searchParams.get("interval");
    if (fail && fail(sym, iv)) return { json: async () => ({ status: "error", message: `quota dépassé pour apikey=${KEY}` }) };
    const gold = sym === "XAU/USD";
    const minutes = iv === "1h" ? 60 : iv === "4h" ? 240 : 1440;
    return { json: async () => payload(gold ? 2400 : 1.05, gold ? 0.8 : 0.0001, 320, minutes) };
  };
}
const GOOD = {
  tendance: "La tendance est haussière en H4 et en H1 : les prix montent depuis plusieurs jours.",
  niveaux: "Résistance proche vers 2 660,00 et support vers 2 640,00 ; l'ATR H1 est d'environ 5 $.",
  annonces: "Inflation PCE américaine à 14:30 (heure du Bénin), annonce forte.",
  scenarios: "Si le prix casse 2 660,00, il pourrait aller vers le niveau suivant ; s'il revient sous 2 640,00, la hausse pourrait ralentir.",
  prudence: "Pas de trade de 14:15 à 14:45 ; ce ne sont que des scénarios, garde un risque limité.",
};
function fakeClient(o = {}) {
  const calls = [];
  const create = async (p) => {
    calls.push(p);
    if (o.fail) throw Object.assign(new Error("Connection error"), { name: "APIConnectionError" });
    return { stop_reason: o.stop || "end_turn", usage: { input_tokens: 900, output_tokens: 400 },
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload || GOOD) }] };
  };
  return { calls, beta: { messages: { create } }, messages: { create } };
}
const NEWS = [
  { timeMs: Date.parse("2026-11-25T13:30:00Z"), currency: "USD", event: "Core PCE Price Index m/m", impact: "high" },
  { timeMs: Date.parse("2026-11-25T09:00:00Z"), currency: "EUR", event: "German ifo", impact: "medium" },
  { timeMs: Date.parse("2026-11-26T13:30:00Z"), currency: "USD", event: "Demain", impact: "high" },
];

test("briefing complet avec Claude : 5 champs, cout, cle jamais ecrite", async () => {
  const calls = [], cl = fakeClient();
  const doc = await B.build({ tdKey: KEY, fetchFn: fakeFetch(calls), client: cl, nowMs: NOW, news: NEWS });
  assert.equal(calls.length, 6);                                   // 2 paires x (H1, H4, D1)
  assert.equal(doc.source, "claude");
  assert.equal(doc.model, "claude-opus-5-5");
  assert.equal(doc.day, "2026-11-25");
  assert.deepEqual(doc.pairs.map((p) => p.pair), ["XAU/USD", "EUR/USD"]);
  const gold = doc.pairs[0];
  assert.deepEqual(Object.keys(gold.ai), B.FIELDS);
  assert.ok(gold.price > 2400 && gold.supports.length && gold.resistances.length);
  assert.equal(gold.trendDir, "up");
  assert.deepEqual(gold.news.map((n) => n.event), ["Core PCE Price Index m/m"]);           // or : USD seulement, aujourd'hui
  assert.deepEqual(doc.pairs[1].news.map((n) => n.event), ["German ifo", "Core PCE Price Index m/m"]);
  assert.match(gold.rules.trend, /haussière/);
  assert.deepEqual(doc.usage, { input: 1800, output: 800 });
  assert.equal(doc.costUsd, 0.0232);
  // la requete : modele, sortie JSON, faits sans cle
  const p = cl.calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal(p.fallbacks, "default");
  assert.match(p.messages[0].content, /14:30/);
  assert.doesNotMatch(JSON.stringify(cl.calls) + JSON.stringify(doc), new RegExp(KEY));
});

test("sans cle Claude ou si Claude echoue : briefing automatique garde", async () => {
  for (const client of [null, fakeClient({ fail: true }), fakeClient({ stop: "refusal" }), fakeClient({ payload: "pas du json" }),
    fakeClient({ payload: { ...GOOD, scenarios: "Achète si le prix casse 2 660, gain assuré." } })]) {
    const doc = await B.build({ tdKey: KEY, fetchFn: fakeFetch([]), client, nowMs: NOW, news: NEWS });
    assert.equal(doc.source, "regles");
    assert.ok(doc.pairs.every((p) => p.ai === null && p.rules.trend && p.rules.levels));
    if (client) assert.equal(doc.errors.length, 2);
  }
});

test("prix indisponibles : annonces seulement, cle masquee dans l'erreur", async () => {
  const doc = await B.build({ tdKey: KEY, fetchFn: fakeFetch([], (sym) => sym === "EUR/USD"), client: fakeClient(), nowMs: NOW, news: NEWS });
  assert.ok(doc.pairs[0].ai);
  assert.equal(doc.pairs[1].ai, null);
  assert.equal(doc.pairs[1].price, null);
  assert.match(doc.pairs[1].rules.news, /Core PCE/);
  assert.ok(doc.errors[0].includes("***") && !doc.errors[0].includes(KEY));
  const none = await B.build({ tdKey: "", fetchFn: fakeFetch([]), client: fakeClient(), nowMs: NOW, news: [] });
  assert.equal(none.source, "regles");
  assert.match(none.errors[0], /TWELVEDATA_API_KEY/);
});

test("controle des reponses et faits envoyes", () => {
  assert.equal(B.validate({ ...GOOD, tendance: "court" }), null);
  assert.equal(B.validate({ ...GOOD, niveaux: "Vends sous 2 640." }), null);
  assert.match(B.validate({ ...GOOD, prudence: "Garde un risque limité, ce sont des scénarios." }).prudence, /15 min/);
  assert.equal(B.scrub("x apikey=ABC y", "ABC"), "x apikey=*** y");
  assert.deepEqual(B.newsForPair("XAU/USD", NEWS, NOW).map((e) => e.currency), ["USD"]);
  assert.equal(B.makeClient({}).client, null);
});
