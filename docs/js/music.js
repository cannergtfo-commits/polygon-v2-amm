(function () {
  var audio = document.getElementById("bgm");
  var btn = document.getElementById("muteBtn");
  if (!audio || !btn) return;
  var muted = localStorage.getItem("blazar_mute") !== "0";
  function label() {
    btn.textContent = muted ? "Sound on" : "Mute";
    btn.setAttribute("aria-pressed", muted ? "true" : "false");
  }
  function apply() {
    audio.volume = 0.35;
    audio.muted = muted;
    if (muted) {
      audio.pause();
      localStorage.setItem("blazar_mute", "1");
      label();
      return;
    }
    var pending = audio.play();
    if (pending && pending.then) {
      pending.then(function () {
        localStorage.setItem("blazar_mute", "0");
        label();
      }).catch(function () {
        muted = true;
        audio.pause();
        localStorage.setItem("blazar_mute", "1");
        label();
      });
    } else {
      localStorage.setItem("blazar_mute", "0");
      label();
    }
  }
  btn.addEventListener("click", function () {
    muted = !muted;
    apply();
  });
  audio.addEventListener("error", function () {
    muted = true;
    localStorage.setItem("blazar_mute", "1");
    label();
  });
  label();
  if (!muted) apply();
})();
