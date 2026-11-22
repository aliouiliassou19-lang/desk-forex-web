/* Desk Forex : onglet « Annonces », calendrier automatique (USD et EUR, impact fort et moyen).
 * Lit data/annonces.json et data/historique-annonces.json, mis a jour par le workflow GitHub toutes les 3 h.
 * Vues Aujourd'hui / Cette semaine / Historique, filtres, compte a rebours, commentaires educatifs,
 * chiffre reel tape a la main (garde dans ce navigateur). Calculs dans annonces-core.js (teste).
 * Educatif : aucun conseil d'achat ou de vente, aucun ordre.
 */
(function () {
  "use strict";
  const AC = window.AnnoncesCore, F = window.Fmt, D = window.DeskApp, DC = window.DisciplineCore;
  if (!AC || !F || !D) return;
  const { el, clear, store, fetchJson } = D;
  const $ = (id) => document.getElementById(id);
  const dur = (ms) => (DC ? DC.fmtDuration(ms) : Math.round(ms / 60000) + " min");

  const state = { week: AC.normalizeWeek(null), history: [], loaded: false, error: "", loadedAt: 0 };
  let ui = { view: store.get("anView", "today"), currency: store.get("anCcy", "all"), impact: store.get("anImpact", "all") };
  if (!["today", "week", "history"].includes(ui.view)) ui.view = "today";
  let actuals = store.get("actuals", {});
  if (!actuals || typeof actuals !== "object" || Array.isArray(actuals)) actuals = {};
  let histShown = 50;
  const listeners = [];

  // ---------------------------------------------------------------- chargement
  async function load() {
    try {
      const [w, h] = await Promise.all([
        fetchJson("data/annonces.json?t=" + Date.now(), {}, 2),
        fetchJson("data/historique-annonces.json?t=" + Date.now(), {}, 2).catch(() => null),
      ]);
      state.week = AC.normalizeWeek(w);
      state.history = AC.normalizeHistory(h);
      state.error = "";
    } catch (e) {
      state.error = "Calendrier automatique indisponible (hors ligne ?). Tu peux ajouter tes annonces à la main ci-dessous.";
    }
    state.loaded = true; state.loadedAt = Date.now();
    render();
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* un module ne bloque pas les autres */ } });
  }

  const weekEvents = () => AC.withActuals(state.week.events, actuals);
  const historyEvents = () => AC.withActuals(state.history, actuals);

  // ---------------------------------------------------------------- affichage
  function impactPill(impact) {
    return el("span", { class: "pill " + (impact === "high" ? "bad" : "WATCH") }, impact === "high" ? "Fort" : "Moyen");
  }
  function renderNext() {
    const box = clear($("anNext")), now = Date.now();
    const n = AC.nextHigh(weekEvents(), now);
    if (!state.loaded) return;
    if (!n) { box.append(el("p", { class: "muted" }, state.week.events.length ? "Plus d'annonce forte USD/EUR cette semaine." : "")); return; }
    const soon = n.timeMs - now <= 30 * 60000;
    box.classList.toggle("soon", soon);
    box.append(el("div", { class: "an-next-in" },
      el("span", { class: "an-next-lbl" }, "Prochaine annonce forte"),
      el("b", {}, `${n.title} (${n.currency})`),
      el("span", {}, `${AC.dayLabel(n.timeMs)} à ${F.benin(n.timeMs)} (heure du Bénin)`)),
      el("div", { class: "an-count mono", "aria-live": "off" }, "dans " + dur(n.timeMs - now)));
  }
  function renderStatus() {
    const s = $("anStatus"), now = Date.now();
    clear(s);
    if (state.error) { s.append(el("span", { class: "pill bad" }, "Indisponible"), " " + state.error); return; }
    if (!state.loaded) { s.textContent = "Chargement du calendrier…"; return; }
    const fr = AC.freshness(state.week, now);
    const age = fr.hours == null ? "date inconnue" : fr.hours < 1 ? "il y a moins d'une heure" : `il y a ${Math.floor(fr.hours)} h`;
    if (fr.stale) s.append(el("span", { class: "pill WATCH" }, "Données anciennes"), " ");
    s.append(`Calendrier ForexFactory lu ${age}, mis à jour automatiquement toutes les 3 h. Heures du Bénin (UTC+1).`);
    if (!state.week.ok && state.week.error) s.append(" Dernière lecture en échec : les données gardées sont affichées.");
  }

  function commentBox(e) {
    const c = e.comment;
    if (!c) return null;
    const who = c.by === "claude" ? "commentaire de l'IA (Claude)" : "commentaire automatique";
    return el("details", { class: "an-comment" },
      el("summary", {}, "Comprendre cette annonce", el("small", {}, " · " + who)),
      el("dl", {},
        el("dt", {}, "Ce qu'elle mesure"), el("dd", {}, c.mesure),
        el("dt", {}, "▲ Si le chiffre sort au-dessus de la prévision"), el("dd", {}, c.si_superieur),
        el("dt", {}, "▼ Si le chiffre sort en dessous"), el("dd", {}, c.si_inferieur),
        el("dt", {}, "Prudence"), el("dd", {}, c.prudence)),
      el("p", { class: "muted small" }, "Contenu éducatif : ce ne sont pas des conseils d'achat ou de vente, et le marché peut réagir autrement."));
  }
  function actualField(e, now) {
    if (e.timeMs > now) return el("span", { class: "muted" }, "après " + F.benin(e.timeMs));
    if (e.actual && !e.actualByUser) return el("b", {}, AC.frValue(e.actual));
    const inp = el("input", { type: "text", inputmode: "decimal", maxlength: "20", class: "an-actual", value: e.actual || "",
      placeholder: "à taper", "aria-label": `Chiffre réel publié pour ${e.title} (${e.currency})` });
    const save = () => {
      const v = inp.value.trim();
      if ((actuals[e.id] || "") === v) return;
      if (v) actuals[e.id] = v.slice(0, 20); else delete actuals[e.id];
      store.set("actuals", actuals);
      render();
      listeners.forEach((fn) => { try { fn(); } catch (x) { /* */ } });
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", (k) => { if (k.key === "Enter") { k.preventDefault(); inp.blur(); } });
    return inp;
  }
  function item(e, now) {
    const past = e.timeMs <= now;
    const r = past ? AC.reading(e) : null;                // pas de lecture avant la publication
    const li = el("li", { class: "an-item" + (past ? " past" : "") + (e.impact === "high" ? " high" : "") },
      el("div", { class: "an-head" },
        el("span", { class: "an-time mono" }, F.benin(e.timeMs)),
        el("span", { class: "sym-badge" + (e.currency === "EUR" ? "" : " usd") }, e.currency),
        el("b", { class: "an-title" }, e.title),
        impactPill(e.impact)),
      el("div", { class: "an-nums" },
        el("span", {}, "Prévision ", el("b", {}, AC.frValue(e.forecast))),
        el("span", {}, "Précédent ", el("b", {}, AC.frValue(e.previous))),
        el("label", {}, "Réel ", actualField(e, now))));
    if (r) li.append(el("p", { class: "an-reading " + r.tone }, (r.tone === "pos" ? "▲ " : r.tone === "neg" ? "▼ " : "") + r.text,
      e.actualByUser ? el("small", {}, " (chiffre tapé par toi)") : ""));
    const c = commentBox(e);
    if (c) li.append(c);
    return li;
  }
  function renderList() {
    const box = clear($("anList")), now = Date.now();
    if (!state.loaded) return;
    const f = { currency: ui.currency, impact: ui.impact };
    const list = AC.view(ui.view, weekEvents(), historyEvents(), now, f);
    if (!list.length) {
      const msg = state.error ? "Le calendrier automatique n'a pas pu être lu."
        : ui.view === "today" ? "Aucune annonce USD/EUR forte ou moyenne aujourd'hui (avec ces filtres)."
        : ui.view === "week" ? "Aucune annonce cette semaine avec ces filtres."
        : "L'historique se remplit au fil des annonces passées : aucune pour l'instant avec ces filtres.";
      box.append(el("div", { class: "empty-box" }, el("p", {}, msg)));
      return;
    }
    const shown = ui.view === "history" ? list.slice(0, histShown) : list;
    AC.byDay(shown).forEach((g) => {
      box.append(el("h3", { class: "an-day" }, g.label.charAt(0).toUpperCase() + g.label.slice(1) + (AC.dayKey(now) === g.key ? " · aujourd'hui" : "")));
      const ul = el("ul", { class: "an-list" });
      g.events.forEach((e) => ul.append(item(e, now)));
      box.append(ul);
    });
    if (shown.length < list.length) {
      box.append(el("button", { class: "btn ghost small", type: "button", onclick: () => { histShown += 50; renderList(); } },
        `Afficher plus (${list.length - shown.length} restantes)`));
    }
    if (ui.view === "history") box.append(el("p", { class: "muted small" }, "Le calendrier gratuit ne donne pas le chiffre réel : tape-le après la publication (il reste dans ce navigateur) pour voir s'il est plutôt positif ou négatif pour le dollar."));
  }
  function render() {
    document.querySelectorAll("#anView button").forEach((b) => {
      const on = b.dataset.v === ui.view;
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
    });
    $("anCcy").value = ui.currency; $("anImpact").value = ui.impact;
    renderStatus(); renderNext(); renderList();
  }

  // ---------------------------------------------------------------- commandes
  $("anView").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    ui.view = b.dataset.v; histShown = 50; store.set("anView", ui.view); render();
  });
  $("anCcy").addEventListener("change", () => { ui.currency = $("anCcy").value; store.set("anCcy", ui.currency); render(); });
  $("anImpact").addEventListener("change", () => { ui.impact = $("anImpact").value; store.set("anImpact", ui.impact); render(); });
  $("anRefresh").addEventListener("click", load);

  // compte a rebours : toutes les 30 s ; nouvelle lecture toutes les 30 min, ou en ouvrant l'onglet apres 10 min
  setInterval(() => { renderNext(); }, 30000);
  setInterval(load, 30 * 60000);
  new MutationObserver(() => {
    if (!$("tab-news").classList.contains("hidden") && Date.now() - state.loadedAt > 10 * 60000) load();
  }).observe($("tab-news"), { attributes: true, attributeFilter: ["class"] });

  // partage avec le moniteur et le bandeau (etape suivante)
  window.DeskAnnonces = {
    events: () => weekEvents(),
    loaded: () => state.loaded && !state.error,
    onChange: (fn) => listeners.push(fn),
  };
  render();
  load();
})();
