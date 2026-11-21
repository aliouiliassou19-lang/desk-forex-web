/* Desk Forex : onglet Dashboard (evolution du compte). Lit le journal existant : pas de deuxieme journal.
 * Calculs dans dashboard-core.js (teste). Lecture seule : aucun ordre.
 */
(function () {
  "use strict";
  const DC = window.DashboardCore, JC = window.JournalCore, J = window.Journal, D = window.DeskApp;
  if (!DC || !JC || !J || !D) return;
  const { el, clear, toast } = D;
  const $ = (id) => document.getElementById(id);
  const money = (v, sign) => (v == null || !Number.isFinite(v) ? "–" : (sign && v > 0 ? "+" : "") + v.toFixed(2) + " $");
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

  // ---------------------------------------------------------------- compte choisi
  function currentAccount() {
    const st = J.getState();
    return st.accounts.find((a) => a.id === $("dbAccount").value) || st.accounts[0];
  }
  function renderAccounts() {
    const s = $("dbAccount"), keep = s.value || D.store.get("dbAccount", "");
    clear(s);
    J.getState().accounts.forEach((a) => { const o = el("option", { value: a.id }, a.name); if (a.id === keep) o.selected = true; s.append(o); });
  }
  $("dbAccount").addEventListener("change", () => { D.store.set("dbAccount", $("dbAccount").value); render(); });

  // ---------------------------------------------------------------- cartes du haut (etape 2)
  const tile = (label, value, c, sub) => el("div", { class: "kpi" }, el("span", {}, label), el("b", { class: "mono " + (c || "") }, value), sub ? el("small", {}, sub) : null);
  const pct = (v) => (v == null || !Number.isFinite(v) ? "" : `${v > 0 ? "+" : ""}${v.toFixed(2)} %`);
  const fix = (v, d) => (v == null || !Number.isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d));
  const pl = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
  function renderSummary(acc, list) {
    const s = DC.summary(acc, list), p = DC.periodPnl(acc, list, Date.now());
    const period = (label, x) => tile(label, money(x.net, true), cls(x.net), `${pct(x.pct)}${x.pct != null ? " · " : ""}${pl(x.n, "trade")} clôturé${x.n > 1 ? "s" : ""}`);
    clear($("dbSummary")).append(
      tile("Solde actuel", money(s.balance), "", `départ ${money(s.start)}`),
      tile("Profit / perte total", money(s.pnl, true), cls(s.pnl), s.pnlPct == null ? "" : `${pct(s.pnlPct)} du capital investi`),
      period("Aujourd'hui", p.day), period("Cette semaine", p.week), period("Ce mois", p.month),
      tile("Capital investi", money(s.capital), "", `dépôts ${money(s.deposits)} · retraits ${money(s.withdrawals)}`));
  }

  // ---------------------------------------------------------------- statistiques (etape 2)
  function renderStats(acc, list) {
    const s = DC.accountStats(acc, list);
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor == null ? "–" : s.profitFactor.toFixed(2);
    clear($("dbStats")).append(
      tile("Trades clôturés", String(s.n), "", `${pl(s.wins, "gagnant")} · ${pl(s.losses, "perdant")}`),
      tile("Taux de réussite", s.winRate == null ? "–" : (s.winRate * 100).toFixed(0) + " %"),
      tile("Gain moyen", money(s.avgWin, true), "up"),
      tile("Perte moyenne", money(s.avgLoss, true), "down"),
      tile("Ratio gain/perte", s.payoffRatio == null ? "–" : s.payoffRatio.toFixed(2), "", "gain moyen ÷ perte moyenne"),
      tile("Profit factor", pf, s.profitFactor > 1 ? "up" : s.profitFactor != null && s.profitFactor < 1 ? "down" : "", "total des gains ÷ total des pertes"),
      tile("Espérance par trade", money(s.expectancyUsd, true), cls(s.expectancyUsd), s.expectancyR != null ? `${fix(s.expectancyR, 2)} R` : "R inconnu (stop manquant)"),
      tile("R moyen", fix(s.expectancyR, 2), cls(s.expectancyR), `gains ${fix(s.avgWinR, 2)} · pertes ${fix(s.avgLossR, 2)}`),
      tile("Plus longue série de gains", pl(s.longestWin, "trade")),
      tile("Plus longue série de pertes", pl(s.longestLoss, "trade")));
  }

  // ---------------------------------------------------------------- depots et retraits
  function renderFlows(acc) {
    const tb = clear($("cfTable").querySelector("tbody"));
    const flows = DC.flowsOf(acc).slice().reverse();
    flows.forEach((f) => tb.append(el("tr", {},
      el("td", { class: "mono" }, JC.fmtLocal(f.t)), el("td", {}, f.type === "withdrawal" ? "Retrait" : "Dépôt"),
      el("td", { class: "mono " + (f.type === "withdrawal" ? "down" : "up") }, money(DC.signed(f), true)), el("td", { class: "wrap" }, f.note || ""),
      el("td", {}, el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        if (!confirm("Supprimer ce mouvement ?")) return;
        await J.saveAccount(Object.assign({}, acc, { cashflows: (acc.cashflows || []).filter((x) => x.id !== f.id) }));
        toast("Mouvement supprimé.");
      } }, "Supprimer")))));
    $("cfEmpty").classList.toggle("hidden", flows.length > 0);
  }
  $("cfForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const acc = currentAccount();
    const f = DC.sanitizeCashflow({ id: "cf" + Date.now().toString(36), t: JC.parseLocalInput($("cfDate").value), type: $("cfType").value,
      amount: Number($("cfAmount").value), note: $("cfNote").value.trim() });
    if (!f) { toast("Indique un montant positif et une date."); return; }
    if (f.type === "withdrawal" && f.amount > DC.summary(acc, J.getState().enriched, f.t).balance + 1e-9 &&
      !confirm("Ce retrait dépasse le solde du compte à cette date. L'enregistrer quand même ?")) return;
    await J.saveAccount(Object.assign({}, acc, { cashflows: (acc.cashflows || []).concat([f]) }));
    $("cfAmount").value = ""; $("cfNote").value = "";
    toast(f.type === "deposit" ? "Dépôt enregistré." : "Retrait enregistré.");
  });

  // ---------------------------------------------------------------- raccourcis
  $("dbAddTrade").addEventListener("click", () => J.openNew({ accountId: currentAccount().id }));
  $("dbImport").addEventListener("click", () => {
    D.showTab("accounts");
    const card = $("mt5Card"); if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ---------------------------------------------------------------- rendu
  function render() {
    renderAccounts();
    const acc = currentAccount();
    if (!acc) return;
    const list = J.getState().enriched;
    renderSummary(acc, list);
    renderStats(acc, list);
    renderFlows(acc);
  }
  $("cfDate").value = JC.toLocalInput(Date.now());
  J.onChange(render);
  new MutationObserver(() => { if (!$("tab-dash").classList.contains("hidden")) render(); }).observe($("tab-dash"), { attributes: true, attributeFilter: ["class"] });
  render();
})();
