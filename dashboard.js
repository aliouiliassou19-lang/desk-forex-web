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

  // ---------------------------------------------------------------- courbe et drawdown (etape 3)
  let range = D.store.get("dbRange", "all"), view = null, hoverT = null;
  const ddate = (ms) => { const l = JC.local(ms); return `${String(l.d).padStart(2, "0")}/${String(l.m).padStart(2, "0")}`; };
  const short = (v) => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(1) + " k" : v.toFixed(0));
  /** Graphique en escalier dans le temps (canvas, sans bibliotheque). pts = [{t, v}] tries par t. */
  function timeChart(cv, pts, t0, t1, opts) {
    const css = getComputedStyle(document.documentElement), col = (v) => css.getPropertyValue(v).trim();
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = col("--muted");
    cv._layout = null;
    if (opts.empty) { ctx.textBaseline = "middle"; ctx.fillText(opts.empty, 8, h / 2); return; }
    const vals = pts.map((p) => p.v).concat(opts.base != null ? [opts.base] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (opts.zeroTop) hi = 0;
    if (hi - lo < 1e-9) { const m = Math.max(1, Math.abs(hi) * 0.01); if (!opts.zeroTop) hi += m; lo -= m; }
    const pad = (hi - lo) * 0.08; if (!opts.zeroTop) hi += pad; lo -= pad;
    const padL = 50, padR = 10, padT = 8, padB = 20, pw = w - padL - padR, ph = h - padT - padB;
    const x = (t) => padL + (t1 > t0 ? (t - t0) / (t1 - t0) : 1) * pw, y = (v) => padT + (hi - v) / (hi - lo) * ph;
    // grille et valeurs
    ctx.strokeStyle = col("--line"); ctx.lineWidth = 1; ctx.textBaseline = "middle";
    const rows = h < 180 ? 2 : 4;
    for (let i = 0; i <= rows; i++) {
      const v = lo + (hi - lo) * i / rows, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(opts.fmt(v), 2, yy);
    }
    // dates
    ctx.textBaseline = "alphabetic";
    [t0, (t0 + t1) / 2, t1].forEach((t, i) => {
      const s = ddate(t), tw = ctx.measureText(s).width;
      ctx.fillText(s, i === 0 ? padL : i === 1 ? x(t) - tw / 2 : w - padR - tw, h - 4);
    });
    if (opts.base != null) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = col("--muted");
      ctx.beginPath(); ctx.moveTo(padL, y(opts.base)); ctx.lineTo(w - padR, y(opts.base)); ctx.stroke(); ctx.setLineDash([]);
    }
    // courbe en escalier : le solde ne change qu'a la cloture d'un trade ou a un mouvement d'argent
    const color = col(opts.color);
    ctx.beginPath();
    pts.forEach((p, i) => { if (!i) ctx.moveTo(x(p.t), y(p.v)); else { ctx.lineTo(x(p.t), y(pts[i - 1].v)); ctx.lineTo(x(p.t), y(p.v)); } });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    if (opts.fillTo != null) {
      ctx.lineTo(x(pts[pts.length - 1].t), y(opts.fillTo)); ctx.lineTo(x(pts[0].t), y(opts.fillTo)); ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    }
    // reperes (depots, retraits, point le plus bas)
    (opts.marks || []).forEach((m) => {
      ctx.beginPath(); ctx.arc(x(m.t), y(m.v), 4, 0, Math.PI * 2);
      ctx.fillStyle = col(m.color); ctx.fill(); ctx.strokeStyle = col("--surface"); ctx.lineWidth = 1.5; ctx.stroke();
    });
    // curseur
    if (opts.hoverT != null && opts.hoverT >= t0 && opts.hoverT <= t1) {
      const hx = Math.round(x(opts.hoverT)) + 0.5;
      ctx.strokeStyle = col("--text"); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + ph); ctx.stroke(); ctx.globalAlpha = 1;
    }
    cv._layout = { padL, pw, t0, t1 };
  }
  function drawCharts() {
    if (!view) return;
    const { c, t0, t1, empty } = view;
    const pts = c.points.slice();
    if (!empty && pts[pts.length - 1].t < t1) pts.push(Object.assign({}, pts[pts.length - 1], { t: t1, kind: "now" }));
    const marks = c.points.filter((p) => p.kind === "deposit" || p.kind === "withdrawal")
      .map((p) => ({ t: p.t, v: p.balance, color: p.kind === "deposit" ? "--ok" : "--watch" }));
    timeChart($("dbCurve"), pts.map((p) => ({ t: p.t, v: p.balance })), t0, t1,
      { color: c.endBalance >= c.startBalance ? "--ok" : "--reject", fmt: short, base: c.startBalance, marks, hoverT, empty });
    const low = c.troughT != null ? c.points.find((p) => p.t === c.troughT && p.dd === c.maxDD) : null;
    timeChart($("dbDD"), pts.map((p) => ({ t: p.t, v: p.ddPct })), t0, t1,
      { color: "--reject", fmt: (v) => v.toFixed(1) + " %", zeroTop: true, fillTo: 0, hoverT, empty,
        marks: low ? [{ t: low.t, v: low.ddPct, color: "--reject" }] : [] });
  }
  const INFO = "Passe le doigt ou la souris sur la courbe pour voir le détail.";
  function hoverInfo(t) {
    const ps = view.c.points; let p = ps[0];
    for (const q of ps) { if (q.t <= t) p = q; else break; }
    const what = p.kind === "trade" ? `trade ${p.symbol || ""} ${money(p.amount, true)}` : p.kind === "deposit" ? `dépôt ${money(p.amount, true)}`
      : p.kind === "withdrawal" ? `retrait ${money(p.amount, true)}` : "début de la période";
    $("dbCurveInfo").textContent = `${JC.fmtLocal(p.t)} · ${what} · solde ${money(p.balance)} · drawdown ${money(p.dd)} (${p.ddPct.toFixed(2)} %)`;
  }
  function onPointer(e) {
    const cv = e.currentTarget, L = cv._layout; if (!L || !view || view.empty) return;
    const r = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left - L.padL) / L.pw));
    hoverT = L.t0 + f * (L.t1 - L.t0); hoverInfo(hoverT); drawCharts();
  }
  ["dbCurve", "dbDD"].forEach((id) => {
    $(id).addEventListener("pointermove", onPointer);
    $(id).addEventListener("pointerdown", onPointer);
    $(id).addEventListener("pointerleave", () => { hoverT = null; $("dbCurveInfo").textContent = INFO; drawCharts(); });
  });
  $("dbRange").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]"); if (!b) return;
    range = b.dataset.range; D.store.set("dbRange", range); render();
  });
  function renderCurve(acc, list) {
    if (!DC.PERIODS[range]) range = "all";
    const now = Date.now(), from = DC.rangeStart(range, now);
    $("dbRange").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.range === range));
    const c = DC.curve(acc, list, from), all = range === "all" ? c : DC.curve(acc, list, null);
    const empty = c.points.length < 2 && range === "all" ? "Pas encore de trade clôturé ni de mouvement sur ce compte." : null;
    const t0 = c.points[0].t != null ? c.points[0].t : now - 86400000;
    view = { c, t0, t1: Math.max(now, c.points[c.points.length - 1].t || now), empty };
    hoverT = null; $("dbCurveInfo").textContent = empty ? "" : INFO;
    drawCharts();
    const label = DC.PERIODS[range].toLowerCase();
    const ddSub = (v, at) => `${v.toFixed(2)} %${at ? " · le " + JC.fmtLocal(at).slice(0, 10) : ""}`;
    clear($("dbCurveKpis")).append(
      tile(`Résultat (${label})`, money(c.pnl, true), cls(c.pnl), `${pct(c.pnlPct)}${c.pnlPct != null ? " · " : ""}${pl(c.trades, "trade")}` +
        (c.flows ? ` · mouvements ${money(c.flows, true)}` : "")),
      tile("Solde début → fin", `${money(c.startBalance)} → ${money(c.endBalance)}`),
      tile(`Drawdown max (${label})`, money(c.maxDD), c.maxDD < 0 ? "down" : "", ddSub(c.maxDDPct, c.troughT)),
      tile("Drawdown actuel", money(all.currentDD), all.currentDD < 0 ? "down" : "", `${all.currentDDPct.toFixed(2)} % sous le plus haut`),
      tile("Drawdown max (tout l'historique)", money(all.maxDD), all.maxDD < 0 ? "down" : "", ddSub(all.maxDDPct, all.troughT)));
  }
  let resizeT = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (!$("tab-dash").classList.contains("hidden")) drawCharts(); }, 150);
  });

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
    renderCurve(acc, list);
    renderStats(acc, list);
    renderFlows(acc);
  }
  $("cfDate").value = JC.toLocalInput(Date.now());
  J.onChange(render);
  new MutationObserver(() => { if (!$("tab-dash").classList.contains("hidden")) render(); }).observe($("tab-dash"), { attributes: true, attributeFilter: ["class"] });
  render();
})();
