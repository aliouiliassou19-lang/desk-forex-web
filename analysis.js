/* Desk Forex web : moteurs d'analyse technique et fondamentale, sessions, plan de trade, pre-test.
 * Code pur (aucun DOM, aucun reseau). LECTURE SEULE : aucun ordre, aucun conseil.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------ paires
  // contract = unites par lot ; spread = ordre de grandeur en pips (a remplacer par celui du courtier)
  const PAIRS = {
    "EUR/USD": { pip: 0.0001, dec: 5, contract: 100000, spread: 1.2 },
    "GBP/USD": { pip: 0.0001, dec: 5, contract: 100000, spread: 1.6 },
    "USD/JPY": { pip: 0.01, dec: 3, contract: 100000, spread: 1.4 },
    "USD/CHF": { pip: 0.0001, dec: 5, contract: 100000, spread: 1.8 },
    "AUD/USD": { pip: 0.0001, dec: 5, contract: 100000, spread: 1.6 },
    "USD/CAD": { pip: 0.0001, dec: 5, contract: 100000, spread: 2.0 },
    "NZD/USD": { pip: 0.0001, dec: 5, contract: 100000, spread: 2.2 },
    "EUR/GBP": { pip: 0.0001, dec: 5, contract: 100000, spread: 1.8 },
    "EUR/JPY": { pip: 0.01, dec: 3, contract: 100000, spread: 2.2 },
    "GBP/JPY": { pip: 0.01, dec: 3, contract: 100000, spread: 3.0 },
    "XAU/USD": { pip: 0.1, dec: 2, contract: 100, spread: 3.0 },
    "XAG/USD": { pip: 0.01, dec: 3, contract: 5000, spread: 3.0 },
  };
  const ccys = (pair) => pair.split("/");

  /** Valeur d'un pip pour 1 lot, en USD. conv = cours de conversion necessaire (null si inutile). */
  function conversionNeeded(pair) {
    const [, q] = ccys(pair);
    if (q === "USD") return null;
    if (pair.startsWith("USD/")) return null;          // la paire elle-meme sert de conversion
    return q === "JPY" ? "USD/JPY" : `${q}/USD`;       // croisees : EUR/GBP -> GBP/USD, EUR/JPY -> USD/JPY
  }
  function pipValueUsd(pair, price, conv) {
    const p = PAIRS[pair]; if (!p) return null;
    const perLotQuote = p.pip * p.contract;            // en devise de cotation
    const [, q] = ccys(pair);
    if (q === "USD") return perLotQuote;
    if (pair.startsWith("USD/")) return price > 0 ? perLotQuote / price : null;
    if (!(conv > 0)) return null;
    return q === "JPY" ? perLotQuote / conv : perLotQuote * conv;
  }

  // ------------------------------------------------------------------ bougies Twelve Data
  function parseTimeSeries(payload) {
    if (!payload || payload.status === "error" || !Array.isArray(payload.values)) return null;
    const bars = [];
    for (const v of payload.values) {
      const t = Date.parse(String(v.datetime).replace(" ", "T") + (String(v.datetime).length <= 10 ? "T00:00:00Z" : "Z"));
      const o = +v.open, h = +v.high, l = +v.low, c = +v.close;
      if ([t, o, h, l, c].every(Number.isFinite)) bars.push({ t, o, h, l, c });
    }
    return bars.sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------------ indicateurs
  function emaSeries(vals, n) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < n) return out;
    let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
    out[n - 1] = e;
    const k = 2 / (n + 1);
    for (let i = n; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  const last = (a) => (a.length ? a[a.length - 1] : null);
  function rsiSeries(c, n = 14) {
    const out = new Array(c.length).fill(null);
    if (c.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
    g /= n; l /= n;
    out[n] = l ? 100 - 100 / (1 + g / l) : 100;
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l ? 100 - 100 / (1 + g / l) : 100;
    }
    return out;
  }
  function atr(bars, n = 14) {
    if (bars.length <= n) return null;
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].c;
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    }
    let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
    for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
  }
  function efficiency(c, n = 20) {
    if (c.length <= n) return null;
    let path = 0;
    for (let i = c.length - n; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
    return path ? Math.abs(last(c) - c[c.length - 1 - n]) / path : 0;
  }
  function swings(bars, k = 3) {
    const highs = [], lows = [];
    for (let i = k; i < bars.length - k; i++) {
      const w = bars.slice(i - k, i + k + 1);
      if (bars[i].h === Math.max(...w.map((b) => b.h))) highs.push({ t: bars[i].t, p: bars[i].h });
      if (bars[i].l === Math.min(...w.map((b) => b.l))) lows.push({ t: bars[i].t, p: bars[i].l });
    }
    return { highs, lows };
  }
  function pivots(prev) {
    const P = (prev.h + prev.l + prev.c) / 3, r = prev.h - prev.l;
    return { R2: P + r, R1: 2 * P - prev.l, P, S1: 2 * P - prev.h, S2: P - r };
  }
  function bollinger(c, n = 20, k = 2) {
    if (c.length < n) return null;
    const w = c.slice(-n), m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    return { high: m + k * sd, mid: m, low: m - k * sd };
  }

  function tfSummary(tf, bars, price, pip) {
    const c = bars.map((b) => b.c);
    const e20 = last(emaSeries(c, 20)), e50 = last(emaSeries(c, 50)), e200 = last(emaSeries(c, 200));
    const a = atr(bars, 14);
    const emas = [e20, e50, e200].filter((x) => x != null);
    const above = emas.filter((e) => price > e).length;
    let trend = "neutre";
    if (emas.length >= 2 && above === emas.length && e20 > e50) trend = "haussière";
    else if (emas.length >= 2 && above === 0 && e20 < e50) trend = "baissière";
    return { tf, bars: bars.length, ema20: e20, ema50: e50, ema200: e200, rsi: last(rsiSeries(c)), atr: a,
      atrPips: a != null ? a / pip : null, eff: efficiency(c, 20), trend };
  }

  /** Synthese technique a partir des bougies H1, H4 et D1 (ordre croissant). */
  function technical(pair, series) {
    const info = PAIRS[pair];
    const { h1, h4, d1 } = series;
    if (!info || !h1 || h1.length < 30 || !d1 || d1.length < 25) return { error: "Historique insuffisant pour l'analyse." };
    const price = last(h1).c;
    const tfs = [tfSummary("D1", d1, price, info.pip), h4 && h4.length > 30 ? tfSummary("H4", h4, price, info.pip) : null,
      tfSummary("H1", h1, price, info.pip)].filter(Boolean);
    const D = tfs[0], H4 = tfs.find((t) => t.tf === "H4");

    // niveaux
    const levels = [];
    const add = (p, label) => { if (Number.isFinite(p) && Math.abs(p - price) > info.pip / 2) levels.push({ price: p, label }); };
    const sd = swings(d1.slice(-120), 3), s4 = h4 ? swings(h4.slice(-120), 3) : { highs: [], lows: [] };
    const dm = (t) => new Date(t).toISOString().slice(5, 10).split("-").reverse().join("/");
    sd.highs.slice(-4).forEach((s) => add(s.p, "Sommet D1 " + dm(s.t)));
    sd.lows.slice(-4).forEach((s) => add(s.p, "Creux D1 " + dm(s.t)));
    s4.highs.slice(-3).forEach((s) => add(s.p, "Sommet H4 " + dm(s.t)));
    s4.lows.slice(-3).forEach((s) => add(s.p, "Creux H4 " + dm(s.t)));
    const prevDay = d1.length >= 2 ? d1[d1.length - 2] : last(d1);
    const pv = pivots(prevDay);
    Object.entries(pv).forEach(([k, v]) => add(v, "Pivot " + k));
    const last24 = h1.slice(-24);
    const hi24 = Math.max(...last24.map((b) => b.h)), lo24 = Math.min(...last24.map((b) => b.l));
    add(hi24, "Plus haut 24 h"); add(lo24, "Plus bas 24 h");
    // Fibonacci du dernier mouvement journalier (creux -> sommet si tendance H4 haussiere, sinon l'inverse)
    const lastHi = sd.highs.length ? last(sd.highs).p : Math.max(...d1.slice(-20).map((b) => b.h));
    const lastLo = sd.lows.length ? last(sd.lows).p : Math.min(...d1.slice(-20).map((b) => b.l));
    const up = (H4 || D).trend === "haussière";
    const from = up ? Math.min(lastLo, lo24) : Math.max(lastHi, hi24), to = up ? Math.max(hi24, lastHi) : Math.min(lo24, lastLo);
    const range = to - from;
    const fib = {};
    [[23.6, 0.236], [38.2, 0.382], [50, 0.5], [61.8, 0.618]].forEach(([k, f]) => { fib[k] = to - f * range; add(fib[k], `Fibo ${k} %`); });
    tfs.forEach((t) => add(t.ema20, "EMA20 " + t.tf));
    const boll = bollinger(d1.map((b) => b.c));
    // chiffres ronds (pas adapte a l'ATR journalier)
    const step = 10 ** Math.round(Math.log10(D.atr || price * 0.005));
    const base = Math.round(price / step) * step;
    for (let k = -2; k <= 2; k++) add(base + k * step, "Chiffre rond");
    const resistances = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 8);
    const supports = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 8);

    // lecture
    const trends = tfs.map((t) => t.trend);
    let bias;
    if (trends.every((t) => t === "baissière")) bias = `Baissier sur ${tfs.map((t) => t.tf).join(", ")}`;
    else if (trends.every((t) => t === "haussière")) bias = `Haussier sur ${tfs.map((t) => t.tf).join(", ")}`;
    else bias = "Mixte (" + tfs.map((t) => `${t.tf} ${t.trend}`).join(", ") + ")";
    const notes = [];
    const stretch = D.atr ? (price - D.ema20) / D.atr : 0;
    if (Math.abs(stretch) >= 2) notes.push(`Prix très étiré : ${stretch.toFixed(1)} ATR de l'EMA20 journalière.`);
    if (boll && price < boll.low) notes.push("Prix sous la bande de Bollinger basse (D1).");
    else if (boll && price > boll.high) notes.push("Prix au-dessus de la bande de Bollinger haute (D1).");
    const rsiRef = (H4 || tfs[tfs.length - 1]);
    if (rsiRef.rsi != null && rsiRef.rsi < 30) notes.push(`RSI ${rsiRef.tf} en survente (${rsiRef.rsi.toFixed(0)}).`);
    else if (rsiRef.rsi != null && rsiRef.rsi > 70) notes.push(`RSI ${rsiRef.tf} en surachat (${rsiRef.rsi.toFixed(0)}).`);
    const eff = D.eff || 0;
    notes.push(`Régime journalier : ${eff >= 0.35 ? "tendance" : eff <= 0.2 ? "range" : "mixte"} (efficacité ${eff.toFixed(2)}).`);
    if (D.ema200 == null) notes.push("EMA200 journalière indisponible (historique trop court).");
    const ranges = [5, 20, 60].filter((n) => d1.length >= n).map((n) => {
      const w = d1.slice(-n), hi = Math.max(...w.map((b) => b.h)), lo = Math.min(...w.map((b) => b.l));
      return { days: n, high: hi, low: lo, pos: hi > lo ? (price - lo) / (hi - lo) : 0.5 };
    });
    return { pair, price, time: last(h1).t, dec: info.dec, pip: info.pip, tfs, pivots: pv, fib, bollinger: boll,
      resistances, supports, bias, notes, ranges, stretchAtr: stretch };
  }

  // ------------------------------------------------------------------ fondamental (sources officielles)
  function parseNyFedEffr(j) {
    const r = j && j.refRates && j.refRates[0];
    if (!r || !Number.isFinite(+r.percentRate)) throw new Error("format Fed de New York inattendu");
    return { value: +r.percentRate, date: r.effectiveDate };
  }
  function blsSeries(j) {
    const s = j && j.Results && j.Results.series && j.Results.series[0];
    if (!s || !Array.isArray(s.data)) throw new Error("format BLS inattendu");
    return s.data.filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period) && d.value !== "-")
      .map((d) => ({ y: +d.year, m: +d.period.slice(1), v: +d.value }))
      .filter((d) => Number.isFinite(d.v)).sort((a, b) => a.y - b.y || a.m - b.m);
  }
  const ym = (d) => `${d.y}-${String(d.m).padStart(2, "0")}`;
  /** Variation sur 12 mois du dernier mois pour lequel le meme mois de l'annee precedente existe
   *  (le BLS a des mois manquants, ex. octobre 2025 non publie). */
  function blsYoY(j) {
    const s = blsSeries(j);
    if (!s.length) throw new Error("série BLS vide");
    for (let i = s.length - 1; i >= 0; i--) {
      const cur = s[i], prev = s.find((d) => d.y === cur.y - 1 && d.m === cur.m);
      if (prev) return { value: (cur.v / prev.v - 1) * 100, date: ym(cur), latest: ym(last(s)) };
    }
    throw new Error("aucun mois comparable sur 12 mois");
  }
  function blsLatest(j) {
    const cur = last(blsSeries(j));
    if (!cur) throw new Error("série BLS vide");
    return { value: cur.v, date: ym(cur) };
  }
  function parseEcbSeries(d) {
    const series = d && d.dataSets && d.dataSets[0] && d.dataSets[0].series;
    if (!series) throw new Error("format BCE inattendu");
    const s = series[Object.keys(series)[0]];
    const keys = Object.keys(s.observations), k = last(keys);
    const value = +s.observations[k][0];
    if (!Number.isFinite(value)) throw new Error("valeur BCE absente");
    return { value, date: d.structure.dimensions.observation[0].values[+k].id };
  }
  function parseEurostat(d) {
    const idx = d && d.dimension && d.dimension.time && d.dimension.time.category && d.dimension.time.category.index;
    if (!idx || !d.value) throw new Error("format Eurostat inattendu");
    const periods = Object.entries(idx).sort((a, b) => a[1] - b[1]);
    for (let i = periods.length - 1; i >= 0; i--) {
      const v = d.value[String(periods[i][1])];
      if (v != null && Number.isFinite(+v)) return { value: +v, date: periods[i][0] };
    }
    throw new Error("valeur Eurostat absente");
  }
  /** Age en jours d'une date de publication (AAAA-MM-JJ, AAAA-MM ou AAAA-Qn). */
  function ageDays(date, nowMs) {
    let t;
    const q = /^(\d{4})-?Q([1-4])$/.exec(date);
    if (q) t = Date.UTC(+q[1], +q[2] * 3, 0);              // fin du trimestre
    else if (/^\d{4}-\d{2}$/.test(date)) t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0); // fin du mois
    else t = Date.parse(date);
    return Number.isFinite(t) ? Math.floor((nowMs - t) / 86400000) : null;
  }
  /** Synthese USD vs EUR a partir des valeurs disponibles (chacune {value, date} ou {error}). */
  function fundamentalSummary(f, nowMs) {
    const ok = (x) => x && Number.isFinite(x.value);
    const flag = (x, maxDays) => ok(x) && ageDays(x.date, nowMs) > maxDays;
    const notes = [];
    const stale = [];
    [["Taux Fed", f.usdRate, 10], ["Inflation US", f.usdCpi, 75], ["Chômage US", f.usdUnemp, 75],
      ["Taux BCE", f.eurRate, 10], ["Inflation zone euro", f.eurCpi, 75], ["Chômage zone euro", f.eurUnemp, 120]]
      .forEach(([n, x, d]) => { if (flag(x, d)) stale.push(n); });
    let diff = null;
    if (ok(f.usdRate) && ok(f.eurRate)) {
      diff = f.usdRate.value - f.eurRate.value;
      notes.push(`Écart de taux USD - EUR : ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} point(s). ` +
        (Math.abs(diff) < 0.25 ? "Écart faible." : diff > 0 ? "Le dollar rémunère davantage (porte un avantage de portage)." : "L'euro rémunère davantage."));
    }
    if (ok(f.usdCpi) && ok(f.usdRate)) notes.push(`Taux réel US approximatif : ${(f.usdRate.value - f.usdCpi.value).toFixed(2)} % (taux Fed - inflation sur 1 an).`);
    if (ok(f.eurCpi) && ok(f.eurRate)) notes.push(`Taux réel zone euro approximatif : ${(f.eurRate.value - f.eurCpi.value).toFixed(2)} % (taux de dépôt - inflation sur 1 an).`);
    if (ok(f.usdCpi) && f.usdCpi.value > 2.5) notes.push("Inflation US au-dessus de la cible de 2 % de la Fed.");
    if (ok(f.eurCpi) && f.eurCpi.value > 2.5) notes.push("Inflation zone euro au-dessus de la cible de 2 % de la BCE.");
    if (stale.length) notes.push("Données anciennes à vérifier : " + stale.join(", ") + ".");
    notes.push("Ces chiffres décrivent le contexte ; ils ne prédisent pas le prochain mouvement. Pas un conseil.");
    return { diff, notes, stale };
  }

  // ------------------------------------------------------------------ sessions de marche
  const SESSIONS = [
    { name: "Sydney", tz: "Australia/Sydney", open: 7, close: 16 },
    { name: "Tokyo", tz: "Asia/Tokyo", open: 9, close: 18 },
    { name: "Londres", tz: "Europe/London", open: 8, close: 17 },
    { name: "New York", tz: "America/New_York", open: 8, close: 17 },
  ];
  const fmtCache = {};
  function tzParts(ms, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
    const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { wd: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], min: (+p.hour % 24) * 60 + +p.minute };
  }
  function sessionsAt(ms) {
    const ny = tzParts(ms, "America/New_York");
    const weekend = ny.wd === 6 || (ny.wd === 5 && ny.min >= 1020) || (ny.wd === 0 && ny.min < 1020);
    const list = SESSIONS.map((s) => {
      const p = tzParts(ms, s.tz);
      const open = !weekend && p.wd >= 1 && p.wd <= 5 && p.min >= s.open * 60 && p.min < s.close * 60;
      return { name: s.name, open };
    });
    const openNames = list.filter((s) => s.open).map((s) => s.name);
    const notes = [];
    if (weekend) notes.push("Week-end : marché forex fermé (du vendredi 17 h au dimanche 17 h, heure de New York).");
    if (openNames.includes("Londres") && openNames.includes("New York")) notes.push("Chevauchement Londres + New York : en général la période la plus liquide.");
    if (!weekend && ny.min >= 16 * 60 + 45 && ny.min < 17 * 60 + 15) notes.push("ATTENTION : rollover (17 h New York) : spreads souvent élargis.");
    if (!weekend && !openNames.length) notes.push("Aucune grande session ouverte : liquidité faible.");
    return { sessions: list, weekend, notes };
  }

  // ------------------------------------------------------------------ plan de trade (papier)
  /**
   * i : {pair, dir, entry, stop | stopAtr+atr, target | rr, spreadPips, balance, riskPct, pipValue, minRR,
   *      minLot, lotStep, news:[{timeMs,currency,impact}], nowMs, windowHours}
   */
  function plan(i) {
    const p = PAIRS[i.pair];
    const checks = [];
    const add = (level, msg) => checks.push({ level, msg });
    if (!p) return { error: "paire inconnue" };
    const dir = i.dir === "sell" ? -1 : 1;
    const entry = +i.entry;
    if (!(entry > 0)) return { error: "prix d'entrée manquant" };
    let stop = Number.isFinite(+i.stop) && +i.stop > 0 ? +i.stop : null;
    if (stop == null && i.stopAtr > 0 && i.atr > 0) stop = entry - dir * i.stopAtr * i.atr;
    if (stop == null) return { error: "stop manquant (prix ou multiple d'ATR)" };
    if ((dir === 1 && stop >= entry) || (dir === -1 && stop <= entry)) return { error: "stop du mauvais côté du prix d'entrée" };
    const stopPips = Math.abs(entry - stop) / p.pip;
    const spread = +i.spreadPips >= 0 ? +i.spreadPips : p.spread;
    const effStop = stopPips + spread;                     // le spread s'ajoute a la perte au stop
    const targets = [];
    if (+i.target > 0) targets.push(+i.target);
    (i.rr || []).forEach((r) => targets.push(entry + dir * r * stopPips * p.pip));
    const tgt = targets.map((t) => {
      const pips = dir * (t - entry) / p.pip;
      return { price: t, pips, rrNet: (pips - spread) / effStop };
    });
    const pv = +i.pipValue;
    let size = null;
    if (pv > 0) {
      const maxRisk = i.balance * i.riskPct / 100;
      const raw = maxRisk / (effStop * pv);
      const step = i.lotStep || 0.01, minLot = i.minLot || 0.01;
      const lots = Math.floor(raw / step + 1e-9) * step;
      if (lots < minLot - 1e-12) {
        const r = minLot * effStop * pv;
        size = { lots: 0, riskUsd: r, riskPct: r / i.balance * 100, allowed: false };
        add("NON", `Même ${minLot} lot risque ${r.toFixed(2)} $ (${(r / i.balance * 100).toFixed(2)} %), au-delà de ${i.riskPct} % du solde.`);
      } else {
        const r = lots * effStop * pv;
        size = { lots: +lots.toFixed(2), riskUsd: r, riskPct: r / i.balance * 100, allowed: true };
        add("OK", `Taille ${lots.toFixed(2)} lot : risque ${r.toFixed(2)} $ (${(r / i.balance * 100).toFixed(2)} %), spread compris.`);
      }
    } else add("ATTENTION", "Valeur du pip inconnue : taille non calculée (conversion de devise nécessaire).");
    const bestRR = tgt.length ? Math.max(...tgt.map((t) => t.rrNet)) : null;
    if (bestRR == null) add("ATTENTION", "Aucun objectif défini.");
    else if (bestRR < (i.minRR || 1.5)) add("ATTENTION", `Rapport gain/risque net ${bestRR.toFixed(2)} < ${i.minRR || 1.5}.`);
    else add("OK", `Rapport gain/risque net jusqu'à ${bestRR.toFixed(2)}.`);
    if (spread / stopPips > 0.2) add("ATTENTION", `Le spread représente ${(100 * spread / stopPips).toFixed(0)} % du stop : coût élevé.`);
    if (i.atrH1 > 0 && stopPips * p.pip < 0.5 * i.atrH1) add("ATTENTION", "Stop plus serré qu'une demi-ATR H1 : risque d'être sorti par le bruit.");
    const s = sessionsAt(i.nowMs);
    if (s.weekend) add("NON", "Marché fermé (week-end).");
    s.notes.filter((n) => n.startsWith("ATTENTION")).forEach((n) => add("ATTENTION", n.replace(/^ATTENTION : /, "")));
    const [b, q] = ccys(i.pair);
    const rel = new Set(i.pair.startsWith("XA") ? ["USD"] : [b, q]);
    const win = (i.windowHours || 4) * 3600000;
    (i.news || []).filter((e) => rel.has(e.currency) && e.timeMs >= i.nowMs - 1800000 && e.timeMs <= i.nowMs + win)
      .forEach((e) => add("ATTENTION", `Annonce ${e.impact === "high" ? "forte " : ""}${e.currency} « ${e.event} » à ${new Date(e.timeMs).toISOString().slice(11, 16)} UTC.`));
    const levels = new Set(checks.map((c) => c.level));
    const verdict = levels.has("NON") ? "NON" : levels.has("ATTENTION") ? "À REVOIR" : "OK";
    return { pair: i.pair, dir: i.dir, entry, stop, stopPips, spread, targets: tgt, size, checks, verdict };
  }

  // ------------------------------------------------------------------ pre-test d'une idee
  /**
   * Avant de backtester : cout d'un trade et taux de reussite minimal.
   * i : {atrPips, stopAtr, rr, spreadPips, slippagePips, commissionPerLot, pipValuePerLot, winRate (0-1, facultatif)}
   */
  function pretest(i) {
    const stopPips = i.atrPips * i.stopAtr;
    if (!(stopPips > 0) || !(i.rr > 0)) return { error: "ATR, multiple de stop et objectif (R) requis." };
    const commPips = i.pipValuePerLot > 0 ? (i.commissionPerLot || 0) / i.pipValuePerLot : 0;
    const costPips = (i.spreadPips || 0) + (i.slippagePips || 0) + commPips;
    const costR = costPips / stopPips;
    const breakeven = (1 + costR) / (i.rr + 1);           // E = p*RR - (1-p) - cout = 0
    const target = (1 + 4 * costR) / (i.rr + 1);          // prudence : esperance >= 3 x cout
    const out = { stopPips, costPips, costAtr: costPips / i.atrPips, costR, breakeven, target };
    if (i.winRate > 0 && i.winRate < 1) {
      const p = i.winRate, e = p * i.rr - (1 - p) - costR;
      const sd = (i.rr + 1) * Math.sqrt(p * (1 - p));
      out.expectancy = e;
      out.tradesToProve = e > 0 ? Math.ceil((2 * sd / e) ** 2) : null; // ~95 % de confiance
    }
    out.verdict = target > 0.65 ? "INUTILE DE TESTER" : target > 0.5 ? "DIFFICILE" : "IDÉE TESTABLE";
    return out;
  }

  // ------------------------------------------------------------------ alertes de prix
  function checkAlerts(alerts, prices, nowMs) {
    const fired = [];
    for (const a of alerts) {
      if (a.triggered || !(a.pair in prices)) continue;
      const px = prices[a.pair];
      if ((a.side === "above" && px >= a.price) || (a.side === "below" && px <= a.price)) {
        a.triggered = nowMs; a.at = px; fired.push(a);
      }
    }
    return fired;
  }

  return { PAIRS, conversionNeeded, pipValueUsd, parseTimeSeries, emaSeries, rsiSeries, atr, efficiency, swings,
    pivots, bollinger, technical, parseNyFedEffr, blsYoY, blsLatest, parseEcbSeries, parseEurostat, ageDays,
    fundamentalSummary, sessionsAt, plan, pretest, checkAlerts };
});
