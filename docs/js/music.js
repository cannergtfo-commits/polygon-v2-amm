(function () {
  var audio = document.getElementById("bgm");
  var btn = document.getElementById("muteBtn");
  if (!audio || !btn) return;
  var muted = localStorage.getItem("blazar_mute") !== "0";
  function label() {
    btn.textContent = muted ? "Sound off" : "Sound on";
    btn.setAttribute("aria-pressed", muted ? "true" : "false");
  }
  function apply() {
    audio.muted = muted;
    audio.volume = 0.35;
    if (muted) audio.pause();
    else audio.play().catch(function () {});
    localStorage.setItem("blazar_mute", muted ? "1" : "0");
    label();
  }
  btn.addEventListener("click", function () {
    muted = !muted;
    apply();
  });
  label();
  if (!muted) audio.play().catch(function () {});
})();
