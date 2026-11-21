/* Desk Forex : affichage en francais (nombres 1 234,56, heure du Benin, statuts, lexique).
 * Module pur, teste avec node --test. Les donnees enregistrees et les exports gardent les codes et le point decimal :
 * ce module ne sert qu'a l'affichage. Aucun ordre.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Fmt = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const NBSP = " ";
  const cache = {};
  const nf = (dec) => (cache[dec] = cache[dec] || new Intl.NumberFormat("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  const ok = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  /** 1234.5 -> "1 234,50" (espace insecable, virgule). Valeur absente -> "–". */
  function num(v, dec = 2) {
    if (!ok(v)) return "–";
    const n = Number(v), s = nf(dec).format(Math.abs(n) < 0.5 * 10 ** -dec ? 0 : n);
    return s.replace(/[  \s]/g, NBSP).replace(/^-0(,0+)?$/, "0$1").replace("-", "−");
  }
  /** Avec le signe + pour un nombre positif : "+12,5". */
  const signed = (v, dec = 2) => (!ok(v) ? "–" : (Number(v) > 0 && num(v, dec) !== num(0, dec) ? "+" : "") + num(v, dec));
  /** Montant en dollars : "1 234,56 $" ou "+12,00 $". */
  const money = (v, sign) => (!ok(v) ? "–" : (sign ? signed(v, 2) : num(v, 2)) + NBSP + "$");
  /** Pourcentage : "4,33 %" ou "+4,33 %". */
  const pct = (v, dec = 2, sign) => (!ok(v) ? "–" : (sign ? signed(v, dec) : num(v, dec)) + NBSP + "%");
  /** Texte deja formate en anglais ("+12.3", "1.08765", "N/A") -> francais ; le reste est rendu tel quel. */
  function fromText(s) {
    if (s == null) return "–";
    const t = String(s).trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return t;
    const dec = (t.split(".")[1] || "").length;
    return (t.startsWith("+") ? "+" : "") + num(Number(t), dec);
  }

  // ---------------------------------------------------------------- heure du Benin (UTC+1 fixe, comme le journal)
  const OFFSET = 60 * 60000;
  const p2 = (n) => String(n).padStart(2, "0");
  const parts = (ms, off) => { const d = new Date(ms + off); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
  /** "14:30" (heure du Benin) ; avec date : "18/11 14:30" ; avec annee : "18/11/2026 14:30". */
  function benin(ms, opt) {
    if (!ok(ms)) return "–";
    const o = opt || {}, l = parts(Number(ms), OFFSET), hm = `${p2(l.h)}:${p2(l.mi)}`;
    if (o.year) return `${p2(l.d)}/${p2(l.mo)}/${l.y} ${hm}`;
    return o.date ? `${p2(l.d)}/${p2(l.mo)} ${hm}` : hm;
  }
  /** "13:30 UTC". */
  const utc = (ms) => (!ok(ms) ? "" : (() => { const l = parts(Number(ms), 0); return `${p2(l.h)}:${p2(l.mi)} UTC`; })());
  /** Une ligne de texte : "14:30 (Bénin) · 13:30 UTC". */
  const both = (ms, opt) => (!ok(ms) ? "–" : `${benin(ms, opt)} (Bénin) · ${utc(ms)}`);

  // ---------------------------------------------------------------- statuts (les codes restent dans les donnees)
  const STATUS = {
    WATCH: "À surveiller", REJECT: "Refusé", DATA_MISSING: "Données manquantes", NO_ALERT: "Rien à signaler",
    OPEN: "Ouvert", CLOSED: "Clôturé", UNFILLED: "Non exécuté",
  };
  const status = (code) => STATUS[code] || String(code == null ? "" : code);

  // ---------------------------------------------------------------- lexique (icones ⓘ)
  const GLOSSARY = {
    atr: ["ATR", "L'amplitude moyenne d'une bougie : de combien le prix bouge habituellement sur cette unité de temps (ATR 14 = moyenne des 14 dernières)."],
    rsi: ["RSI", "Un indicateur de 0 à 100 qui mesure la force des dernières hausses et baisses : au-dessus de 70 le prix a beaucoup monté, sous 30 il a beaucoup baissé."],
    ema: ["EMA", "Une moyenne mobile des derniers prix qui donne plus de poids aux plus récents ; EMA20 = moyenne sur les 20 dernières bougies."],
    r: ["R", "Ton résultat compté en « risques » : +2 R veut dire que tu as gagné deux fois ce que tu risquais au stop, −1 R que tu as perdu le risque prévu."],
    drawdown: ["Drawdown", "La baisse de ton solde depuis son plus haut, en dollars ou en pourcentage : plus il est petit, mieux le capital est protégé."],
    spread: ["Spread", "L'écart entre le prix d'achat et le prix de vente proposés par le courtier : c'est un coût que tu paies à chaque trade."],
    pip: ["Pip", "La petite unité de mouvement du prix : sur l'EUR/USD 1 pip = 0,0001 ; sur l'or, ce site compte 1 pip = 0,10 $ de prix."],
    lot: ["Lot", "La taille d'une position : 1 lot standard = 100 000 unités de devise (100 onces pour l'or) ; 0,01 lot = un micro-lot, 100 fois plus petit."],
  };

  return { NBSP, num, signed, money, pct, fromText, benin, utc, both, STATUS, status, GLOSSARY };
});
