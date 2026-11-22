/* Desk Forex : calendrier automatique des annonces (calculs purs, testes avec node --test).
 * Les donnees viennent de data/annonces.json et data/historique-annonces.json (workflow GitHub, toutes les 3 h).
 * Educatif : aucune recommandation d'achat ou de vente, aucun ordre.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./fmt.js") : root.Fmt);
  if (isNode) module.exports = api; else root.AnnoncesCore = api;
})(typeof self !== "undefined" ? self : this, function (F) {
  "use strict";
  const H = 3600000, BENIN = H;                       // heure du Benin : UTC+1 fixe
  const CURRENCIES = ["USD", "EUR"], IMPACTS = ["high", "medium"];
  const FIELDS = ["mesure", "si_superieur", "si_inferieur", "prudence"];
  const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

  // ------------------------------------------------------------------ lecture des fichiers
  function normEvent(e) {
    if (!e || typeof e !== "object") return null;
    const timeMs = Date.parse(e.time), currency = str(e.currency, 3).toUpperCase(), impact = str(e.impact, 10);
    if (!Number.isFinite(timeMs) || !CURRENCIES.includes(currency) || !IMPACTS.includes(impact) || !str(e.title, 100)) return null;
    let comment = null;
    if (e.comment && typeof e.comment === "object" && FIELDS.every((k) => str(e.comment[k], 500))) {
      comment = { by: e.comment.by === "claude" ? "claude" : "regles" };
      FIELDS.forEach((k) => (comment[k] = str(e.comment[k], 500)));
    }
    return { id: str(e.id, 40) || `${currency}|${e.title}|${e.time}`, timeMs, currency, impact, title: str(e.title, 100),
      forecast: str(e.forecast, 20), previous: str(e.previous, 20), actual: str(e.actual, 20),
      sens: [1, -1, 0].includes(e.sens) ? e.sens : 0, comment };
  }
  const byTime = (a, b) => a.timeMs - b.timeMs || a.currency.localeCompare(b.currency) || a.title.localeCompare(b.title);
  /** data/annonces.json -> {ok, source, fetchedMs, checkedMs, error, events}. Un fichier abime donne une liste vide. */
  function normalizeWeek(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    const events = (Array.isArray(d.events) ? d.events : []).map(normEvent).filter(Boolean).sort(byTime);
    return { ok: d.ok !== false && events.length > 0, source: str(d.source, 40), fetchedMs: Date.parse(d.fetchedAt) || null,
      checkedMs: Date.parse(d.checkedAt) || null, error: str(d.error, 300), events };
  }
  /** data/historique-annonces.json -> liste (la plus recente d'abord). */
  function normalizeHistory(doc) {
    const list = doc && Array.isArray(doc.events) ? doc.events : [];
    return list.map(normEvent).filter(Boolean).sort((a, b) => byTime(b, a));
  }
  /** Historique complet : le fichier + les annonces de la semaine deja passees (le workflow ne tourne que toutes les 3 h). */
  function pastEvents(week, history, nowMs) {
    const seen = new Set(), out = [];
    for (const e of [...week.filter((x) => x.timeMs <= nowMs), ...history]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id); out.push(e);
    }
    return out.sort((a, b) => byTime(b, a));
  }
  /** Chiffre reel : celui du fichier, sinon celui que tu as tape (garde dans ce navigateur). */
  const withActuals = (events, actuals) => events.map((e) => (e.actual || !actuals || !actuals[e.id] ? e : Object.assign({}, e, { actual: str(actuals[e.id], 20), actualByUser: true })));

  // ------------------------------------------------------------------ filtres et vues
  /** Date du Benin "AAAA-MM-JJ". */
  const dayKey = (ms) => new Date(ms + BENIN).toISOString().slice(0, 10);
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  /** "mercredi 25/11" (heure du Benin). */
  function dayLabel(ms) {
    const d = new Date(ms + BENIN);
    return `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  function filter(events, f) {
    const c = f && f.currency, i = f && f.impact;
    return events.filter((e) => (!c || c === "all" || e.currency === c) && (!i || i === "all" || e.impact === i));
  }
  /** Vue "today" (jour du Benin), "week" (toute la semaine du fichier) ou "history" (passees, la plus recente d'abord). */
  function view(kind, week, history, nowMs, f) {
    if (kind === "history") return filter(pastEvents(week, history, nowMs), f);
    const list = kind === "today" ? week.filter((e) => dayKey(e.timeMs) === dayKey(nowMs)) : week;
    return filter(list, f);
  }
  /** Groupes par jour : [{key, label, events}]. */
  function byDay(events) {
    const out = [];
    for (const e of events) {
      const k = dayKey(e.timeMs);
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, label: dayLabel(e.timeMs), events: [] });
      out[out.length - 1].events.push(e);
    }
    return out;
  }
  /** Prochaine annonce forte (apres maintenant). */
  const nextHigh = (events, nowMs) => events.filter((e) => e.impact === "high" && e.timeMs > nowMs).sort(byTime)[0] || null;
  /** Annonce forte dans les 30 prochaines minutes (pour le bandeau du site). */
  const soonHigh = (events, nowMs, minutes = 30) => events.filter((e) => e.impact === "high" && e.timeMs > nowMs && e.timeMs - nowMs <= minutes * 60000).sort(byTime)[0] || null;
  /** Format du Moniteur (refus 15 min avant et apres) : {timeMs, currency, event, impact, auto}. */
  const toMonitor = (events) => events.map((e) => ({ timeMs: e.timeMs, currency: e.currency, event: e.title, impact: e.impact, auto: true }));
  /** Tes annonces (saisie, CSV) + les annonces automatiques, sans doublon (meme minute, devise et nom), triees. */
  function mergeNews(manual, auto) {
    const key = (e) => `${Math.round(e.timeMs / 60000)}|${String(e.currency).toUpperCase()}|${String(e.event).toLowerCase().trim()}`;
    const seen = new Set(), out = [];
    for (const e of [...(manual || []), ...(auto || [])]) {
      if (!e || !Number.isFinite(e.timeMs)) continue;
      const k = key(e);
      if (seen.has(k)) continue;
      seen.add(k); out.push(e);
    }
    return out.sort((a, b) => a.timeMs - b.timeMs);
  }
  /**
   * Bandeau d'alerte : annonce(s) forte(s) dans les `before` prochaines minutes, ou publiee(s) il y a moins de `after` minutes
   * (la periode sans trade continue). Format du Moniteur {timeMs, currency, event, impact}.
   * -> {phase: "before"|"after", timeMs, minutes, events} ou null. L'heure la plus proche gagne.
   */
  function alertEvent(news, nowMs, before = 30, after = 15) {
    const near = (news || []).filter((e) => e && e.impact === "high" && Number.isFinite(e.timeMs)
      && e.timeMs - nowMs <= before * 60000 && nowMs - e.timeMs <= after * 60000);
    if (!near.length) return null;
    near.sort((a, b) => Math.abs(a.timeMs - nowMs) - Math.abs(b.timeMs - nowMs) || a.timeMs - b.timeMs);
    const t = near[0].timeMs, events = near.filter((e) => e.timeMs === t);
    const phase = t > nowMs ? "before" : "after";
    const minutes = phase === "before" ? Math.max(1, Math.ceil((t - nowMs) / 60000)) : Math.floor((nowMs - t) / 60000);
    return { phase, timeMs: t, minutes, events };
  }
  /** Age des donnees : {hours, stale} ; "stale" au-dela de 24 h ou si la derniere lecture a echoue. */
  function freshness(week, nowMs) {
    if (!week.fetchedMs) return { hours: null, stale: true };
    const hours = Math.max(0, (nowMs - week.fetchedMs) / H);
    return { hours, stale: hours > 24 || !week.ok };
  }

  // ------------------------------------------------------------------ chiffre reel vs prevision
  const MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  /** "0.3%" -> 0.3 ; "201K" -> 201000 ; "-1,2" -> -1.2 ; "" ou texte -> null. */
  function parseValue(s) {
    let t = String(s == null ? "" : s).trim().replace(/[\s  ]/g, "").replace("−", "-");
    if (!t) return null;
    if (t.includes(",") && !t.includes(".")) t = t.replace(",", ".");
    else t = t.replace(/,/g, "");
    const m = /^([+-]?\d+(?:\.\d+)?)(%|[KMBT])?$/i.exec(t);
    if (!m) return null;
    const v = Number(m[1]);
    return m[2] && m[2] !== "%" ? v * MULT[m[2].toUpperCase()] : v;
  }
  /** "0.3%" -> "0,3 %" (affichage francais). */
  function frValue(s) {
    const t = str(s, 20);
    if (!t) return "–";
    return t.replace(/(\d)\.(\d)/g, "$1,$2").replace(/%$/, F.NBSP + "%");
  }
  /**
   * Lecture educative du chiffre reel : {tone, text} ou null si pas de chiffre reel.
   * tone (vu du dollar) : "pos" plutot positif, "neg" plutot negatif, "flat" conforme, "none" pas de lecture.
   * Compare a la prevision (ou au chiffre precedent s'il n'y a pas de prevision).
   */
  function reading(e) {
    const a = parseValue(e.actual);
    if (a == null) return null;
    let ref = parseValue(e.forecast), refName = "la prévision";
    if (ref == null) { ref = parseValue(e.previous); refName = "le chiffre précédent"; }
    if (ref == null) return { tone: "none", text: "Pas de prévision à comparer." };
    if (!e.sens) return { tone: "none", text: "Pas de lecture automatique pour ce type d'annonce : le marché réagit surtout au ton et aux détails." };
    const diff = a - ref;
    if (Math.abs(diff) < 1e-9) return { tone: "flat", text: `Chiffre réel égal à ${refName} : souvent peu d'effet, le marché l'attendait.` };
    const pos = (diff > 0 ? "au-dessus de" : "en dessous de") + " " + refName;
    const goodForCcy = Math.sign(diff) * e.sens > 0;
    if (e.currency === "USD") {
      return { tone: goodForCcy ? "pos" : "neg", text: `Chiffre réel ${pos} : plutôt ${goodForCcy ? "positif" : "négatif"} pour le dollar.` };
    }
    return { tone: goodForCcy ? "neg" : "pos",
      text: `Chiffre réel ${pos} : plutôt ${goodForCcy ? "positif" : "négatif"} pour l'euro, donc plutôt ${goodForCcy ? "négatif" : "positif"} pour le dollar.` };
  }

  return { CURRENCIES, IMPACTS, FIELDS, normEvent, normalizeWeek, normalizeHistory, pastEvents, withActuals,
    dayKey, dayLabel, filter, view, byDay, nextHigh, soonHigh, toMonitor, mergeNews, alertEvent, freshness, parseValue, frValue, reading };
});
