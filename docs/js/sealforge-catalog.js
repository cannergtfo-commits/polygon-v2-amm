/* Add a title by uploading its .apk to the blazar-apps GitHub release
   and appending an object here.
   href must be the release-asset URL so GitHub records the download.
   match is the filename prefix. Counts for every asset with that prefix are added together. */
window.SEALFORGE_APPS = [
  {
    name: "Blazar Force",
    kind: "tool",
    icon: "bzb-icon.png",
    file: "BlazarForce.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/BlazarForce-1.6.apk",
    match: "BlazarForce",
    version: "1.6",
    size: "189 KB",
    updated: "October 5, 2026",
    summary: "BlazarSwap on your phone. Swap, add liquidity, and stake from an encrypted on-device Polygon wallet.",
    notes: "Official Blazar Force build. The key stays encrypted in the phone keystore. Fund the copied address with POL for gas. Install over an older BlazarSwap app to keep the same wallet.",
    sha256: "a26b6467202fe2b59d76dca2221df730b832a994952e70b08d2fdd429393e794"
  },
  {
    name: "Seal Forge",
    kind: "game",
    icon: "sealforge-logo.png?v=icon2",
    file: "SealForge.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/SealForge-1.3.apk",
    match: "SealForge",
    play: "https://play.blazarforce.net",
    version: "1.3",
    size: "79 MB",
    updated: "October 5, 2026",
    summary: "Dark-fantasy card game. Build a deck, find a match, and keep your rank on this phone.",
    notes: "Leaving a match is a loss and closes it. The player who stays gets the win, and the next Find a match is a new queue. Host still lists an open table. The game wallet stays on the device.",
    sha256: "ecbd8f649c4b6c68ed5378a6bd46070130cf5dfb783f1f500ff36b1cd22efdc4"
  },
  {
    name: "Blazar Bastion",
    kind: "game",
    icon: "bastion-icon.png",
    file: "BlazarBastion-0.2.1.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/BlazarBastion-0.2.1.apk",
    match: "BlazarBastion",
    version: "0.2.1",
    size: "99 MB",
    updated: "October 14, 2026",
    summary: "Space-elf tower defense. One hundred frontiers, five towers, and a Polygon vault on the phone.",
    notes: "Tap a pad to raise a tower. Drag Vaela when she is on the field. The vault can create a wallet or import a private key, including a Seal Forge key. Install over an older Blazar Bastion to keep the same save.",
    sha256: "fa2f270ea980fda3ac59385c79bbb6fbb5f52e319087f8e3418f67b343eb2503"
  }
];
