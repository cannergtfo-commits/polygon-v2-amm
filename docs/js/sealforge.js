(function () {
  var APPS = window.SEALFORGE_APPS || [];
  var state = { q: "", kind: "all" };
  var grid = document.getElementById("appGrid");
  var empty = document.getElementById("emptyHall");
  var count = document.getElementById("appCount");
  var sheet = document.getElementById("sheet");
  var q = document.getElementById("storeSearch");

  function kindLabel(kind) {
    if (kind === "game") return "Game";
    if (kind === "tool") return "Tool";
    return "App";
  }
  function matches(app) {
    if (state.kind !== "all" && app.kind !== state.kind) return false;
    var needle = state.q.trim().toLowerCase();
    if (!needle) return true;
    return (app.name + " " + (app.summary || "") + " " + kindLabel(app.kind)).toLowerCase().indexOf(needle) !== -1;
  }
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return "&#" + c.charCodeAt(0) + ";";
    });
  }
  function fileName(app) {
    return (app.name || "app").replace(/\s+/g, "-") + ".apk";
  }
  function card(app) {
    var wrap = document.createElement("article");
    wrap.className = "app-card";
    var art = document.createElement("button");
    art.type = "button";
    art.className = "app-art";
    art.innerHTML = '<img src="' + esc(app.icon) + '" alt="" />';
    art.addEventListener("click", function () { openSheet(app); });
    var body = document.createElement("div");
    body.className = "app-body";
    var meta = [kindLabel(app.kind), app.version ? "v" + app.version : "", app.size || ""].filter(Boolean).join(" · ");
    body.innerHTML =
      '<div class="app-copy"><b>' + esc(app.name) + "</b><small>" + esc(meta) + "</small><em>" + esc(app.summary) + "</em></div>" +
      '<div class="app-actions"><a class="connect" href="apks/' + esc(app.file) + '" download="' + esc(fileName(app)) + '">Download APK</a>' +
      '<button class="ghost" type="button">Details</button></div>';
    body.querySelector("button").addEventListener("click", function () { openSheet(app); });
    wrap.appendChild(art);
    wrap.appendChild(body);
    return wrap;
  }
  function render() {
    var list = APPS.filter(matches);
    grid.innerHTML = "";
    list.forEach(function (app) { grid.appendChild(card(app)); });
    empty.hidden = list.length !== 0;
    count.textContent = list.length === 1 ? "1 title" : list.length + " titles";
  }
  function openSheet(app) {
    document.getElementById("sheetArt").src = app.icon || "";
    document.getElementById("sheetName").textContent = app.name;
    document.getElementById("sheetMeta").textContent = [app.version ? "v" + app.version : "", app.size || "", app.updated || ""].filter(Boolean).join(" · ");
    document.getElementById("sheetSummary").textContent = app.summary || "";
    document.getElementById("sheetNotes").textContent = app.notes || "";
    document.getElementById("sheetKind").textContent = kindLabel(app.kind);
    var hash = document.getElementById("sheetHash");
    if (app.sha256) {
      hash.hidden = false;
      hash.textContent = "SHA-256  " + app.sha256;
    } else hash.hidden = true;
    var dl = document.getElementById("sheetDownload");
    dl.href = "apks/" + app.file;
    dl.setAttribute("download", fileName(app));
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
  render();
})();
