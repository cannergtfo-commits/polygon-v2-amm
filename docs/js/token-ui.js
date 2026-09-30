(function () {
  var CFG = window.BLAZARSWAP || { tokens: [] };
  function logo(addr) {
    var t = CFG.tokens.find(function (x) {
      return x.address.toLowerCase() === String(addr || "").toLowerCase();
    });
    return t && t.logo ? t.logo : "";
  }
  function dress(sel) {
    if (!sel || sel.dataset.dressed === "1") return;
    sel.dataset.dressed = "1";
    var wrap = document.createElement("span");
    wrap.className = "tok-pick";
    sel.parentNode.insertBefore(wrap, sel);
    var img = document.createElement("img");
    img.className = "tok-icon";
    img.alt = "";
    wrap.appendChild(img);
    wrap.appendChild(sel);
    var sync = function () {
      var src = logo(sel.value);
      if (src) { img.src = src; img.style.display = ""; }
      else img.style.display = "none";
    };
    sel.addEventListener("change", sync);
    sync();
  }
  ["tokenIn", "tokenOut", "liqTokenA", "liqTokenB"].forEach(function (id) {
    dress(document.getElementById(id));
  });
})();
