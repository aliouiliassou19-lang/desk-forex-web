const test = require("node:test");
const assert = require("node:assert/strict");
const AC = require("../annonces-core.js");

const ev = (title, time, o = {}) => Object.assign({ id: title, time, currency: "USD", title, impact: "high", forecast: "0.3%", previous: "0.3%", actual: "", sens: 1 }, o);
const WEEK = {
  ok: true, source: "forexfactory-json", fetchedAt: "2026-11-22T19:00:00Z", checkedAt: "2026-11-22T19:00:00Z", error: null,
  events: [
    ev("PMI FR", "2026-11-23T08:15:00Z", { currency: "EUR", impact: "medium" }),
    ev("Core PCE", "2026-11-25T13:30:00Z", { comment: { by: "claude", mesure: "m", si_superieur: "s", si_inferieur: "i", prudence: "p 15 min" } }),
    ev("Claims", "2026-11-25T13:30:00Z", { impact: "medium", forecast: "201K", previous: "203K", sens: -1 }),
    ev("GBP", "2026-11-25T13:30:00Z", { currency: "GBP" }),
    ev("Bad", "demain"),
  ],
};
const T = Date.parse("2026-11-25T10:00:00Z");

test("lecture du fichier : filtre, tri, commentaire", () => {
  const w = AC.normalizeWeek(WEEK);
  assert.equal(w.ok, true);
  assert.deepEqual(w.events.map((e) => e.title), ["PMI FR", "Claims", "Core PCE"]);
  assert.equal(w.events[2].comment.by, "claude");
  assert.equal(w.events[0].comment, null);
  assert.equal(AC.normalizeWeek(null).events.length, 0);
  assert.equal(AC.normalizeWeek({ events: "x" }).ok, false);
  assert.equal(AC.normalizeWeek({ events: [ev("X", "2026-11-25T13:30:00Z", { comment: { by: "claude", mesure: "m" } })] }).events[0].comment, null);
});

test("vues aujourd'hui / semaine / historique et filtres", () => {
  const w = AC.normalizeWeek(WEEK).events;
  const hist = AC.normalizeHistory({ events: [ev("Old CPI", "2026-11-13T13:30:00Z"), ev("PMI FR", "2026-11-23T08:15:00Z", { currency: "EUR", impact: "medium" })] });
  assert.deepEqual(AC.view("today", w, hist, T, {}).map((e) => e.title), ["Claims", "Core PCE"]);
  assert.equal(AC.view("week", w, hist, T, {}).length, 3);
  assert.deepEqual(AC.view("week", w, hist, T, { currency: "EUR" }).map((e) => e.title), ["PMI FR"]);
  assert.deepEqual(AC.view("week", w, hist, T, { impact: "high" }).map((e) => e.title), ["Core PCE"]);
  // historique : sans doublon, la plus recente d'abord, avec les annonces deja passees de la semaine
  const later = Date.parse("2026-11-25T14:00:00Z");
  assert.deepEqual(AC.view("history", w, hist, later, {}).map((e) => e.title), ["Core PCE", "Claims", "PMI FR", "Old CPI"]);
  assert.deepEqual(AC.byDay(AC.view("week", w, hist, T, {})).map((g) => g.label), ["lundi 23/11", "mercredi 25/11"]);
  // jour du Benin : 23:30 UTC le 24 = 00:30 le 25 au Benin
  assert.equal(AC.dayKey(Date.parse("2026-11-24T23:30:00Z")), "2026-11-25");
});

test("prochaine annonce forte, bandeau 30 min, format du moniteur, age", () => {
  const w = AC.normalizeWeek(WEEK);
  assert.equal(AC.nextHigh(w.events, T).title, "Core PCE");
  assert.equal(AC.nextHigh(w.events, Date.parse("2026-11-25T13:31:00Z")), null);
  assert.equal(AC.soonHigh(w.events, T), null);
  assert.equal(AC.soonHigh(w.events, Date.parse("2026-11-25T13:05:00Z")).title, "Core PCE");
  const m = AC.toMonitor(w.events);
  assert.deepEqual(m[2], { timeMs: Date.parse("2026-11-25T13:30:00Z"), currency: "USD", event: "Core PCE", impact: "high", auto: true });
  assert.deepEqual(AC.freshness(w, Date.parse("2026-11-22T21:00:00Z")), { hours: 2, stale: false });
  assert.equal(AC.freshness(w, Date.parse("2026-11-24T21:00:00Z")).stale, true);
  assert.equal(AC.freshness({ fetchedMs: null }, T).stale, true);
});

test("valeurs et chiffre reel vs prevision", () => {
  assert.equal(AC.parseValue("0.3%"), 0.3);
  assert.equal(AC.parseValue("201K"), 201000);
  assert.equal(AC.parseValue("-1,2"), -1.2);
  assert.equal(AC.parseValue("1,234.5"), 1234.5);
  assert.equal(AC.parseValue("−0.1 %"), -0.1);
  assert.equal(AC.parseValue(""), null);
  assert.equal(AC.parseValue("n/a"), null);
  assert.equal(AC.frValue("0.3%"), "0,3" + require("../fmt.js").NBSP + "%");
  assert.equal(AC.frValue(""), "–");
  const r = (o) => AC.reading(Object.assign({ currency: "USD", forecast: "0.3%", previous: "0.2%", actual: "", sens: 1 }, o));
  assert.equal(r({}), null);
  assert.deepEqual(r({ actual: "0.4%" }), { tone: "pos", text: "Chiffre réel au-dessus de la prévision : plutôt positif pour le dollar." });
  assert.equal(r({ actual: "0.2%" }).tone, "neg");
  assert.equal(r({ actual: "0,3" }).tone, "flat");
  assert.equal(r({ actual: "215K", forecast: "201K", sens: -1 }).tone, "neg");          // plus de chomeurs : negatif pour le dollar
  const eur = r({ currency: "EUR", actual: "0.5%" });
  assert.equal(eur.tone, "neg");
  assert.match(eur.text, /positif pour l'euro, donc plutôt négatif pour le dollar/);
  assert.equal(r({ actual: "0.4%", sens: 0 }).tone, "none");
  assert.match(r({ actual: "0.4%", forecast: "" }).text, /chiffre précédent/);
  assert.equal(r({ actual: "0.4%", forecast: "", previous: "" }).tone, "none");
});

test("chiffre reel tape a la main", () => {
  const w = AC.normalizeWeek(WEEK).events;
  const out = AC.withActuals(w, { "Core PCE": "0.4%", Claims: "x".repeat(40) });
  assert.equal(out[2].actual, "0.4%");
  assert.equal(out[2].actualByUser, true);
  assert.equal(out[1].actual.length, 20);
  assert.equal(w[2].actual, "");                                   // la liste d'origine n'est pas modifiee
  assert.equal(AC.withActuals(w, null)[2].actual, "");
});

test("fusion avec tes annonces et bandeau d'alerte", () => {
  const t = Date.parse("2026-11-25T13:30:00Z");
  const manual = [{ timeMs: t, currency: "USD", event: "core pce", impact: "high" }, { timeMs: t + 3600000, currency: "EUR", event: "Lagarde", impact: "high" }];
  const auto = AC.toMonitor(AC.normalizeWeek(WEEK).events);
  const all = AC.mergeNews(manual, auto);
  assert.equal(all.length, 4);                                     // le Core PCE saisi a la main n'est pas compte deux fois
  assert.equal(all.filter((e) => e.auto).length, 2);
  assert.deepEqual(AC.mergeNews(null, [{ timeMs: NaN }]), []);
  // bandeau : 30 min avant, puis 15 min apres
  assert.equal(AC.alertEvent(all, t - 31 * 60000), null);
  const b = AC.alertEvent(all, t - 12 * 60000 - 5000);
  assert.equal(b.phase, "before"); assert.equal(b.minutes, 13); assert.equal(b.events[0].event, "core pce");
  const a = AC.alertEvent(all, t + 4 * 60000);
  assert.equal(a.phase, "after"); assert.equal(a.minutes, 4);
  assert.equal(AC.alertEvent(all, t + 16 * 60000), null);
  assert.equal(AC.alertEvent([{ timeMs: t, currency: "USD", event: "PMI", impact: "medium" }], t - 60000), null);   // impact moyen : pas de bandeau
  // deux annonces fortes a la meme heure
  const two = AC.alertEvent([{ timeMs: t, currency: "USD", event: "A", impact: "high" }, { timeMs: t, currency: "USD", event: "B", impact: "high" }], t - 60000);
  assert.equal(two.events.length, 2);
});
