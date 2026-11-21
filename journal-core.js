/* Desk Forex : moteur du journal de trading (calculs purs, sans DOM ni reseau, teste avec node --test).
 * Trades SIMULES ou passes par l'utilisateur lui-meme : ce code ne passe aucun ordre.
 * Heure locale = Benin (UTC+1, pas d'heure d'ete).
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./analysis.js") : root.Analysis);
  if (isNode) module.exports = api; else root.JournalCore = api;
})(typeof self !== "undefined" ? self : this, function (A) {
  "use strict";

  const LOCAL_OFFSET_MIN = 60;                       // Benin : UTC+1 toute l'annee
  const STATUSES = ["WATCH", "REJECT", "UNFILLED", "OPEN", "CLOSED"];
  const TIMEFRAMES = ["D1", "H4", "H1", "M15", "M5"];
  const QUALITIES = ["A", "B", "C"];
  const SESSIONS = ["Asie", "Londres", "Chevauchement", "New York", "Hors session"];
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const DEFAULT_PREFS = {
    setups: ["SMC", "ICT", "Price action", "Support / résistance", "Trendline", "Cassure", "Retournement", "Range"],
    errors: ["FOMO", "Revenge trade", "SL déplacé", "Sortie trop tôt", "Sortie trop tard", "Sur-levier",
      "Hors plan", "Pas de SL", "Trade pendant une annonce", "Entrée précipitée"],
    emotions: ["Calme", "Confiant", "Neutre", "Impatient", "Anxieux", "Euphorique", "Frustré", "Fatigué"],
    checklist: ["Tendance de fond identifiée", "Niveau clé validé", "Pas d'annonce forte à moins de 15 min",
      "Stop-loss défini avant l'entrée", "Risque ≤ limite du plan", "Gain/risque ≥ 1,5", "Spread vérifié"],
    maxRiskPct: 2,
  };
  const DEFAULT_ACCOUNT = { id: "default", name: "Compte démo", type: "demo", currency: "USD", startBalance: 68 };

  // ------------------------------------------------------------------ temps
  const pad = (n) => String(n).padStart(2, "0");
  function local(ms) {
    const d = new Date(ms + LOCAL_OFFSET_MIN * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), wd: d.getUTCDay() };
  }
  const localDay = (ms) => { const l = local(ms); return `${l.y}-${pad(l.m)}-${pad(l.d)}`; };
  const fmtLocal = (ms) => { if (!ms) return ""; const l = local(ms); return `${pad(l.d)}/${pad(l.m)}/${l.y} ${pad(l.h)}:${pad(l.min)}`; };
  const fmtUtc = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
  /** "AAAA-MM-JJTHH:MM" (saisie en heure du Benin) -> ms UTC */
  function parseLocalInput(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - LOCAL_OFFSET_MIN * 60000;
  }
  /** ms UTC -> "AAAA-MM-JJTHH:MM" en heure du Benin (pour un champ datetime-local) */
  function toLocalInput(ms) {
    if (!ms) return "";
    const l = local(ms);
    return `${l.y}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.min)}`;
  }
  function fmtDuration(ms) {
    if (!(ms >= 0)) return "";
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ${pad(m % 60)}`;
    return `${Math.floor(h / 24)} j ${h % 24} h`;
  }
  /** Lundi 00:00 (heure du Benin) de la semaine contenant ms, en ms UTC */
  function weekStart(ms) {
    const l = local(ms), back = (l.wd + 6) % 7;
    return Date.UTC(l.y, l.m - 1, l.d - back) - LOCAL_OFFSET_MIN * 60000;
  }
  function sessionOf(ms) {
    const open = new Set(A.sessionsAt(ms).sessions.filter((x) => x.open).map((x) => x.name));
    if (open.has("Londres") && open.has("New York")) return "Chevauchement";
    if (open.has("Londres")) return "Londres";
    if (open.has("New York")) return "New York";
    if (open.has("Tokyo") || open.has("Sydney")) return "Asie";
    return "Hors session";
  }

  // ------------------------------------------------------------------ calculs d'un trade
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(+v) ? +v : null);
  const isHorsPlan = (t) => (t.errors || []).some((e) => /hors plan/i.test(e));

  /**
   * Chiffres d'un trade. balance = solde du compte au moment de l'entree (pour le risque en %).
   * Resultat brut : celui du courtier s'il est saisi (grossOverride), sinon pips x valeur du pip x lots.
   */
  function metrics(t, balance, maxRiskPct) {
    const out = { errors: [], warnings: [] };
    const p = A.PAIRS[t.symbol];
    if (!p) { out.errors.push("symbole inconnu"); return out; }
    const dir = t.side === "sell" ? -1 : 1;
    const entry = num(t.entry), sl = num(t.sl), tp = num(t.tp), exit = num(t.exit), lots = num(t.lots);
    const pv = num(t.pipValue) != null ? num(t.pipValue) : A.pipValueUsd(t.symbol, entry, null);
    out.pipValueLot = pv;
    const active = t.status === "OPEN" || t.status === "CLOSED";
    if (active) {
      if (entry == null) out.errors.push("prix d'entrée manquant");
      if (sl == null) out.errors.push("stop-loss obligatoire (note celui de départ, même s'il a été déplacé)");
      if (!(lots > 0)) out.errors.push("lots manquants");
      if (!t.entryTime) out.errors.push("date d'entrée manquante");
    }
    if (entry != null && sl != null) {
      if ((dir === 1 && sl >= entry) || (dir === -1 && sl <= entry)) out.errors.push("stop du mauvais côté de l'entrée");
      out.slPips = Math.abs(entry - sl) / p.pip;
      if (lots > 0 && pv) {
        out.riskUsd = out.slPips * pv * lots;
        if (balance > 0) {
          out.riskPct = out.riskUsd / balance * 100;
          if (maxRiskPct != null && out.riskPct > maxRiskPct + 1e-9) out.warnings.push(`risque de ${out.riskPct.toFixed(2)} % supérieur à ta limite de ${maxRiskPct} %`);
        }
      }
    }
    if (entry != null && tp != null) {
      out.tpPips = dir * (tp - entry) / p.pip;
      if (out.slPips) out.plannedRR = out.tpPips / out.slPips;
    }
    if (t.status === "CLOSED") {
      if (exit == null) out.errors.push("prix de sortie manquant (sinon laisse le statut OPEN)");
      if (!t.exitTime) out.errors.push("date de sortie manquante");
      else if (t.entryTime && t.exitTime < t.entryTime) out.errors.push("la sortie est avant l'entrée");
    }
    if (exit != null && entry != null) {
      out.pips = dir * (exit - entry) / p.pip;
      const ov = num(t.grossOverride);
      out.gross = ov != null ? ov : lots > 0 && pv ? out.pips * pv * lots : null;
      if (out.gross == null) out.warnings.push("valeur du pip inconnue : saisis-la, ou le résultat brut du courtier");
    }
    out.commission = num(t.commission) || 0;
    out.swap = num(t.swap) || 0;
    if (t.status === "CLOSED" && out.gross != null) {
      out.net = out.gross - out.commission + out.swap;
      if (out.riskUsd > 0) out.r = out.net / out.riskUsd;
    }
    if (t.entryTime) {
      const l = local(t.entryTime);
      out.session = sessionOf(t.entryTime);
      out.weekday = DAYS[l.wd];
      out.weekdayIndex = l.wd;
      out.hour = l.h;
      out.day = localDay(t.entryTime);
    }
    if (t.entryTime && t.exitTime) out.durationMs = t.exitTime - t.entryTime;
    const items = Object.keys(t.checklist || {});
    out.checklistTotal = items.length;
    out.checklistOk = items.filter((k) => t.checklist[k]).length;
    const overRisk = out.warnings.some((w) => /supérieur à ta limite/.test(w));
    out.inPlan = isHorsPlan(t) || overRisk ? false : items.length ? out.checklistOk === items.length : null;
    return out;
  }

  /** Ajoute les chiffres a chaque trade, avec le solde du compte au moment de l'entree. */
  function enrich(trades, accounts, maxRiskPct) {
    const acc = {};
    (accounts && accounts.length ? accounts : [DEFAULT_ACCOUNT]).forEach((a) => (acc[a.id] = a));
    const first = trades.map((t) => ({ t, m: metrics(t, null, null) }));
    return first.map(({ t }) => {
      const a = acc[t.accountId] || acc.default || Object.values(acc)[0];
      const start = num(a && a.startBalance) || 0;
      const before = first.filter((x) => x.t.accountId === t.accountId && x.t.status === "CLOSED" && x.m.net != null &&
        x.t.exitTime && t.entryTime && x.t.exitTime <= t.entryTime && x.t.id !== t.id).reduce((s, x) => s + x.m.net, 0);
      const balance = start + before;
      return { t, m: Object.assign(metrics(t, balance, maxRiskPct), { balanceAtEntry: balance }) };
    });
  }

  function filterTrades(list, f) {
    f = f || {};
    return list.filter(({ t, m }) =>
      (f.from == null || (t.entryTime && t.entryTime >= f.from)) &&
      (f.to == null || (t.entryTime && t.entryTime < f.to)) &&
      (!f.symbol || t.symbol === f.symbol) && (!f.setup || t.setup === f.setup) &&
      (!f.session || m.session === f.session) && (!f.accountId || t.accountId === f.accountId) &&
      (!f.status || t.status === f.status));
  }

  // ------------------------------------------------------------------ statistiques
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : null);
  function groupStats(items) {
    const nets = items.map((x) => x.m.net), rs = items.map((x) => x.m.r).filter((r) => r != null);
    const wins = nets.filter((n) => n > 0).length;
    return { n: items.length, wins, winRate: items.length ? wins / items.length : null, net: sum(nets), avgR: mean(rs) };
  }
  function by(items, keyFn, order) {
    const g = {};
    items.forEach((x) => { const k = keyFn(x); if (k == null || k === "") return; (g[k] = g[k] || []).push(x); });
    const keys = order ? order.filter((k) => g[k]).concat(Object.keys(g).filter((k) => !order.includes(k))) : Object.keys(g).sort();
    return keys.map((k) => Object.assign({ key: k }, groupStats(g[k])));
  }

  /** Statistiques des trades CLOSED (resultat net connu). startBalance sert a la courbe d'equite. */
  function stats(list, startBalance) {
    const closed = list.filter((x) => x.t.status === "CLOSED" && x.m.net != null).sort((a, b) => (a.t.exitTime || 0) - (b.t.exitTime || 0));
    const nets = closed.map((x) => x.m.net);
    const winsL = closed.filter((x) => x.m.net > 0), lossL = closed.filter((x) => x.m.net < 0);
    const grossWin = sum(winsL.map((x) => x.m.net)), grossLoss = sum(lossL.map((x) => x.m.net));
    const rs = closed.map((x) => x.m.r).filter((r) => r != null);
    // courbe d'equite et drawdown
    let eq = Number(startBalance) || 0, peak = eq, maxDD = 0, maxDDPct = 0;
    const curve = [{ t: closed.length ? closed[0].t.exitTime : null, equity: eq, dd: 0, ddPct: 0 }];
    closed.forEach((x) => {
      eq += x.m.net; peak = Math.max(peak, eq);
      const dd = eq - peak, ddPct = peak > 0 ? dd / peak * 100 : 0;
      maxDD = Math.min(maxDD, dd); maxDDPct = Math.min(maxDDPct, ddPct);
      curve.push({ t: x.t.exitTime, equity: eq, dd, ddPct, id: x.t.id });
    });
    // series
    let curW = 0, curL = 0, bestW = 0, bestL = 0;
    nets.forEach((n) => {
      if (n > 0) { curW++; curL = 0; } else if (n < 0) { curL++; curW = 0; } else { curW = 0; curL = 0; }
      bestW = Math.max(bestW, curW); bestL = Math.max(bestL, curL);
    });
    // erreurs
    const errMap = {};
    closed.forEach((x) => (x.t.errors || []).forEach((e) => {
      const o = (errMap[e] = errMap[e] || { key: e, n: 0, net: 0, losses: 0, rs: [] });
      o.n++; o.net += x.m.net; if (x.m.net < 0) o.losses += x.m.net; if (x.m.r != null) o.rs.push(x.m.r);
    }));
    const errorCost = Object.values(errMap).map((o) => ({ key: o.key, n: o.n, net: o.net, losses: o.losses, avgR: mean(o.rs) }))
      .sort((a, b) => a.net - b.net);
    // respect du plan
    const known = closed.filter((x) => x.m.inPlan != null);
    const inP = known.filter((x) => x.m.inPlan), outP = known.filter((x) => !x.m.inPlan);
    return {
      n: closed.length, wins: winsL.length, losses: lossL.length, breakeven: closed.length - winsL.length - lossL.length,
      winRate: closed.length ? winsL.length / closed.length : null,
      avgWin: mean(winsL.map((x) => x.m.net)), avgLoss: mean(lossL.map((x) => x.m.net)),
      avgWinR: mean(winsL.map((x) => x.m.r).filter((r) => r != null)), avgLossR: mean(lossL.map((x) => x.m.r).filter((r) => r != null)),
      net: sum(nets), expectancyUsd: mean(nets), expectancyR: mean(rs), rCount: rs.length,
      profitFactor: grossLoss < 0 ? grossWin / -grossLoss : grossWin > 0 ? Infinity : null,
      maxDD, maxDDPct, longestWin: bestW, longestLoss: bestL, curve, endBalance: eq,
      bySetup: by(closed, (x) => x.t.setup || "(sans setup)"),
      bySession: by(closed, (x) => x.m.session, SESSIONS),
      byWeekday: by(closed, (x) => x.m.weekday, ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]),
      byHour: by(closed, (x) => (x.m.hour == null ? null : pad(x.m.hour) + " h")),
      bySymbol: by(closed, (x) => x.t.symbol),
      errorCost,
      plan: { known: known.length, rate: known.length ? inP.length / known.length : null, inPlan: groupStats(inP), outPlan: groupStats(outP) },
    };
  }

  /** Resultat net par jour (heure du Benin) pour un mois : {"AAAA-MM-JJ": {net, n}} */
  function calendar(list, year, month) {
    const out = {};
    list.filter((x) => x.t.status === "CLOSED" && x.m.net != null && x.t.exitTime).forEach((x) => {
      const l = local(x.t.exitTime);
      if (l.y !== year || l.m !== month) return;
      const k = localDay(x.t.exitTime);
      out[k] = out[k] || { net: 0, n: 0 };
      out[k].net += x.m.net; out[k].n++;
    });
    return out;
  }

  /** Revue d'une semaine (lundi 00:00 -> lundi suivant, heure du Benin). */
  function weeklyReview(list, anyMsInWeek, startBalance) {
    const from = weekStart(anyMsInWeek), to = from + 7 * 86400000;
    const closedInWeek = list.filter((x) => x.t.status === "CLOSED" && x.t.exitTime >= from && x.t.exitTime < to);
    const enteredInWeek = list.filter((x) => x.t.entryTime >= from && x.t.entryTime < to);
    const s = stats(closedInWeek, startBalance);
    const ranked = closedInWeek.filter((x) => x.m.net != null).sort((a, b) => b.m.net - a.m.net);
    const errCount = {};
    enteredInWeek.forEach((x) => (x.t.errors || []).forEach((e) => (errCount[e] = (errCount[e] || 0) + 1)));
    const statusCount = {};
    enteredInWeek.forEach((x) => (statusCount[x.t.status] = (statusCount[x.t.status] || 0) + 1));
    return {
      from, to, key: localDay(from), stats: s,
      best: ranked.filter((x) => x.m.net > 0).slice(0, 3), worst: ranked.filter((x) => x.m.net < 0).slice(-3).reverse(),
      frequentErrors: Object.entries(errCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, n]) => ({ key, n })),
      statusCount, entered: enteredInWeek.length,
    };
  }

  // ------------------------------------------------------------------ export / import / migration
  const CSV_FIELDS = [
    ["id", (x) => x.t.id], ["compte", (x) => x.t.accountId], ["statut", (x) => x.t.status], ["symbole", (x) => x.t.symbol],
    ["sens", (x) => (x.t.side === "sell" ? "vente" : "achat")], ["lots", (x) => x.t.lots],
    ["entree_utc", (x) => fmtUtc(x.t.entryTime)], ["entree_benin", (x) => fmtLocal(x.t.entryTime)],
    ["sortie_utc", (x) => fmtUtc(x.t.exitTime)], ["sortie_benin", (x) => fmtLocal(x.t.exitTime)],
    ["duree", (x) => fmtDuration(x.m.durationMs)], ["prix_entree", (x) => x.t.entry], ["sl", (x) => x.t.sl], ["tp", (x) => x.t.tp],
    ["prix_sortie", (x) => x.t.exit], ["sl_pips", (x) => r2(x.m.slPips)], ["risque_usd", (x) => r2(x.m.riskUsd)],
    ["risque_pct", (x) => r2(x.m.riskPct)], ["pips", (x) => r2(x.m.pips)], ["brut_usd", (x) => r2(x.m.gross)],
    ["commission", (x) => x.m.commission], ["swap", (x) => x.m.swap], ["net_usd", (x) => r2(x.m.net)], ["r", (x) => r2(x.m.r)],
    ["session", (x) => x.m.session], ["jour", (x) => x.m.weekday], ["setup", (x) => x.t.setup], ["ut_analyse", (x) => x.t.tfAnalysis],
    ["ut_entree", (x) => x.t.tfEntry], ["checklist", (x) => `${x.m.checklistOk}/${x.m.checklistTotal}`],
    ["dans_le_plan", (x) => (x.m.inPlan == null ? "" : x.m.inPlan ? "oui" : "non")], ["qualite", (x) => x.t.quality],
    ["emotion_avant", (x) => x.t.emotionBefore], ["emotion_apres", (x) => x.t.emotionAfter],
    ["erreurs", (x) => (x.t.errors || []).join(" | ")], ["capture", (x) => x.t.screenshot], ["notes", (x) => x.t.notes],
    ["source", (x) => x.t.source], ["ticket_mt5", (x) => x.t.ticket],
  ];
  const r2 = (v) => (v == null || !Number.isFinite(v) ? "" : Math.round(v * 100) / 100);
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;   // pas de formule Excel
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(list) {
    return [CSV_FIELDS.map((f) => f[0]).join(","), ...list.map((x) => CSV_FIELDS.map((f) => csvCell(f[1](x))).join(","))].join("\r\n") + "\r\n";
  }
  /** Nettoie un trade venant d'un import (types, champs inconnus ignores, lien de capture https uniquement). */
  function sanitizeTrade(o) {
    if (!o || typeof o !== "object" || !o.id) return null;
    const s = (v, n = 200) => (v == null ? "" : String(v).slice(0, n));
    const t = {
      id: s(o.id, 80), accountId: s(o.accountId || "default", 80), status: STATUSES.includes(o.status) ? o.status : "WATCH",
      symbol: A.PAIRS[o.symbol] ? o.symbol : "EUR/USD", side: o.side === "sell" ? "sell" : "buy",
      lots: num(o.lots), entry: num(o.entry), sl: num(o.sl), tp: num(o.tp), exit: num(o.exit),
      pipValue: num(o.pipValue), grossOverride: num(o.grossOverride), commission: num(o.commission), swap: num(o.swap),
      entryTime: num(o.entryTime), exitTime: num(o.exitTime),
      setup: s(o.setup, 60), tfAnalysis: TIMEFRAMES.includes(o.tfAnalysis) ? o.tfAnalysis : "", tfEntry: TIMEFRAMES.includes(o.tfEntry) ? o.tfEntry : "",
      checklist: {}, quality: QUALITIES.includes(o.quality) ? o.quality : "",
      emotionBefore: s(o.emotionBefore, 40), emotionAfter: s(o.emotionAfter, 40),
      errors: Array.isArray(o.errors) ? o.errors.map((e) => s(e, 60)).slice(0, 20) : [],
      screenshot: /^https:\/\/[^\s"'<>]+$/i.test(String(o.screenshot || "")) ? s(o.screenshot, 500) : "",
      notes: s(o.notes, 4000), source: s(o.source || "manual", 20), ticket: o.ticket == null ? null : s(o.ticket, 40),
      createdAt: num(o.createdAt) || Date.now(), updatedAt: num(o.updatedAt) || Date.now(),
    };
    if (o.checklist && typeof o.checklist === "object") Object.keys(o.checklist).slice(0, 30).forEach((k) => (t.checklist[s(k, 80)] = !!o.checklist[k]));
    return t;
  }
  /** Ancien journal (localStorage dfx.journal) -> nouveaux trades. */
  function migrateV1(old, accountId) {
    return (Array.isArray(old) ? old : []).map((o) => {
      const at = Date.parse(o.date) || Date.now();
      return sanitizeTrade({
        id: "v1-" + o.id, accountId: accountId || "default", status: o.status, symbol: o.symbol, side: o.side,
        lots: o.lots, entry: o.entry, sl: o.stop, exit: o.exit, commission: o.costs, entryTime: at,
        exitTime: o.status === "CLOSED" ? at : null, notes: o.why ? "Ancien journal : " + o.why : "Importé de l'ancien journal",
        source: "v1", createdAt: at, updatedAt: at,
      });
    }).filter(Boolean);
  }

  // ------------------------------------------------------------------ donnees de demonstration (FICTIVES)
  const DEMO_ACCOUNT_ID = "demo-exemple";
  function demoRng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /**
   * Compte challenge d'exemple et ~3 semaines de trades fictifs (deterministes), tous marques source "demo".
   * Aucun prix reel : sert seulement a decouvrir le journal, les statistiques et les jauges.
   */
  function demoData(nowMs, seed) {
    const rnd = demoRng(seed || 7);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const start = weekStart(nowMs) - 21 * 86400000;            // lundi d'il y a 3 semaines
    const account = { id: DEMO_ACCOUNT_ID, name: "Exemple : challenge 10 000 $", type: "challenge", currency: "USD",
      startBalance: 10000, startDate: start, demo: true, equitySnapshots: [],
      rules: { profitTargetPct: 8, dailyLossPct: 5, dailyBase: "initial", maxDDPct: 10, ddMode: "static", ddBasis: "balance",
        minTradingDays: 4, consistencyPct: 40, maxRiskPerTradePct: 1, newsBan: true, newsWindowMin: 2, dayResetHourLocal: 0 } };
    const specs = { "EUR/USD": { px: 1.092, slPips: 15 }, "GBP/USD": { px: 1.271, slPips: 20 }, "XAU/USD": { px: 3505, slPips: 40 }, "USD/JPY": { px: 150.2, slPips: 25 } };
    const setups = ["Price action", "Support / résistance", "SMC", "Trendline", "Cassure"];
    const trades = [];
    let n = 0;
    for (let d = 0; d < 21; d++) {
      const dayMs = start + d * 86400000, wd = local(dayMs).wd;
      if (wd === 0 || wd === 6) continue;                       // pas de trading le week-end
      const count = rnd() < 0.35 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const symbol = pick(Object.keys(specs)), sp = specs[symbol], p = A.PAIRS[symbol];
        const entryTime = dayMs + (9 + Math.floor(rnd() * 8)) * 3600000 + Math.floor(rnd() * 50) * 60000 - LOCAL_OFFSET_MIN * 60000 + 60 * 60000;
        if (entryTime > nowMs - 3 * 3600000) continue;
        const side = rnd() < 0.5 ? "buy" : "sell", dir = side === "buy" ? 1 : -1;
        const entry = +(sp.px * (1 + (rnd() - 0.5) * 0.01)).toFixed(p.dec);
        const pv = A.pipValueUsd(symbol, entry, null);
        const lots = Math.max(0.01, Math.floor((10000 * 0.008) / (sp.slPips * pv) / 0.01) * 0.01);   // ~0,8 % de risque
        const errs = rnd() < 0.25 ? [pick(["FOMO", "Sortie trop tôt", "Entrée précipitée", "SL déplacé"])] : [];
        const winP = errs.length ? 0.3 : 0.55;
        const rr = 1.5 + Math.round(rnd() * 2) / 4;
        const outcomeR = rnd() < winP ? (errs.includes("Sortie trop tôt") ? 0.6 : rr) : -1;
        const exitPips = outcomeR * sp.slPips;
        const checklist = {};
        DEFAULT_PREFS.checklist.forEach((c) => (checklist[c] = errs.length ? rnd() < 0.6 : true));
        trades.push({
          id: `demo-${++n}`, accountId: DEMO_ACCOUNT_ID, status: "CLOSED", symbol, side, lots: +lots.toFixed(2),
          entry, sl: +(entry - dir * sp.slPips * p.pip).toFixed(p.dec), tp: +(entry + dir * rr * sp.slPips * p.pip).toFixed(p.dec),
          exit: +(entry + dir * exitPips * p.pip).toFixed(p.dec), entryTime, exitTime: entryTime + (30 + Math.floor(rnd() * 240)) * 60000,
          commission: +(lots * 7).toFixed(2), swap: 0, setup: pick(setups), tfAnalysis: pick(["H4", "H1", "D1"]), tfEntry: pick(["M15", "M5", "H1"]),
          checklist, quality: errs.length ? "C" : pick(["A", "B", "B"]), emotionBefore: errs.length ? pick(["Impatient", "Anxieux"]) : pick(["Calme", "Confiant", "Neutre"]),
          emotionAfter: outcomeR > 0 ? pick(["Confiant", "Calme"]) : pick(["Frustré", "Neutre"]), errors: errs,
          notes: "Exemple fictif (données de démonstration).", source: "demo", ticket: null, createdAt: entryTime, updatedAt: entryTime,
        });
      }
    }
    // quelques lignes non executees, pour voir tous les statuts
    const last = trades.length ? trades[trades.length - 1].exitTime : nowMs - 86400000;
    const extra = (id, status, symbol, side, offsetH, more) => trades.push(Object.assign({ id, accountId: DEMO_ACCOUNT_ID, status, symbol, side,
      entryTime: Math.min(nowMs - 3600000, last + offsetH * 3600000), errors: [], checklist: {}, notes: "Exemple fictif (données de démonstration).",
      source: "demo", ticket: null, createdAt: nowMs, updatedAt: nowMs }, more || {}));
    extra("demo-w1", "WATCH", "EUR/USD", "buy", 2, { setup: "Cassure" });
    extra("demo-r1", "REJECT", "XAU/USD", "sell", 3, { setup: "SMC", notes: "Exemple fictif : rejeté, annonce forte dans 10 min." });
    extra("demo-u1", "UNFILLED", "GBP/USD", "buy", 4, { setup: "Support / résistance", entry: 1.268, sl: 1.266, lots: 0.3, notes: "Exemple fictif : ordre limite jamais atteint." });
    return { account, trades };
  }

  return { LOCAL_OFFSET_MIN, STATUSES, DEMO_ACCOUNT_ID, demoData, TIMEFRAMES, QUALITIES, SESSIONS, DAYS, DEFAULT_PREFS, DEFAULT_ACCOUNT,
    local, localDay, fmtLocal, fmtUtc, parseLocalInput, toLocalInput, fmtDuration, weekStart, sessionOf,
    metrics, enrich, filterTrades, stats, calendar, weeklyReview, toCsv, CSV_FIELDS, sanitizeTrade, migrateV1 };
});
