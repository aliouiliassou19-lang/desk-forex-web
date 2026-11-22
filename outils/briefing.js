#!/usr/bin/env node
/* Desk Forex : briefing IA du matin (lance par .github/workflows/briefing.yml, lundi-vendredi 7 h heure du Benin).
 *
 * 1. Bougies H1, H4 et D1 de XAU/USD et EUR/USD (Twelve Data, secret TWELVEDATA_API_KEY ; 6 credits par jour).
 * 2. Memes calculs que le site (analysis.js) : tendance, ATR, niveaux cles ; annonces du jour (data/annonces.json).
 * 3. Briefing automatique par regles (discipline-core.js), toujours present.
 * 4. Briefing de 5 lignes par paire ecrit par Claude (secret ANTHROPIC_API_KEY), controle : jamais de conseil
 *    d'achat ou de vente. Si l'appel echoue, seul le briefing automatique est garde.
 * Ecrit data/briefing.json. Aucune cle n'est ecrite dans le fichier ni dans le journal du workflow.
 * Usage : node outils/briefing.js --out data
 */
"use strict";
const fs = require("fs");
const path = require("path");
const A = require("../analysis.js");
const DC = require("../discipline-core.js");
const AC = require("../annonces-core.js");
const F = require("../fmt.js");

const PAIRS = DC.BRIEF_PAIRS;                                 // ["XAU/USD", "EUR/USD"]
const SERIES = [["h1", "1h", 500], ["h4", "4h", 300], ["d1", "1day", 300]];
const TD_URL = "https://api.twelvedata.com/time_series";
const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const PRICE = { input: 4 / 1e6, output: 20 / 1e6 };           // dollars par token (Claude Opus 5.5)
const FIELDS = ["tendance", "niveaux", "annonces", "scenarios", "prudence"];
const BANNED = /\b(ach[eè]te[rz]?|achetez|vends|vendez|vendre|prends? (une )?position|ouvre (un|une) (achat|vente)|buy|sell)\b|garanti|sans risque|gain assur/i;
const SCHEMA = 1;

// ------------------------------------------------------------------ prix (Twelve Data)
/** Masque la cle dans un message d'erreur (elle ne doit jamais apparaitre dans le journal). */
const scrub = (msg, key) => (key ? String(msg).split(key).join("***") : String(msg));

async function fetchSeries(pair, key, fetchFn = fetch) {
  const series = {};
  for (const [k, interval, size] of SERIES) {
    const qs = new URLSearchParams({ symbol: pair, interval, outputsize: String(size), timezone: "UTC", apikey: key });
    let payload;
    try {
      const r = await fetchFn(`${TD_URL}?${qs}`, { headers: { "User-Agent": "desk-forex-briefing/1.0" } });
      payload = await r.json();
    } catch (e) {
      throw new Error(`Twelve Data ${interval} : ${scrub(e.message, key)}`);
    }
    const bars = A.parseTimeSeries(payload);
    if (!bars || !bars.length) throw new Error(`Twelve Data ${interval} : ${scrub((payload && payload.message) || "réponse vide", key).slice(0, 160)}`);
    series[k] = bars;
  }
  return series;
}

// ------------------------------------------------------------------ faits envoyes a Claude
const pairCcys = (pair) => (pair.startsWith("XA") ? ["USD"] : pair.split("/"));
/** Annonces du jour (heure du Benin), fortes et moyennes, des devises de la paire. */
function newsForPair(pair, news, nowMs) {
  const day = AC.dayKey(nowMs), ccy = new Set(pairCcys(pair));
  return (news || []).filter((e) => ccy.has(e.currency) && AC.dayKey(e.timeMs) === day).sort((a, b) => a.timeMs - b.timeMs);
}

function facts(pair, tech, news) {
  const tf = (k) => (tech.tfs || []).find((t) => t.tf === k) || {};
  const r = (x) => (x == null ? null : +x.toFixed(tech.dec));
  const unit = pair.startsWith("XAU") ? "$" : "pips";
  const atr = (t) => (t.atr == null ? null : pair.startsWith("XAU") ? +t.atr.toFixed(2) : Math.round(t.atrPips));
  return {
    paire: pair, prix: r(tech.price),
    tendance: { D1: tf("D1").trend || null, H4: tf("H4").trend || null, H1: tf("H1").trend || null },
    atr: { unite: unit, H4: atr(tf("H4")), H1: atr(tf("H1")) },
    resistances: (tech.resistances || []).slice(0, 3).map((l) => ({ prix: r(l.price), nom: l.label })),
    supports: (tech.supports || []).slice(0, 3).map((l) => ({ prix: r(l.price), nom: l.label })),
    remarques: (tech.notes || []).slice(0, 3),
    annonces_du_jour: news.map((e) => ({ heure_benin: F.benin(e.timeMs), devise: e.currency, nom: e.event, impact: e.impact === "high" ? "fort" : "moyen" })),
  };
}

// ------------------------------------------------------------------ Claude
const SYSTEM =
  "Tu écris le briefing du matin d'un site éducatif de forex pour un trader débutant francophone (Bénin). " +
  "À partir des faits fournis (en JSON) pour une paire, écris cinq champs très courts, en français simple, en tutoyant, sans jargon " +
  "(si un mot technique est inévitable, explique-le en quelques mots) :\n" +
  "- tendance : la tendance en H4 et en H1, en une phrase ;\n" +
  "- niveaux : les niveaux à surveiller (résistance et support les plus proches, avec leurs prix exacts tirés des faits), et l'ATR pour donner l'ordre de grandeur des mouvements ;\n" +
  "- annonces : les annonces du jour pour cette paire avec leur heure du Bénin, ou dis qu'il n'y en a pas ;\n" +
  "- scenarios : deux scénarios possibles au conditionnel, du type « si le prix casse X, il pourrait aller vers Y ; s'il rebondit sur Z… », avec les prix des faits ;\n" +
  "- prudence : un rappel de prudence (pas de trade 15 min avant et après une annonce forte, risque limité, ce ne sont que des scénarios).\n" +
  "Règles : contenu éducatif uniquement. Décris ce qui pourrait se passer, jamais ce qu'il faut faire : ne dis jamais d'acheter, " +
  "de vendre, d'entrer ou de prendre position, ne promets aucun gain. N'invente aucun chiffre : utilise seulement les prix et heures fournis. " +
  "Écris les nombres à la française (virgule décimale). Chaque champ fait au plus 280 caractères.";

const OUT_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FIELDS.map((k) => [k, { type: "string" }])),
  required: FIELDS,
  additionalProperties: false,
};

function validate(data) {
  if (!data || typeof data !== "object") return null;
  const out = {};
  for (const k of FIELDS) {
    const v = String(data[k] == null ? "" : data[k]).replace(/\s+/g, " ").trim();
    if (v.length < 10 || v.length > 400 || BANNED.test(v)) return null;
    out[k] = v;
  }
  if (!/15/.test(out.prudence)) out.prudence += " Pas de nouveau trade 15 min avant et après une annonce forte.";
  return out;
}

/** -> {fields|null, usage, error|null} */
async function askClaude(client, f) {
  const params = {
    model: MODEL, max_tokens: 4000, system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: OUT_SCHEMA } },
    messages: [{ role: "user", content: "Faits du jour :\n" + JSON.stringify(f, null, 1) }],
  };
  let resp;
  try {
    try {      // repli cote serveur sur un autre modele en cas de refus (beta)
      resp = await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    } catch (e) {
      if (e && e.status === 400) resp = await client.messages.create(params);   // option non acceptee : appel normal
      else throw e;
    }
  } catch (e) {
    return { fields: null, usage: null, error: `${(e && e.name) || "Erreur"} : ${String((e && e.message) || e).slice(0, 160)}` };
  }
  const usage = resp.usage ? { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 } : null;
  if (resp.stop_reason === "refusal") return { fields: null, usage, error: "refus du modèle" };
  const block = (resp.content || []).find((b) => b.type === "text");
  let fields = null;
  try { fields = validate(JSON.parse(block ? block.text : "")); } catch (e) { fields = null; }
  return fields ? { fields, usage, error: null } : { fields: null, usage, error: "réponse invalide ou contraire aux règles éducatives" };
}

function makeClient(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return { client: null, why: "pas de clé ANTHROPIC_API_KEY : briefing automatique seulement" };
  let mod;
  try { mod = require("@anthropic-ai/sdk"); } catch (e) { return { client: null, why: "SDK @anthropic-ai/sdk absent : briefing automatique seulement" }; }
  const Anthropic = mod.default || mod.Anthropic || mod;
  return { client: new Anthropic({ timeout: 60000, maxRetries: 2 }), why: null };
}

// ------------------------------------------------------------------ assemblage
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function readNews(outDir) {
  try { return AC.toMonitor(AC.normalizeWeek(JSON.parse(fs.readFileSync(path.join(outDir, "annonces.json"), "utf8"))).events); }
  catch (e) { return []; }
}

/**
 * Construit le briefing. deps : {tdKey, fetchFn, client, nowMs, news}
 * -> document data/briefing.json
 */
async function build(deps) {
  const now = deps.nowMs, errors = [], usage = { input: 0, output: 0 };
  const pairs = [];
  for (const pair of PAIRS) {
    const news = newsForPair(pair, deps.news, now);
    let tech = null;
    if (deps.tdKey) {
      try {
        tech = A.technical(pair, await fetchSeries(pair, deps.tdKey, deps.fetchFn));
        if (tech.error) { errors.push(`${pair} : ${tech.error}`); tech = null; }
      } catch (e) { errors.push(`${pair} : ${e.message}`); }
    } else if (!pairs.length) errors.push("pas de clé TWELVEDATA_API_KEY : pas de prix, seulement les annonces");
    const rules = DC.briefLines(pair, tech, news, now);
    const item = {
      pair, price: tech ? tech.price : null, dec: tech ? tech.dec : null, candleTime: tech ? iso(tech.time) : null,
      trendDir: rules.trendDir || null,
      atr: tech ? facts(pair, tech, news).atr : null,
      resistances: tech ? (tech.resistances || []).slice(0, 3).map((l) => ({ price: l.price, label: l.label })) : [],
      supports: tech ? (tech.supports || []).slice(0, 3).map((l) => ({ price: l.price, label: l.label })) : [],
      news: news.map((e) => ({ time: iso(e.timeMs), currency: e.currency, event: e.event, impact: e.impact })),
      rules: { trend: rules.trend, levels: rules.levels, news: rules.news },
      ai: null,
    };
    if (tech && deps.client) {
      const r = await askClaude(deps.client, facts(pair, tech, news));
      if (r.usage) { usage.input += r.usage.input; usage.output += r.usage.output; }
      if (r.fields) item.ai = r.fields;
      else errors.push(`${pair} : briefing IA non obtenu (${r.error}), briefing automatique gardé`);
    }
    pairs.push(item);
  }
  const ai = pairs.some((p) => p.ai);
  return {
    schema: SCHEMA, generatedAt: iso(now), day: AC.dayKey(now), source: ai ? "claude" : "regles", model: ai ? MODEL : null,
    usage, costUsd: +(usage.input * PRICE.input + usage.output * PRICE.output).toFixed(4),
    errors, pairs,
  };
}

function parseArgs(argv) {
  const a = { out: "data", now: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--now") a.now = argv[++i];
  }
  return a;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const a = parseArgs(argv);
  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  const outDir = path.resolve(a.out);
  const { client, why } = makeClient(env);
  if (why) console.log("Briefing IA :", why);
  const doc = await build({ tdKey: env.TWELVEDATA_API_KEY || "", fetchFn: fetch, client, nowMs, news: readNews(outDir) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "briefing.json"), JSON.stringify(doc, null, 1) + "\n", "utf8");
  for (const p of doc.pairs) {
    console.log(`${p.pair} : prix ${p.price == null ? "indisponible" : F.num(p.price, p.dec)} | ${p.ai ? "briefing IA" : "briefing automatique"} | annonces du jour : ${p.news.length}`);
  }
  console.log(`Source : ${doc.source} | tokens : ${doc.usage.input} entrée, ${doc.usage.output} sortie | coût estimé : ${doc.costUsd} $`);
  doc.errors.forEach((e) => console.log("Avertissement :", e));
  return doc;
}

if (require.main === module) {
  main().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
}

module.exports = { PAIRS, FIELDS, SYSTEM, BANNED, scrub, fetchSeries, newsForPair, facts, validate, askClaude, makeClient, build, main };
