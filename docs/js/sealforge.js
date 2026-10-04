(function () {
  var APPS = window.SEALFORGE_APPS || [];
  var HALLS = [
    { id: "verdant", name: "Verdant", icon: "sealforge/verdant.jpg" },
    { id: "crown", name: "Crown", icon: "sealforge/crown.jpg" },
    { id: "storm", name: "Storm", icon: "sealforge/storm.jpg" },
    { id: "ember", name: "Ember", icon: "sealforge/ember.jpg" }
  ];
  var state = { q: "", hall: "all", kind: "all" };
  var grid = document.getElementById("appGrid");
  var empty = document.getElementById("emptyHall");
  var count = document.getElementById("appCount");
  var sheet = document.getElementById("sheet");
  var q = document.getElementById("storeSearch");

  function hallName(id) {
    var h = HALLS.filter(function (x) { return x.id === id; })[0];
    return h ? h.name : "Hall";
  }
  function matches(app) {
    if (state.hall !== "all" && app.hall !== state.hall) return false;
    if (state.kind !== "all" && app.kind !== state.kind) return false;
    var needle = state.q.trim().toLowerCase();
    if (!needle) return true;
    return (app.name + " " + app.summary + " " + (app.kind || "") + " " + hallName(app.hall)).toLowerCase().indexOf(needle) !== -1;
  }
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c];
    });
  }
  function card(app) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "app-card";
    btn.innerHTML =
      '<img src="' + esc(app.icon || "sealforge/crown.jpg") + '" alt="" />' +
      '<span class="app-copy"><b>' + esc(app.name) + '</b>' +
      '<small>' + esc(hallName(app.hall)) + " · " + esc(app.kind || "App") + "</small>" +
      '<em>' + esc(app.summary) + '</em></span>' +
      '<span class="apk-pill">APK</span>';
    btn.addEventListener("click", function () { openSheet(app); });
    return btn;
  }
  function render() {
    var list = APPS.filter(matches);
    grid.innerHTML = "";
    list.forEach(function (app) { grid.appendChild(card(app)); });
    empty.hidden = list.length !== 0;
    count.textContent = list.length === 1 ? "1 title" : list.length + " titles";
  }
  function openSheet(app) {
    var file = "apks/" + app.file;
    document.getElementById("sheetIcon").src = app.icon || "sealforge/crown.jpg";
    document.getElementById("sheetName").textContent = app.name;
    document.getElementById("sheetMeta").textContent = [app.version ? "v" + app.version : "", app.size || "", app.updated || ""].filter(Boolean).join(" · ");
    document.getElementById("sheetSummary").textContent = app.summary || "";
    document.getElementById("sheetNotes").textContent = app.notes || "";
    document.getElementById("sheetHall").textContent = hallName(app.hall);
    document.getElementById("sheetKind").textContent = app.kind || "App";
    var hash = document.getElementById("sheetHash");
    if (app.sha256) {
      hash.hidden = false;
      hash.textContent = "SHA-256  " + app.sha256;
    } else hash.hidden = true;
    var dl = document.getElementById("sheetDownload");
    dl.href = file;
    dl.setAttribute("download", (app.name || "app").replace(/\s+/g, "-") + ".apk");
    sheet.showModal();
  }
  document.getElementById("sheetClose").addEventListener("click", function () { sheet.close(); });
  sheet.addEventListener("click", function (ev) { if (ev.target === sheet) sheet.close(); });
  q.addEventListener("input", function () { state.q = q.value; render(); });
  document.getElementById("kindRow").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-kind]");
    if (!btn) return;
    state.kind = btn.getAttribute("data-kind");
    document.querySelectorAll("[data-kind]").forEach(function (el) { el.classList.toggle("on", el === btn); });
    render();
  });
  document.getElementById("hallRow").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-hall]");
    if (!btn) return;
    var id = btn.getAttribute("data-hall");
    state.hall = state.hall === id ? "all" : id;
    document.querySelectorAll("[data-hall]").forEach(function (el) {
      el.classList.toggle("on", el.getAttribute("data-hall") === state.hall);
    });
    render();
  });
  var hallRow = document.getElementById("hallRow");
  HALLS.forEach(function (h) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hall";
    btn.setAttribute("data-hall", h.id);
    btn.innerHTML = '<img src="' + h.icon + '" alt="" /><span>' + h.name + "</span>";
    hallRow.appendChild(btn);
  });
  render();
})();
