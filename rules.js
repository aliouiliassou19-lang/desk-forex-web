/* Desk forex web : moteur de regles (LECTURE SEULE, aucun ordre).
 * Meme logique que monitor.py. Code pur : aucun acces au DOM ni au reseau, teste avec `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DECISIONS = ["WATCH", "REJECT", "DATA_MISSING", "NO_ALERT"];

  const DEFAULTS = {
    symbols: {
      "EUR/USD": { decimals: 5, pipSize: 0.0001, pipValuePerLot: 10, assumedSpreadPips: 1.2, maxSpreadPips: 3,
        watchMove5mPips: 15, newsCurrencies: ["EUR", "USD"], control: "ECB" },
      "XAU/USD": { decimals: 2, pipSize: 0.1, pipValuePerLot: 10, assumedSpreadPips: 3, maxSpreadPips: 8,
        watchMove5mPips: 30, newsCurrencies: ["USD"], control: null },
    },
    staleAfterSeconds: 180,
    newsWindowMinutes: 15,
    maxControlDeviationPct: 1.5,
    creditsPerMinute: 8,
    creditsPerDay: 800,
    intervalSeconds: 60,
    paper: { balance: 68, maxRiskPct: 2, minLot: 0.01, lotStep: 0.01 },
  };

  const LOG_FIELDS = ["mode", "fetched_at_utc", "source_timestamp_utc", "source", "symbol", "price", "price_type",
    "bid", "ask", "spread_pips", "spread_status", "change_1m_pips", "change_5m_pips", "market_status",
    "news_proximity", "control_price", "control_deviation_pct", "api_credits_used", "credits_today",
    "missing_flag", "stale_flag", "decision", "reasons"];

  // ------------------------------------------------------------------ outils
  const isoUtc = (ms) => (ms == null || isNaN(ms) ? "" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));
  function toNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ heures de marche (heure de New York)
  // Forex : ferme du vendredi 17:00 au dimanche 17:00 (New York). Or : pause quotidienne 17:00-18:00.
  // Heure d'ete geree par Intl. Jours feries non geres.
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function nyParts(ms) {
    const p = {};
    for (const x of nyFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { wd: WD[p.weekday], minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  }
  function marketStatus(ms, symbol) {
    const { wd, minutes } = nyParts(ms);
    const five = 17 * 60;
    if (wd === 6 || (wd === 5 && minutes >= five) || (wd === 0 && minutes < five)) return "MARKET_CLOSED";
    if (symbol === "XAU/USD" && minutes >= five && minutes < 18 * 60) return "MARKET_CLOSED";
    return "OPEN";
  }

  // ------------------------------------------------------------------ fraicheur, bid/ask, spread
  function isStale(sourceMs, nowMs, maxAgeSeconds) {
    if (sourceMs == null) return true;
    const age = (nowMs - sourceMs) / 1000;
    return age > maxAgeSeconds || age < -120; // futur de plus de 2 min : horloge suspecte
  }
  function checkBidAsk(bid, ask) {
    if (bid == null || ask == null) return "MISSING";
    return bid > ask ? "CROSSED" : "OK";
  }
  function computeSpread(bid, ask, sc) {
    const s = checkBidAsk(bid, ask);
    if (s === "OK") return { pips: (ask - bid) / sc.pipSize, status: "OBSERVED" };
    if (s === "CROSSED") return { pips: null, status: "INVALID_CROSSED" };
    return { pips: Number(sc.assumedSpreadPips), status: "ASSUMED" };
  }

  // ------------------------------------------------------------------ annonces
  function newsProximity(nowMs, currencies, events, windowMinutes) {
    const set = new Set(currencies.map((c) => c.toUpperCase()));
    let best = null;
    for (const ev of events) {
      if (!set.has(String(ev.currency).toUpperCase())) continue;
      const delta = (ev.timeMs - nowMs) / 60000;
      if (Math.abs(delta) <= windowMinutes && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, ev };
    }
    if (!best) return { near: false, label: "NONE" };
    const sign = best.delta >= 0 ? "T-" : "T+";
    return { near: true, label: `${best.ev.currency} ${best.ev.event} ${sign}${Math.round(Math.abs(best.delta))}min` };
  }
  function parseNewsCsv(text) {
    const events = [], errors = [];
    const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
    lines.forEach((line, i) => {
      const raw = line.trim();
      if (!raw || raw.startsWith("#") || /^datetime_utc\s*,/i.test(raw)) return;
      const parts = raw.split(",");
      if (parts.length < 3) { errors.push(`ligne ${i + 1} : format attendu datetime_utc,devise,annonce,impact`); return; }
      const t = Date.parse(parts[0].trim());
      if (!Number.isFinite(t) || !/Z$|[+-]\d\d:?\d\d$/.test(parts[0].trim())) {
        errors.push(`ligne ${i + 1} : date invalide (UTC attendue, ex. 2026-11-25T13:30:00Z)`); return;
      }
      events.push({ timeMs: t, currency: parts[1].trim().toUpperCase(), event: parts[2].trim(),
        impact: (parts[3] || "").trim().toLowerCase() });
    });
    events.sort((a, b) => a.timeMs - b.timeMs);
    return { events, errors };
  }

  // ------------------------------------------------------------------ controle BCE
  function parseEcbJson(d) {
    const series = d && d.dataSets && d.dataSets[0] && d.dataSets[0].series;
    if (!series) throw new Error("format BCE inattendu");
    const s = series[Object.keys(series)[0]];
    const keys = Object.keys(s.observations);
    const last = keys[keys.length - 1];
    const price = toNumber(s.observations[last][0]);
    const dates = d.structure.dimensions.observation[0].values;
    if (price == null) throw new Error("taux BCE absent");
    return { price, date: dates[Number(last)].id };
  }
  function controlDeviationPct(price, control) {
    if (price == null || control == null || control === 0) return null;
    return Math.abs(price - control) / control * 100;
  }

  // ------------------------------------------------------------------ decision (jamais BUY/SELL)
  function decide(o) {
    if (o.price == null) return { decision: "DATA_MISSING", reasons: [o.missingReason || "PRICE_MISSING"] };
    const r = [...(o.extraReject || [])];
    // Donnee perimee pendant les heures d'ouverture : on ne peut pas l'evaluer -> DATA_MISSING.
    // Marche ferme : REJECT (MARKET_CLOSED), car un prix fige le week-end est normal.
    if (o.stale && o.marketOpen) return { decision: "DATA_MISSING", reasons: ["STALE_DATA", ...r] };
    if (!o.marketOpen) r.push("MARKET_CLOSED");
    if (o.stale) r.push("STALE_DATA");
    if (o.newsNear) r.push("NEWS_WINDOW");
    if (o.spreadStatus === "INVALID_CROSSED") r.push("BID_ASK_CROSSED");
    else if (o.spreadPips != null && o.spreadPips > o.maxSpreadPips) r.push("SPREAD_TOO_WIDE");
    if (o.controlDevPct != null && o.controlDevPct > o.maxControlDevPct) r.push("PRICE_FAR_FROM_CONTROL");
    if (r.length) return { decision: "REJECT", reasons: r };
    if (o.move5mPips != null && Math.abs(o.move5mPips) >= o.watchThresholdPips) {
      return { decision: "WATCH", reasons: [`SHARP_MOVE_5M_${Math.abs(o.move5mPips).toFixed(1)}PIPS_CANDIDATE_TO_REVIEW(no_direction_no_edge_implied)`] };
    }
    return { decision: "NO_ALERT", reasons: [] };
  }

  // ------------------------------------------------------------------ taille de position (papier)
  function positionSize(balance, maxRiskPct, stopPips, pipValuePerLot, minLot = 0.01, lotStep = 0.01) {
    if (!(balance > 0) || !(stopPips > 0) || !(pipValuePerLot > 0)) {
      return { allowed: false, lots: 0, riskUsd: null, riskPct: null, reason: "INVALID_INPUT" };
    }
    const maxRisk = balance * maxRiskPct / 100;
    const raw = maxRisk / (stopPips * pipValuePerLot);
    const lots = Math.round(Math.floor(raw / lotStep + 1e-9) * lotStep * 1e8) / 1e8;
    if (lots < minLot - 1e-12) {
      const minRisk = minLot * stopPips * pipValuePerLot;
      return { allowed: false, lots: 0, riskUsd: round2(minRisk), riskPct: round2(minRisk / balance * 100),
        reason: "MIN_LOT_EXCEEDS_RISK_LIMIT" };
    }
    const risk = lots * stopPips * pipValuePerLot;
    return { allowed: true, lots: round2(lots), riskUsd: round2(risk), riskPct: round2(risk / balance * 100), reason: "OK" };
  }
  const round2 = (x) => Math.round(x * 100) / 100;

  // Journal papier : calcule risque et P&L. P&L seulement si la sortie a ete observee (statut CLOSED).
  function paperTradeCalc(t, cfg, balance) {
    const sc = cfg.symbols[t.symbol];
    const errors = [];
    if (!sc) return { errors: ["symbole inconnu"] };
    const entry = toNumber(t.entry), stop = toNumber(t.stop), lots = toNumber(t.lots), exit = toNumber(t.exit);
    const costs = toNumber(t.costs) || 0;
    const dir = t.side === "sell" ? -1 : 1;
    const active = t.status === "OPEN" || t.status === "CLOSED";
    let stopPips = null, riskUsd = null, riskPct = null, pnl = null;
    if (active) {
      if (entry == null) errors.push("prix d'entrée manquant (ask observé, ou mid + demi-spread supposé)");
      if (stop == null) errors.push("stop-loss obligatoire avant l'entrée");
      if (!(lots > 0)) errors.push("taille en lots manquante");
    }
    if (entry != null && stop != null) {
      if ((dir === 1 && stop >= entry) || (dir === -1 && stop <= entry)) errors.push("stop du mauvais côté du prix d'entrée");
      stopPips = Math.abs(entry - stop) / sc.pipSize;
      if (lots > 0) {
        riskUsd = stopPips * sc.pipValuePerLot * lots;
        riskPct = balance > 0 ? riskUsd / balance * 100 : null;
        if (active && !riskWithinLimit(balance, riskUsd, cfg.paper.maxRiskPct)) {
          errors.push(`risque de ${round2(riskUsd)} $ supérieur à ${cfg.paper.maxRiskPct} % du solde (${round2(balance * cfg.paper.maxRiskPct / 100)} $)`);
        }
      }
    }
    if (t.status === "CLOSED") {
      if (exit == null) errors.push("sortie non observée : laisse le statut OPEN (P&L INCONNU)");
      else if (entry != null && lots > 0) pnl = round2(dir * (exit - entry) / sc.pipSize * sc.pipValuePerLot * lots - costs);
    }
    return { stopPips: stopPips == null ? null : round2(stopPips), pipValue: lots > 0 ? round2(sc.pipValuePerLot * lots) : null,
      riskUsd: riskUsd == null ? null : round2(riskUsd), riskPct: riskPct == null ? null : round2(riskPct), pnl, errors };
  }
  const riskWithinLimit = (balance, riskUsd, maxRiskPct) =>
    balance > 0 && riskUsd >= 0 && riskUsd <= balance * maxRiskPct / 100 + 1e-9;

  // ------------------------------------------------------------------ Twelve Data
  function parseQuotePayload(payload, symbols) {
    const out = {};
    symbols.forEach((s) => (out[s] = null));
    if (!payload || typeof payload !== "object") return out;
    if ("symbol" in payload) { if (payload.symbol in out) out[payload.symbol] = payload; return out; }
    symbols.forEach((s) => { if (payload[s] && typeof payload[s] === "object") out[s] = payload[s]; });
    return out;
  }
  function apiError(payload) {
    if (payload && payload.status === "error") {
      const code = payload.code;
      if (code === 429) return { kind: "QUOTA", message: "limite de credits atteinte" };
      if (code === 401 || code === 403) return { kind: "AUTH", message: "cle refusee ou droits insuffisants" };
      return { kind: "API", message: `erreur ${code} : ${String(payload.message || "").slice(0, 160)}` };
    }
    return null;
  }
  // /quote ne fournit pas bid/ask : ils restent null (MISSING), jamais inventes.
  function quoteToObservation(symbol, q) {
    if (!q) return { symbol, price: null, sourceMs: null, source: "TWELVE_DATA", missingReason: "NO_DATA_IN_RESPONSE" };
    if (q.status === "error") return { symbol, price: null, sourceMs: null, source: "TWELVE_DATA", missingReason: `API_ERROR_${q.code}` };
    const price = toNumber(q.close);
    const ts = toNumber(q.last_quote_at) || toNumber(q.timestamp);
    return { symbol, price, sourceMs: ts ? ts * 1000 : null, source: "TWELVE_DATA", bid: null, ask: null,
      apiMarketOpen: typeof q.is_market_open === "boolean" ? q.is_market_open : null,
      missingReason: price == null ? "PRICE_MISSING" : null, priceType: "QUOTE_CLOSE_1MIN" };
  }

  // ------------------------------------------------------------------ credits
  function CreditTracker(storage, perMinute, perDay, key = "credits") {
    let st = storage.get(key) || { day: "", used: 0, minute: [] };
    const roll = (now) => {
      const day = isoUtc(now).slice(0, 10);
      if (day !== st.day) st = { day, used: 0, minute: [] };  // remise a zero a minuit UTC
      st.minute = st.minute.filter(([t]) => now - t < 60000);
    };
    return {
      usedToday(now) { roll(now); return st.used; },
      check(n, now) {
        roll(now);
        if (st.used + n > perDay) return "DAILY";
        if (st.minute.reduce((a, [, c]) => a + c, 0) + n > perMinute) return "MINUTE";
        return "OK";
      },
      spend(n, now) { roll(now); st.used += n; st.minute.push([now, n]); storage.set(key, st); },
    };
  }

  // ------------------------------------------------------------------ variations
  function changePips(history, nowMs, minutes, price, pip) {
    if (price == null) return null;
    const target = nowMs - minutes * 60000;
    const cands = history.filter((h) => h.t <= target + 30000);
    if (!cands.length) return null;
    const ref = cands[cands.length - 1];
    if (ref.t < target - 90000) return null;  // trou dans l'historique
    return (price - ref.p) / pip;
  }

  // ------------------------------------------------------------------ evaluation d'une observation -> ligne de journal
  function newEngineState(cfg) {
    const hist = {};
    Object.keys(cfg.symbols).forEach((s) => (hist[s] = []));
    return { hist, lastWatch: {} };
  }

  // ------------------------------------------------------------------ reglages de l'utilisateur
  const DEFAULT_SETTINGS = {
    watchCooldownMin: { "EUR/USD": 10, "XAU/USD": 10 }, // pause avant de redeclencher un WATCH
    xauPipUsd: 0.1,                                     // 1 pip XAU/USD = 0,10 $ de prix (varie selon le courtier)
    demoStart: { "EUR/USD": null, "XAU/USD": null },    // null = dernier prix reel connu, sinon valeur par defaut
  };
  const DEMO_FALLBACK = { "EUR/USD": 1.097, "XAU/USD": 3530 };  // derniers prix reels releves le 21/11/2026
  /**
   * Applique les reglages a une configuration. Changer le pip de l'or garde les memes montants en $ :
   * seuil WATCH 3 $, spread suppose 0,30 $, spread max 0,80 $, contrat 100 oz.
   */
  function withSettings(baseCfg, settings) {
    const s = Object.assign(clone(DEFAULT_SETTINGS), settings || {});
    const cfg = clone(baseCfg);
    Object.entries(cfg.symbols).forEach(([sym, sc]) => {
      const cd = Number((s.watchCooldownMin || {})[sym]);
      sc.watchCooldownMin = Number.isFinite(cd) && cd >= 0 ? cd : 10;
    });
    const xau = cfg.symbols["XAU/USD"];
    const pip = [0.01, 0.1, 1].includes(Number(s.xauPipUsd)) ? Number(s.xauPipUsd) : 0.1;
    if (xau) {
      xau.pipSize = pip;
      xau.pipValuePerLot = 100 * pip;            // 100 oz par lot
      xau.watchMove5mPips = +(3 / pip).toFixed(4);
      xau.assumedSpreadPips = +(0.3 / pip).toFixed(4);
      xau.maxSpreadPips = +(0.8 / pip).toFixed(4);
    }
    cfg.settings = s;
    return cfg;
  }
  /** Prix de depart de la demo : reglage, sinon dernier prix reel connu, sinon valeur par defaut. */
  function demoStartPrices(settings, lastReal) {
    const out = {};
    Object.keys(DEMO_FALLBACK).forEach((sym) => {
      const manual = Number(settings && settings.demoStart && settings.demoStart[sym]);
      const real = Number(lastReal && lastReal[sym]);
      out[sym] = manual > 0 ? { price: manual, source: "réglage" }
        : real > 0 ? { price: real, source: "dernier prix réel connu" }
          : { price: DEMO_FALLBACK[sym], source: "valeur par défaut" };
    });
    return out;
  }
  function evaluate(state, obs, nowMs, cfg, news, controls, extra) {
    extra = extra || {};
    const sc = cfg.symbols[obs.symbol];
    const sched = marketStatus(nowMs, obs.symbol);
    const marketOpen = sched === "OPEN" && obs.apiMarketOpen !== false;
    const missing = obs.price == null;
    const stale = !missing && isStale(obs.sourceMs, nowMs, cfg.staleAfterSeconds);
    const spread = computeSpread(obs.bid, obs.ask, sc);
    const hist = state.hist[obs.symbol] || (state.hist[obs.symbol] = []);
    const ch1 = changePips(hist, nowMs, 1, obs.price, sc.pipSize);
    const ch5 = changePips(hist, nowMs, 5, obs.price, sc.pipSize);
    if (!missing && !stale) {
      hist.push({ t: nowMs, p: obs.price });
      while (hist.length && nowMs - hist[0].t > 600000) hist.shift();
    }
    const nw = newsProximity(nowMs, sc.newsCurrencies, news, cfg.newsWindowMinutes);
    const control = controls[obs.symbol];
    const dev = control ? controlDeviationPct(obs.price, control.price) : null;
    let d = decide({ price: obs.price, marketOpen, stale, newsNear: nw.near, spreadPips: spread.pips,
      spreadStatus: spread.status, maxSpreadPips: sc.maxSpreadPips, controlDevPct: dev,
      maxControlDevPct: cfg.maxControlDeviationPct, move5mPips: ch5, watchThresholdPips: sc.watchMove5mPips,
      missingReason: obs.missingReason, extraReject: extra.extraReject });
    if (d.decision === "WATCH") {
      // Un seul WATCH par mouvement : pause reglable par paire avant de pouvoir redeclencher.
      state.lastWatch = state.lastWatch || {};
      const last = state.lastWatch[obs.symbol];
      const cdMs = (sc.watchCooldownMin != null ? sc.watchCooldownMin : 10) * 60000;
      if (last != null && cdMs > 0 && nowMs - last < cdMs) {
        d = { decision: "NO_ALERT", reasons: [`WATCH_ALREADY_SIGNALED_${isoUtc(last).slice(11, 16)}`] };
      } else state.lastWatch[obs.symbol] = nowMs;
    }
    const num = (v) => (v == null ? "N/A" : (v > 0 ? "+" : "") + v.toFixed(1));
    return {
      mode: extra.mode || "live",
      fetched_at_utc: isoUtc(nowMs),
      source_timestamp_utc: isoUtc(obs.sourceMs) || "MISSING",
      source: obs.source,
      symbol: obs.symbol,
      price: missing ? "MISSING" : obs.price.toFixed(sc.decimals),
      price_type: obs.priceType || "N/A",
      bid: obs.bid == null ? "MISSING" : obs.bid.toFixed(sc.decimals),
      ask: obs.ask == null ? "MISSING" : obs.ask.toFixed(sc.decimals),
      spread_pips: spread.pips == null ? "N/A" : spread.pips.toFixed(1),
      spread_status: spread.status,
      change_1m_pips: num(ch1),
      change_5m_pips: num(ch5),
      market_status: marketOpen ? "OPEN" : "MARKET_CLOSED",
      news_proximity: nw.label,
      control_price: control ? `${control.price.toFixed(5)} (${control.source})` : (sc.control ? "UNAVAILABLE" : "NO_CONTROL_SOURCE"),
      control_deviation_pct: dev == null ? "N/A" : dev.toFixed(3),
      api_credits_used: extra.creditsUsed || 0,
      credits_today: extra.creditsToday || 0,
      missing_flag: missing,
      stale_flag: stale,
      decision: d.decision,
      reasons: d.reasons.join(";"),
    };
  }

  // ------------------------------------------------------------------ donnees SYNTHETIQUES (demo)
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function SyntheticFeed(cfg, seed = 42, startPrices) {
    const rnd = mulberry32(seed);
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const start = Object.assign({}, DEMO_FALLBACK, startPrices || {});   // point de depart, la suite est FICTIVE
    // volatilite par minute exprimee en $ pour l'or (0,80 $), pour rester juste quel que soit le pip choisi
    const vol = { "EUR/USD": 1.5, "XAU/USD": 0.8 / ((cfg.symbols["XAU/USD"] || {}).pipSize || 0.1) };
    const prices = {};
    Object.keys(cfg.symbols).forEach((s) => (prices[s] = start[s] || 1));
    return {
      step(i, nowMs) {
        return Object.entries(cfg.symbols).map(([sym, sc]) => {
          let move = gauss() * (vol[sym] || 1);
          if (sym === "EUR/USD" && i >= 4 && i <= 6) move += 6;   // mouvement brusque INJECTE
          prices[sym] += move * sc.pipSize;
          let price = Number(prices[sym].toFixed(sc.decimals)), sourceMs = nowMs - 5000, missingReason = null;
          if (sym === "XAU/USD" && i === 15) sourceMs = nowMs - 600000;                       // donnee perimee INJECTEE
          if (sym === "XAU/USD" && i === 18) { price = null; missingReason = "SYNTHETIC_MISSING_TICK"; } // manquante INJECTEE
          return { symbol: sym, price, sourceMs, source: "SYNTHETIC", bid: null, ask: null, apiMarketOpen: null,
            missingReason, priceType: "SYNTHETIC_MID" };
        });
      },
    };
  }

  // ------------------------------------------------------------------ CSV (protege contre l'injection de formules)
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows, fields) {
    return [fields.join(","), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(","))].join("\r\n") + "\r\n";
  }

  return { DECISIONS, DEFAULTS, LOG_FIELDS, clone, isoUtc, toNumber, nyParts, marketStatus, isStale, checkBidAsk,
    computeSpread, newsProximity, parseNewsCsv, parseEcbJson, controlDeviationPct, decide, positionSize,
    riskWithinLimit, paperTradeCalc, parseQuotePayload, apiError, quoteToObservation, CreditTracker, changePips, newEngineState,
    DEFAULT_SETTINGS, DEMO_FALLBACK, withSettings, demoStartPrices,
    evaluate, SyntheticFeed, csvCell, toCsv };
});
