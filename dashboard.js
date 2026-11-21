/* Desk Forex : onglet Dashboard (evolution du compte). Lit le journal existant : pas de deuxieme journal.
 * Calculs dans dashboard-core.js (teste). Lecture seule : aucun ordre.
 */
(function () {
  "use strict";
  const DC = window.DashboardCore, JC = window.JournalCore, CC = window.ChallengeCore, J = window.Journal, D = window.DeskApp;
  if (!DC || !JC || !CC || !J || !D) return;
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

  // ---------------------------------------------------------------- regles prop firm (etape 5)
  const ST = { ok: ["OK", "on"], warn: ["ATTENTION", "WATCH"], fail: ["ÉCHEC", "bad"], progress: ["EN COURS", "off"], off: ["non réglée", "off"] };
  const GLOBAL = { "EN COURS": "WATCH", "OBJECTIF ATTEINT": "on", "RÈGLE VIOLÉE": "bad" };
  const plain = (v) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(2) + " $");
  function ruleGauge(it) {
    const [stText, stCls] = ST[it.status];
    let label, value, sub, fill;
    if (it.key === "daily") {
      label = `Perte journalière max (${it.pct} %)`;
      value = it.status === "fail" ? `franchie (limite ${plain(it.limit)})` : `${plain(Math.max(0, -it.value))} / ${plain(it.limit)}`;
      sub = it.status === "fail" ? "Limite franchie : le challenge est perdu selon cette règle."
        : `Résultat du jour ${money(it.value, true)} · marge restante ${plain(Math.max(0, it.remain))}`;
    } else if (it.key === "total") {
      label = `Perte totale max (${it.pct} %${it.mode === "trailing" ? ", suiveuse" : ""})`;
      value = `${plain(Math.max(0, it.limit - Math.max(0, it.remain)))} / ${plain(it.limit)}`;
      sub = it.status === "fail" ? "Plancher franchi : le challenge est perdu selon cette règle."
        : `${it.basis === "equity" ? "Équité" : "Solde"} ${plain(it.value)} · plancher ${plain(it.floor)} · marge ${plain(Math.max(0, it.remain))}`;
    } else if (it.key === "target") {
      label = `Objectif de profit (${it.pct} %)`;
      value = `${money(it.value, true)} / ${plain(it.limit)}`;
      sub = it.status === "ok" ? "Objectif atteint (vérifie aussi les autres règles)." : `Reste ${plain(Math.max(0, it.limit - it.value))} à gagner · ${Math.round(it.used * 100)} %`;
    } else {
      label = "Jours de trading minimum";
      value = `${it.value} / ${it.limit} jour${it.limit > 1 ? "s" : ""}`;
      sub = it.status === "ok" ? "Nombre de jours atteint." : `Encore ${it.limit - it.value} jour${it.limit - it.value > 1 ? "s" : ""} avec au moins un trade.`;
    }
    fill = it.status === "fail" ? "danger" : it.key === "target" || it.key === "days" ? (it.status === "ok" ? "ok" : "accent")
      : it.used < 0.5 ? "ok" : it.used < 0.7 ? "warn" : "danger";
    const bar = el("div", { class: "gauge-bar" }, el("div", { class: "gauge-fill " + fill }));
    bar.firstChild.style.width = (it.status === "fail" ? 100 : Math.round(it.used * 100)) + "%";
    return el("div", { class: "gauge" },
      el("div", { class: "row between" }, el("span", {}, label), el("span", { class: "row" }, el("b", { class: "mono" }, value), el("span", { class: "pill tiny rule-st " + stCls }, stText))),
      bar, el("small", { class: "rule-sub" }, sub), ...(it.fails || []).slice(0, 3).map((f) => el("small", { class: "rule-fail" }, f)));
  }
  function fillPropForm(acc) {
    const r = CC.normalizeRules(acc.rules);
    $("prDaily").value = r.dailyLossPct || ""; $("prTotal").value = r.maxDDPct || "";
    $("prTarget").value = r.profitTargetPct || ""; $("prDays").value = r.minTradingDays || "";
    $("dbPropHint").textContent = `Pourcentages du solde de départ (${plain(Number(acc.startBalance) || 0)}). Laisse une case vide pour ne pas suivre cette règle. ` +
      "Ce sont les mêmes règles que dans l'onglet Comptes, où tu trouves les options avancées : perte totale suiveuse, base de la perte journalière, heure de remise à zéro, durée limite, annonces.";
  }
  function renderProp(acc, list) {
    const onFlag = !!acc.dashRules;
    $("dbPropOn").checked = onFlag;
    $("dbPropOff").classList.toggle("hidden", onFlag);
    $("dbPropBody").classList.toggle("hidden", !onFlag);
    if (!onFlag) return;
    if (document.activeElement == null || !$("dbPropForm").contains(document.activeElement)) fillPropForm(acc);
    const p = DC.propRules(acc, list, Date.now(), D.getNews ? D.getNews() : []);
    const head = clear($("dbPropHead")), rules = clear($("dbPropRules")), msgs = clear($("dbPropMsgs"));
    if (!p.active) {
      head.append(el("p", { class: "muted small" }, "Aucune limite réglée pour ce compte. Ouvre « Régler les limites » ci-dessous."));
      $("dbPropEdit").open = true;
      return;
    }
    head.append(el("span", { class: "pill " + GLOBAL[p.status] }, p.status),
      el("span", { class: "muted small" }, `Solde des trades ${plain(p.balance)} · profit ${money(p.profit, true)} (dépôts et retraits non comptés)`));
    p.items.filter((i) => i.status !== "off").forEach((i) => rules.append(ruleGauge(i)));
    p.otherFails.forEach((v) => msgs.append(el("p", { class: "small down" }, `ÉCHEC – ${v.rule} : ${v.detail}`)));
    p.alerts.forEach((a) => msgs.append(el("p", { class: "small" }, "⚠ " + a)));
    p.notes.forEach((n) => msgs.append(el("p", { class: "muted small" }, n)));
    msgs.append(el("p", { class: "muted small" }, "Calcul indicatif à partir de ton journal : seules les règles officielles de ta prop firm font foi. ATTENTION = plus de la moitié de la marge utilisée."));
  }
  $("dbPropOn").addEventListener("change", async () => {
    const acc = currentAccount(); if (!acc) return;
    await J.saveAccount(Object.assign({}, acc, { dashRules: $("dbPropOn").checked }));
  });
  $("dbPropForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const acc = currentAccount(); if (!acc) return;
    const v = (id) => ($(id).value === "" ? null : Number($(id).value));
    const vals = { dailyLossPct: v("prDaily"), maxDDPct: v("prTotal"), profitTargetPct: v("prTarget"), minTradingDays: v("prDays") };
    if (Object.values(vals).some((x) => x != null && !(x >= 0))) { toast("Valeurs invalides : nombres positifs uniquement."); return; }
    if ((vals.dailyLossPct || 0) > 100 || (vals.maxDDPct || 0) > 100) { toast("Une perte maximale ne peut pas dépasser 100 %."); return; }
    if (vals.minTradingDays != null) vals.minTradingDays = Math.round(vals.minTradingDays);
    if (document.activeElement) document.activeElement.blur();
    await J.saveAccount(Object.assign({}, acc, { rules: CC.normalizeRules(Object.assign({}, acc.rules || {}, vals)) }));
    toast("Limites enregistrées.");
  });
  $("dbPropMore").addEventListener("click", () => {
    const acc = currentAccount(); D.showTab("accounts");
    if (window.DeskAccounts && acc) window.DeskAccounts.edit(acc.id);
  });

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

  // ---------------------------------------------------------------- calendrier et repartitions (etape 4)
  const nowL = JC.local(Date.now());
  let calY = nowL.y, calM = nowL.m, selDay = null;
  const dayKey = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const longDay = (k) => new Date(k + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  function renderCalendar(acc, list) {
    const m = DC.monthCalendar(acc, list, calY, calM), today = JC.localDay(Date.now());
    $("dbCalTitle").textContent = new Date(Date.UTC(calY, calM - 1, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
    const box = clear($("dbCal"));
    ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"].forEach((d) => box.append(el("div", { class: "cal-h" }, d)));
    const offset = (new Date(Date.UTC(calY, calM - 1, 1)).getUTCDay() + 6) % 7, days = new Date(Date.UTC(calY, calM, 0)).getUTCDate();
    for (let i = 0; i < offset; i++) box.append(el("div", { class: "cal-d empty" }));
    for (let d = 1; d <= days; d++) {
      const k = dayKey(calY, calM, d), c = m.days[k];
      const kind = c ? (c.net > 0 ? " win" : c.net < 0 ? " loss" : " flat") : "";
      const extra = (k === today ? " today" : "") + (k === selDay ? " sel" : "");
      const inner = [el("span", { class: "cal-n" }, d), c ? el("b", { class: "mono" }, el("span", { class: "cal-full" }, money(c.net, true)),
          el("span", { class: "cal-short" }, (c.net > 0 ? "+" : "") + Math.round(c.net))) : null,
        c ? el("small", {}, `${c.n} trade${c.n > 1 ? "s" : ""}`) : null];
      box.append(c ? el("button", { type: "button", class: "cal-d" + kind + extra, "aria-label": `${longDay(k)} : ${money(c.net, true)}`,
        onclick: () => { selDay = selDay === k ? null : k; render(); } }, ...inner) : el("div", { class: "cal-d" + extra }, ...inner));
    }
    const sum = el("div", { class: "cal-total" }, "Total du mois : ", el("b", { class: "mono " + cls(m.total) }, money(m.total, true)),
      ` · ${pl(m.trades, "trade")} · ${m.green} jour${m.green > 1 ? "s" : ""} vert${m.green > 1 ? "s" : ""}, ${m.red} rouge${m.red > 1 ? "s" : ""}`);
    if (m.best) sum.append(` · meilleur jour : ${longDay(m.best.day)} (${money(m.best.net, true)})`);
    if (m.worst) sum.append(` · pire jour : ${longDay(m.worst.day)} (${money(m.worst.net, true)})`);
    box.append(sum);
    // trades du jour choisi
    const items = selDay ? DC.dayTrades(acc, list, selDay) : [];
    $("dbDay").classList.toggle("hidden", !items.length);
    if (!items.length) { selDay = null; return; }
    $("dbDayTitle").textContent = `Trades du ${longDay(selDay)}`;
    const t = el("table", {}, el("thead", {}, el("tr", {}, ...["Clôture", "Symbole", "Sens", "Lots", "Net", "R"].map((h) => el("th", {}, h)))));
    const tb = el("tbody"); t.append(tb);
    items.forEach((x) => tb.append(el("tr", {},
      el("td", { class: "mono" }, JC.fmtLocal(x.t.exitTime).slice(11)), el("td", {}, x.t.symbol), el("td", {}, x.t.side === "sell" ? "Vente" : "Achat"),
      el("td", { class: "mono" }, x.t.lots != null ? String(x.t.lots) : "–"), el("td", { class: "mono " + cls(x.m.net) }, money(x.m.net, true)),
      el("td", { class: "mono " + cls(x.m.r) }, fix(x.m.r, 2)))));
    clear($("dbDayList")).append(el("div", { class: "scroll" }, t));
  }
  const moveMonth = (delta) => { calM += delta; if (calM < 1) { calM = 12; calY--; } if (calM > 12) { calM = 1; calY++; } selDay = null; render(); };
  $("dbCalPrev").addEventListener("click", () => moveMonth(-1));
  $("dbCalNext").addEventListener("click", () => moveMonth(1));
  $("dbCalNow").addEventListener("click", () => { const l = JC.local(Date.now()); calY = l.y; calM = l.m; selDay = null; render(); });

  // largeur par le CSSOM (la CSP interdit l'attribut style)
  const bar = (c, w) => { const s = el("span", { class: c }); s.style.width = w.toFixed(1) + "%"; return s; };
  function splitTable(rows, label, max) {
    if (!rows.length) return el("p", { class: "muted small" }, "Pas encore de trade clôturé.");
    const t = el("table", {}, el("thead", {}, el("tr", {}, ...[label, "Trades", "Réussite", "Net"].map((h) => el("th", {}, h)), el("th", { class: "barcell" }, ""))));
    const tb = el("tbody"); t.append(tb);
    rows.forEach((g) => {
      const w = max > 0 ? Math.abs(g.net) / max * 50 : 0;
      tb.append(el("tr", {}, el("td", {}, g.key), el("td", { class: "mono" }, String(g.n)),
        el("td", { class: "mono" }, g.winRate == null ? "–" : (g.winRate * 100).toFixed(0) + " %"),
        el("td", { class: "mono " + cls(g.net) }, money(g.net, true)),
        el("td", { class: "barcell" }, el("div", { class: "nbar", "aria-hidden": "true" }, g.net ? bar(g.net > 0 ? "up" : "down", w) : null))));
    });
    return el("div", { class: "scroll" }, t);
  }
  function renderBreakdowns(acc, list) {
    const b = DC.breakdowns(acc, list);
    clear($("dbBySymbol")).append(splitTable(b.bySymbol, "Symbole", b.scale.symbol));
    clear($("dbByWeekday")).append(splitTable(b.byWeekday, "Jour", b.scale.weekday));
    clear($("dbBySession")).append(splitTable(b.bySession, "Session", b.scale.session));
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

  // ---------------------------------------------------------------- sauvegarde et restauration (etape 6)
  function renderBackup() {
    const st = J.getState(), msg = clear($("dbBackupMsg"));
    let last = null; try { last = D.store.get("lastBackup", null); } catch (e) { last = null; }
    const flows = st.accounts.reduce((n, a) => n + (a.cashflows || []).length, 0);
    const content = `Dans ce navigateur : ${pl(st.trades.length, "trade")}, ${pl(st.accounts.length, "compte")}, ${pl(flows, "mouvement")} d'argent.`;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    const old = st.trades.length > 0 && (last == null || days >= 7);
    msg.className = "small" + (old ? " down" : "");
    msg.append(last ? `Dernière sauvegarde depuis ce navigateur : ${JC.fmtLocal(last)} (${days === 0 ? "aujourd'hui" : days === 1 ? "hier" : `il y a ${days} jours`}). `
      : "Aucune sauvegarde faite depuis ce navigateur. ", old ? "Pense à sauvegarder. " : "", el("span", { class: "muted" }, content));
  }
  $("dbSave").addEventListener("click", async () => {
    const m = await J.exportBackup();
    renderBackup(); toast(m);
  });
  $("dbRestore").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    const m = await J.importBackup(file);
    if (m) toast(m, 6000);
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
    renderProp(acc, list);
    renderCurve(acc, list);
    renderStats(acc, list);
    renderCalendar(acc, list);
    renderBreakdowns(acc, list);
    renderFlows(acc);
    renderBackup();
  }
  $("cfDate").value = JC.toLocalInput(Date.now());
  J.onChange(render);
  new MutationObserver(() => { if (!$("tab-dash").classList.contains("hidden")) render(); }).observe($("tab-dash"), { attributes: true, attributeFilter: ["class"] });
  render();
})();
