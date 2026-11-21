/* Desk Forex : import des trades MetaTrader 5 (calculs purs, testes avec node --test).
 * Sources : rapport d'historique MT5 (HTML ou Excel, lu en lignes de cellules) ou fichier JSON du script
 * outils/mt5_export.py. LECTURE SEULE : rien n'est jamais envoye a MT5.
 */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./analysis.js") : root.Analysis);
  if (isNode) module.exports = api; else root.Mt5Core = api;
})(typeof self !== "undefined" ? self : this, function (A) {
  "use strict";

  const ALIASES = [["GOLD", "XAU/USD"], ["XAUUSD", "XAU/USD"], ["SILVER", "XAG/USD"], ["XAGUSD", "XAG/USD"]];
  /** Symbole du courtier (EURUSD, EURUSDm, EURUSD.pro, GOLD...) -> paire du site, ou null. */
  function mapSymbol(raw) {
    const s = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "");
    for (const [k, v] of ALIASES) if (s.startsWith(k)) return v;
    if (s.length >= 6) { const p = s.slice(0, 3) + "/" + s.slice(3, 6); if (A.PAIRS[p]) return p; }
    return null;
  }
  /** "1 234.56", "-0.70", "1 234,56" -> nombre ; vide -> null */
  function num(v) {
    if (v == null) return null;
    let s = String(v).replace(/[\s  ]/g, "");
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
    if (s === "" || s === "-") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  /** "2026.11.18 15:30:12" (heure du serveur MT5) -> ms UTC, avec le decalage du serveur en heures. */
  function parseMt5Time(s, offsetHours) {
    const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || "").trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - (Number(offsetHours) || 0) * 3600000;
  }
  const isTime = (s) => /^\d{4}[.\-/]\d{2}[.\-/]\d{2}[ T]\d{2}:\d{2}/.test(String(s || "").trim());
  const sideOf = (s) => (/^(buy|achat|kauf|compra)/i.test(String(s).trim()) ? "buy" : /^(sell|vente|verkauf|venta)/i.test(String(s).trim()) ? "sell" : null);

  /**
   * Rapport d'historique MT5 -> positions closes.
   * Le tableau "Positions" du rapport a 13 colonnes dans cet ordre (quelle que soit la langue) :
   * Heure ouverture | Position | Symbole | Type | Volume | Prix | S/L | T/P | Heure fermeture | Prix | Commission | Swap | Profit
   * Les tableaux "Ordres" (colonne Etat) et "Transactions" (colonne Commission en 9e) sont ignores.
   */
  function parseReportRows(rows, offsetHours) {
    let login = null, currency = null;
    const positions = [];
    for (const raw of rows) {
      // les cellules vides restent a leur place (un SL ou TP absent ne doit pas decaler les colonnes)
      const cells = raw.map((x) => String(x == null ? "" : x).trim());
      const joined = cells.filter(Boolean).join(" ");
      if (!login && /(account|compte|konto|cuenta)\s*:?/i.test(joined)) {
        const m = /(\d{5,12})/.exec(joined); if (m) login = m[1];
        const cur = /\b(USD|EUR|GBP|JPY|CHF|XOF)\b/.exec(joined); if (cur) currency = cur[1];
      }
      if (cells.length < 13 || !isTime(cells[0]) || !/^\d+$/.test(cells[1]) || !sideOf(cells[3]) || !isTime(cells[8])) continue;
      if (num(cells[4]) == null || num(cells[9]) == null || num(cells[12]) == null) continue;   // ligne d'ordre ("0.01 / 0.01", "filled")
      positions.push({
        ticket: cells[1], symbol: cells[2], side: sideOf(cells[3]), volume: num(cells[4]),
        openTime: parseMt5Time(cells[0], offsetHours), openPrice: num(cells[5]), sl: num(cells[6]) || null, tp: num(cells[7]) || null,
        closeTime: parseMt5Time(cells[8], offsetHours), closePrice: num(cells[9]),
        commission: -(num(cells[10]) || 0), swap: num(cells[11]) || 0, profit: num(cells[12]),
      });
    }
    return { source: "report", login, currency, positions, open: [], snapshot: null };
  }

  /** Fichier JSON produit par outils/mt5_export.py -> meme structure. */
  function normalizeExport(data) {
    if (!data || data.app !== "desk-forex" || data.kind !== "mt5") throw new Error("Ce fichier n'est pas un export MT5 de Desk Forex.");
    const acc = data.account || {};
    const pos = (p, open) => ({
      ticket: String(p.ticket), symbol: String(p.symbol || ""), side: p.side === "sell" ? "sell" : "buy", volume: num(p.volume),
      openTime: num(p.openTime), openPrice: num(p.openPrice), sl: num(p.sl) || null, tp: num(p.tp) || null,
      closeTime: open ? null : num(p.closeTime), closePrice: open ? null : num(p.closePrice),
      commission: num(p.commission) || 0, swap: num(p.swap) || 0, profit: num(p.profit),
    });
    const t = Date.parse(data.exportedAt) || Date.now();
    return {
      source: "script", login: acc.login != null ? String(acc.login) : null, currency: acc.currency || null,
      server: acc.server || "", mode: acc.mode || "", exportedAt: t, serverOffsetHours: num(data.serverOffsetHours),
      positions: (Array.isArray(data.positions) ? data.positions : []).map((p) => pos(p, false)),
      open: (Array.isArray(data.open) ? data.open : []).map((p) => pos(p, true)),
      snapshot: num(acc.equity) != null ? { t, equity: num(acc.equity), balance: num(acc.balance), source: "MT5" } : null,
      warnings: Array.isArray(data.warnings) ? data.warnings.map(String).slice(0, 10) : [],
    };
  }

  const MANUAL = ["setup", "tfAnalysis", "tfEntry", "checklist", "quality", "emotionBefore", "emotionAfter", "errors", "screenshot", "notes", "pipValue"];
  /**
   * Positions -> trades du journal. Dedoublonnage par ticket MT5 (identifiant "mt5-<login>-<ticket>").
   * Un trade deja present garde ses champs manuels (setup, emotions, erreurs, capture, notes...).
   */
  function toTrades(norm, accountId, existing, nowMs) {
    const byId = {};
    (existing || []).forEach((t) => (byId[t.id] = t));
    const out = { upserts: [], created: 0, updated: 0, unchanged: 0, skipped: [] };
    const login = norm.login || "inconnu";
    const handle = (p, open) => {
      const symbol = mapSymbol(p.symbol);
      if (!symbol) { out.skipped.push({ ticket: p.ticket, symbol: p.symbol, reason: "symbole non suivi par le site" }); return; }
      if (!p.openTime || p.openPrice == null || !(p.volume > 0)) { out.skipped.push({ ticket: p.ticket, symbol: p.symbol, reason: "ligne incomplète" }); return; }
      const id = `mt5-${login}-${p.ticket}`, old = byId[id];
      if (old && old.status === "CLOSED" && open) { out.unchanged++; return; }   // deja clos : on ne revient pas en arriere
      const broker = {
        id, accountId: old ? old.accountId : accountId, status: open ? "OPEN" : "CLOSED", symbol, side: p.side, lots: p.volume,
        entry: p.openPrice, sl: p.sl, tp: p.tp, exit: open ? null : p.closePrice, entryTime: p.openTime, exitTime: open ? null : p.closeTime,
        grossOverride: open ? null : p.profit, commission: Math.round(p.commission * 100) / 100, swap: Math.round(p.swap * 100) / 100,
        source: "mt5", ticket: String(p.ticket),
      };
      const t = Object.assign({ errors: [], checklist: {}, createdAt: nowMs }, old || {}, broker, { updatedAt: nowMs });
      if (old) MANUAL.forEach((k) => { if (old[k] !== undefined) t[k] = old[k]; });
      if (old && !old.sl && p.sl == null) t.sl = old.sl;        // stop saisi a la main conserve si MT5 n'en donne pas
      const same = old && ["status", "lots", "entry", "exit", "entryTime", "exitTime", "grossOverride", "commission", "swap", "sl", "tp"].every((k) => old[k] === t[k]);
      if (same) { out.unchanged++; return; }
      out.upserts.push(t); old ? out.updated++ : out.created++;
    };
    norm.positions.forEach((p) => handle(p, false));
    norm.open.forEach((p) => handle(p, true));
    return out;
  }

  /** Compte du site lie a ce login MT5, sinon null. */
  const accountForLogin = (accounts, login) => (login ? (accounts || []).find((a) => String(a.mt5Login || "") === String(login)) || null : null);

  return { mapSymbol, num, parseMt5Time, parseReportRows, normalizeExport, toTrades, accountForLogin };
});
