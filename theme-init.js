/* Desk Forex : applique le theme choisi (clair ou sombre) avant l'affichage, pour eviter un flash. Sombre par defaut. */
(function () {
  try { if (JSON.parse(localStorage.getItem("dfx.theme")) === "light") document.documentElement.setAttribute("data-theme", "light"); } catch (e) { /* stockage indisponible : theme sombre */ }
})();
