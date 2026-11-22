/* Desk Forex : page « Avant le trade » : etat du jour (blocage), calculateur de lot, checklist obligatoire, regles.
 * Calculs dans discipline-core.js (teste). LECTURE SEULE : aucun ordre n'est passe.
 */
(function () {
  "use strict";
  const DC = window.DisciplineCore, DB = window.DashboardCore, F = window.Fmt, J = window.Journal, D = window.DeskApp;
  if (!DC || !DB || !F || !J || !D) return;
  const { el, clear, store, toast } = D;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- compte de reference (celui du Dashboard)
  function account() {
    const st = J.getState(), sel = $("dbAccount"), keep = (sel && sel.value) || store.get("dbAccount", "");
    return st.accounts.find((a) => a.id === keep) || st.accounts[0];
  }

  // ---------------------------------------------------------------- calculateur de lot
  let rules = DC.normalizeDisc(store.get("discipline", {}));
  let sym = store.get("lotSym", "XAUUSD"), balanceTouched = false;
  if (!DC.LOT_SYMBOLS[sym]) sym = "XAUUSD";
  $("lcRisk").value = store.get("lotRisk", 1);
  const pipValue = () => (D.cfg.symbols[DC.LOT_SYMBOLS[sym]] || {}).pipValuePerLot || 10;

  function fillBalance() {
    const acc = account();
    if (!acc) return;
    const bal = DB.summary(acc, J.getState().enriched).balance;
    $("lcAccount").textContent = `Solde du compte « ${acc.name} » : ${F.money(bal)}`;
    if (!balanceTouched) $("lcBalance").value = Math.round(bal * 100) / 100;
  }
  function renderSym() {
    document.querySelectorAll("#lcSym button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sym === sym)));
    const s = D.cfg.symbols[DC.LOT_SYMBOLS[sym]];
    $("lcPipInfo").textContent = sym === "XAUUSD"
      ? `Or : 1 pip = ${F.num(s.pipSize, 2)} $ de prix, ${F.money(s.pipValuePerLot)} par pip et par lot (réglable dans Accueil → Moniteur → Réglages).`
      : `EUR/USD : 1 pip = 0,0001, ${F.money(s.pipValuePerLot)} par pip et par lot standard.`;
  }
  let last = null;
  function compute() {
    const r = DC.lotCalc({ balance: $("lcBalance").value, riskPct: $("lcRisk").value, stopPips: $("lcStop").value, pipValuePerLot: pipValue(), rr: 2 });
    last = r.ok ? r : null;
    const out = clear($("lcOut"));
    $("lcSend").disabled = !r.ok;
    if (!r.ok) {
      out.append(el("p", { class: r.reason === "INVALID_INPUT" ? "muted" : "err" }, r.message));
      return;
    }
    const tile = (label, value, sub, c) => el("div", { class: "lc-tile" }, el("span", {}, label), el("b", { class: "mono " + (c || "") }, value), sub ? el("small", {}, sub) : null);
    if (r.riskPct > rules.riskPct + 1e-9) out.append(el("p", { class: "warnline small" }, `Attention : ce calcul risque ${F.pct(r.riskPct)}, plus que ta règle de ${F.pct(rules.riskPct)} par trade.`));
    out.append(el("div", { class: "lc-result" },
      tile("Lot", F.num(r.lots, 2), "arrondi vers le bas", "lc-lot"),
      tile("Montant risqué", F.money(r.riskUsd), `${F.pct(r.riskPct)} du solde · max ${F.money(r.maxRiskUsd)}`, "lc-risk"),
      tile("Objectif RR 2", `${F.num(r.targetPips, 1)} pips`, `gain visé ${F.money(r.targetUsd, true)}`, "up")));
  }
  document.querySelectorAll("#lcSym button").forEach((b) => b.addEventListener("click", () => {
    sym = b.dataset.sym; store.set("lotSym", sym); renderSym(); compute();
  }));
  $("lcBalance").addEventListener("input", () => { balanceTouched = true; compute(); });
  $("lcRisk").addEventListener("input", () => { store.set("lotRisk", $("lcRisk").value); compute(); renderChecklist(); });
  $("lcStop").addEventListener("input", () => { compute(); renderChecklist(); });
  $("lcReset").addEventListener("click", () => { balanceTouched = false; fillBalance(); compute(); });
  $("lcSend").addEventListener("click", () => {
    if (!last) return;
    const acc = account();
    J.openNew({
      accountId: acc ? acc.id : undefined, symbol: DC.LOT_SYMBOLS[sym], status: "WATCH", lots: last.lots,
      notes: `Calculateur : risque ${F.pct(last.riskPct)} = ${F.money(last.riskUsd)} · stop ${F.num(last.stopPips, 1)} pips · objectif RR 2 = ${F.num(last.targetPips, 1)} pips (${F.money(last.targetUsd)}). Complète le sens, l'entrée et le stop en prix.`,
    });
    toast("Trade pré-rempli dans le journal : complète le sens, l'entrée et le stop.", 6000);
  });

  // ---------------------------------------------------------------- discipline : regles, etat du jour, checklist
  let checked = {}, checkedDay = null, status = null;
  if (store.get("lotRisk", null) == null) $("lcRisk").value = rules.riskPct;
  const pctTxt = (v) => F.pct(v, v % 1 ? 1 : 0);

  function renderRules() {
    $("drLoss").value = rules.dailyLossPct; $("drStreak").value = rules.maxConsecLosses; $("drRisk").value = rules.riskPct;
    $("discRulesSum").textContent = `perte max ${pctTxt(rules.dailyLossPct)} par jour · arrêt après ${rules.maxConsecLosses} perte${rules.maxConsecLosses > 1 ? "s" : ""} d'affilée · risque ${pctTxt(rules.riskPct)} par trade`;
  }
  $("discForm").addEventListener("submit", (e) => {
    e.preventDefault();
    rules = DC.normalizeDisc({ dailyLossPct: $("drLoss").value, maxConsecLosses: $("drStreak").value, riskPct: $("drRisk").value });
    store.set("discipline", rules);
    $("lcRisk").value = rules.riskPct; store.set("lotRisk", rules.riskPct);
    checked = {};
    toast("Règles enregistrées.");
    render();
  });

  function renderState() {
    const acc = account();
    if (!acc) return;
    status = DC.dayStatus(acc, J.getState().enriched, Date.now(), rules);
    $("discAcc").textContent = `Compte « ${acc.name} » · aujourd'hui (heure du Bénin)`;
    const box = clear($("discState"));
    const stat = (label, value, c) => el("div", {}, el("span", {}, label), el("b", { class: "mono " + (c || "") }, value));
    const stats = el("div", { class: "disc-stats" },
      stat("Résultat du jour", F.money(status.netToday, true), status.netToday > 0 ? "up" : status.netToday < 0 ? "down" : ""),
      stat("Marge avant la perte max", F.money(Math.max(0, status.remaining))),
      stat("Pertes d'affilée", `${status.consecLosses} / ${rules.maxConsecLosses}`),
      stat("Trades clôturés", String(status.tradesToday)));
    if (status.locked) {
      box.append(el("div", { class: "lock-box", role: "alert" }, lockIcon(),
        el("div", {}, el("b", {}, "Stop pour aujourd'hui, reviens demain."),
          el("p", {}, status.message.replace("Stop pour aujourd'hui, reviens demain. ", "") + ` Reprise demain à 00:00 (heure du Bénin).`))), stats);
    } else {
      box.append(el("div", { class: "ok-box" }, el("b", {}, "Tu peux trader"),
        el("p", {}, `Arrêt si tu perds ${F.money(status.lossLimit)} aujourd'hui (${pctTxt(rules.dailyLossPct)} du solde de ce matin) ou après ${rules.maxConsecLosses} pertes d'affilée.`)), stats);
    }
    $("homeLock").classList.toggle("hidden", !status.locked);
    if (status.locked) $("homeLockMsg").textContent = status.message.replace("Stop pour aujourd'hui, reviens demain. ", "") + " Le bouton « Valider le trade » est bloqué jusqu'à minuit.";
  }
  function lockIcon() {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const rect = document.createElementNS(ns, "rect"); [["x", 4], ["y", 11], ["width", 16], ["height", 10], ["rx", 2]].forEach(([k, v]) => rect.setAttribute(k, v));
    const path = document.createElementNS(ns, "path"); path.setAttribute("d", "M8 11V7a4 4 0 0 1 8 0v4");
    svg.append(rect, path); return svg;
  }

  function newsSoon() {
    const now = Date.now();
    return (D.getNews ? D.getNews() : []).find((e) => e.impact === "high" && Math.abs(e.timeMs - now) <= 15 * 60000);
  }
  function renderChecklist() {
    const today = window.JournalCore.localDay(Date.now());
    if (checkedDay !== today) { checked = {}; checkedDay = today; }
    const items = DC.checklistItems(rules), list = clear($("discList"));
    const soon = newsSoon();
    items.forEach((it, i) => {
      const id = "disc" + i;
      const box = el("input", { type: "checkbox", id });
      box.checked = !!checked[it];
      box.addEventListener("change", () => { checked[it] = box.checked; updateValidate(); });
      let hint = null;
      if (i === 3 && soon) hint = el("small", { class: "warnline" }, `Annonce forte ${soon.currency} « ${soon.event} » à ${F.benin(soon.timeMs)} (Bénin) : attends.`);
      if (i === 4 && last && last.riskPct > rules.riskPct + 1e-9) hint = el("small", { class: "warnline" }, `Ton calcul risque ${F.pct(last.riskPct)} : réduis le lot ou le risque.`);
      list.append(el("label", { class: "disc-item", for: id }, box, el("span", {}, it, hint)));
    });
    updateValidate();
  }
  function updateValidate() {
    const items = DC.checklistItems(rules), n = items.filter((it) => checked[it]).length, done = DC.checklistDone(checked, items);
    const locked = status && status.locked;
    $("discCount").textContent = `${n} / ${items.length}`;
    $("discCount").className = "pill " + (done ? "on" : n ? "WATCH" : "off");
    $("discValidate").disabled = !done || locked;
    $("discHint").className = "small " + (locked ? "err" : done ? "" : "muted");
    $("discHint").textContent = locked ? "Bloqué pour aujourd'hui : tes règles sont atteintes. Reviens demain."
      : done ? "Tout est coché : tu peux valider. Aucun ordre n'est passé, tu exécutes toi-même."
      : `Coche encore ${items.length - n} point${items.length - n > 1 ? "s" : ""} pour pouvoir valider.`;
  }
  $("discValidate").addEventListener("click", () => {
    const items = DC.checklistItems(rules);
    if (!DC.checklistDone(checked, items) || (status && status.locked)) return;
    const acc = account();
    const cl = Object.fromEntries(items.map((it) => [it, true]));
    J.openNew({
      accountId: acc ? acc.id : undefined, symbol: DC.LOT_SYMBOLS[sym], status: "OPEN", lots: last ? last.lots : null, checklist: cl,
      notes: "Validé dans « Avant le trade » : checklist complète." + (last ? ` Calculateur : risque ${F.pct(last.riskPct)} = ${F.money(last.riskUsd)} · stop ${F.num(last.stopPips, 1)} pips · objectif RR 2 = ${F.num(last.targetPips, 1)} pips.` : ""),
    });
    checked = {};
    toast("Trade validé : complète le sens, l'entrée et le stop dans le journal, puis enregistre.", 7000);
  });
  $("homeLockOpen").addEventListener("click", () => D.showTab("pretrade"));

  // ---------------------------------------------------------------- rendu
  function render() { fillBalance(); renderSym(); compute(); renderRules(); renderState(); renderChecklist(); }
  setInterval(() => { renderState(); updateValidate(); }, 60000);          // passage a minuit : le blocage se leve tout seul
  J.onChange(render);
  new MutationObserver(() => { if (!$("tab-pretrade").classList.contains("hidden")) render(); })
    .observe($("tab-pretrade"), { attributes: true, attributeFilter: ["class"] });
  render();
})();
