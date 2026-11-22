/* Desk Forex : page « Avant le trade » (calculateur de lot ; discipline a venir).
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
    const st = J.getState(), keep = store.get("dbAccount", "");
    return st.accounts.find((a) => a.id === keep) || st.accounts[0];
  }

  // ---------------------------------------------------------------- calculateur de lot
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
    out.append(el("div", { class: "lc-result" },
      tile("Lot", F.num(r.lots, 2), "arrondi vers le bas", "lc-lot"),
      tile("Montant risqué", F.money(r.riskUsd), `${F.pct(r.riskPct)} du solde · max ${F.money(r.maxRiskUsd)}`, "lc-risk"),
      tile("Objectif RR 2", `${F.num(r.targetPips, 1)} pips`, `gain visé ${F.money(r.targetUsd, true)}`, "up")));
  }
  document.querySelectorAll("#lcSym button").forEach((b) => b.addEventListener("click", () => {
    sym = b.dataset.sym; store.set("lotSym", sym); renderSym(); compute();
  }));
  $("lcBalance").addEventListener("input", () => { balanceTouched = true; compute(); });
  $("lcRisk").addEventListener("input", () => { store.set("lotRisk", $("lcRisk").value); compute(); });
  $("lcStop").addEventListener("input", compute);
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

  // ---------------------------------------------------------------- rendu
  function render() { fillBalance(); renderSym(); compute(); }
  J.onChange(render);
  new MutationObserver(() => { if (!$("tab-pretrade").classList.contains("hidden")) render(); })
    .observe($("tab-pretrade"), { attributes: true, attributeFilter: ["class"] });
  render();
})();
