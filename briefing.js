/* Desk Forex : page « Briefing » (Accueil) : sessions de Londres et New York avec compte a rebours,
 * et « Mon briefing du jour » en 3 lignes pour l'or et l'EUR/USD (analyse existante H4/H1 + annonces).
 * Calculs dans discipline-core.js (teste). LECTURE SEULE : aucun ordre, aucune prediction de direction.
 */
(function () {
  "use strict";
  const DC = window.DisciplineCore, F = window.Fmt, D = window.DeskApp;
  if (!DC || !F || !D) return;
  const { el, clear, toast } = D;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- sessions et compte a rebours
  let clock = null;
  function renderSessions() {
    const now = Date.now();
    if (!clock || clock.some((s) => s.nextAt != null && s.nextAt <= now)) clock = DC.sessionClock(now);   // recalcul a chaque ouverture / fermeture
    const box = clear($("bfSessions"));
    clock.forEach((s) => {
      const left = s.nextAt != null ? `${s.open ? "ferme" : "ouvre"} dans ${DC.fmtDuration(s.nextAt - now)}` : "horaire inconnu";
      box.append(el("div", { class: "bf-session" + (s.open ? " open" : "") },
        el("div", { class: "row between" }, el("b", {}, s.name), el("span", { class: "pill " + (s.open ? "on" : "off") }, s.open ? "Ouverte" : "Fermée")),
        el("p", { class: "bf-count mono" }, left),
        el("small", {}, s.hours ? `${s.open ? "Aujourd'hui" : "Prochaine séance"} : ${s.hours} (heure du Bénin)` : "")));
    });
  }

  // ---------------------------------------------------------------- briefing du jour
  async function runBriefing() {
    const btn = $("bfRun"), status = $("bfStatus"), out = clear($("bfOut"));
    const hasKey = !!(D.getKey && D.getKey());
    const API = window.DeskAnalysis;
    btn.disabled = true;
    const now = Date.now();
    try {
      for (const pair of DC.BRIEF_PAIRS) {
        let tech = null, err = null;
        if (hasKey && API) {
          status.textContent = `Analyse de ${pair}…`;
          try { tech = (await API.get(pair)).tech; } catch (e) { err = e.message; }
        }
        const b = DC.briefLines(pair, tech, D.getNews(), now);
        const line = (icon, text, c) => el("li", { class: c || "" }, el("span", { class: "bf-ico", "aria-hidden": "true" }, icon), el("span", {}, text));
        const trendTxt = b.trend || (hasKey ? `Tendance : indisponible (${err || "analyse impossible"}).` : "Tendance : ajoute ta clé Twelve Data pour l'analyse H4/H1.");
        const levelsTxt = b.levels || (hasKey ? "Niveaux clés : indisponibles." : "Niveaux clés : ajoute ta clé Twelve Data pour les supports et résistances.");
        out.append(el("article", { class: "bf-pair" },
          el("div", { class: "row between wrap" }, D.symBadge(pair),
            b.trendDir ? el("span", { class: "pill " + (b.trendDir === "up" ? "on" : b.trendDir === "down" ? "bad" : "WATCH") },
              b.trendDir === "up" ? "Haussier" : b.trendDir === "down" ? "Baissier" : b.trendDir === "mixed" ? "Mixte" : "Neutre") : null),
          el("ol", { class: "bf-lines" },
            line("1", trendTxt, b.trendDir === "up" ? "up-line" : b.trendDir === "down" ? "down-line" : ""),
            line("2", levelsTxt),
            line("3", b.news, b.newsCount ? "warn-line" : ""))));
      }
      status.textContent = hasKey ? `Briefing de ${F.benin(now)} (heure du Bénin). Analyse gardée 5 min : la relancer ne coûte rien pendant ce temps.`
        : `Briefing de ${F.benin(now)} sans clé : seules les annonces sont affichées.`;
      $("bfNoKey").classList.toggle("hidden", hasKey);
    } catch (e) { status.textContent = e.message; toast(e.message, 6000); }
    finally { btn.disabled = false; }
  }
  $("bfRun").addEventListener("click", runBriefing);
  $("bfAddKey").addEventListener("click", () => { D.showTab("monitor"); const k = $("keyInput"); if (k) { k.scrollIntoView({ block: "center" }); k.focus(); } });

  // ---------------------------------------------------------------- rendu
  const visible = () => !$("tab-briefing").classList.contains("hidden");
  new MutationObserver(() => { if (visible()) { renderSessions(); $("bfNoKey").classList.toggle("hidden", !!(D.getKey && D.getKey())); } })
    .observe($("tab-briefing"), { attributes: true, attributeFilter: ["class"] });
  setInterval(() => { if (visible()) renderSessions(); }, 30000);
  if (visible()) renderSessions();
})();
