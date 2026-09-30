(function () {
  var style = document.createElement("style");
  style.textContent = ".field-top{display:flex;justify-content:space-between;align-items:center;gap:12px}.field-top span{color:var(--muted);font-size:12px}";
  document.head.appendChild(style);
  var CFG = window.BLAZARSWAP;
  function $(id) { return document.getElementById(id); }
  function token(addr) {
    return (CFG.tokens || []).find(function (t) {
      return t.address.toLowerCase() === String(addr || "").toLowerCase();
    });
  }
  async function refreshLiq() {
    var a = $("balLiqA");
    var b = $("balLiqB");
    if (!a || !b || !window.ethereum || !window.ethers) return;
    try {
      var provider = new ethers.BrowserProvider(window.ethereum);
      var accounts = await provider.send("eth_accounts", []);
      if (!accounts.length) {
        a.textContent = "Balance —";
        b.textContent = "Balance —";
        return;
      }
      var account = accounts[0];
      async function one(selectId, label) {
        var t = token($(selectId).value);
        if (!t) { label.textContent = "Balance —"; return; }
        var c = new ethers.Contract(t.address, ["function balanceOf(address) view returns (uint256)"], provider);
        var bal = await c.balanceOf(account);
        label.textContent = "Balance " + Number(ethers.formatUnits(bal, t.decimals)).toPrecision(6);
      }
      await Promise.all([one("liqTokenA", a), one("liqTokenB", b)]);
    } catch (err) {
      a.textContent = "Balance —";
      b.textContent = "Balance —";
    }
  }
  ["liqTokenA", "liqTokenB"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("change", refreshLiq);
  });
  ["connectBtn", "addLiqBtn", "removeLiqBtn"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("click", function () { setTimeout(refreshLiq, 1200); });
  });
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on("accountsChanged", function () { setTimeout(refreshLiq, 400); });
  }
  refreshLiq();
})();
