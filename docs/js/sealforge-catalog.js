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
    file: "BlazarBastion-0.2.7.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/BlazarBastion-0.2.7.apk",
    match: "BlazarBastion",
    version: "0.2.7",
    size: "99 MB",
    updated: "October 23, 2026",
    summary: "Space-elf tower defense. One hundred frontiers, five towers, and a Polygon vault on the phone.",
    notes: "Smoother battle motion, menu press, and cutscene drift. Install over an older Blazar Bastion to keep the same save.",
    sha256: "57f2c7f1650b67d754749722f11fb7ab1bc6e1b06b1b549a2593e770626933b8"
  },
  {
    name: "Emberline",
    kind: "game",
    icon: "emberline-icon.png",
    file: "Emberline-1.0.3.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/Emberline-1.0.3.apk",
    match: "Emberline",
    version: "1.0.3",
    size: "46 MB",
    updated: "October 21, 2026",
    summary: "Fun hot-seat multiplayer. Pass one phone or tablet around the table.",
    notes: "Units breathe while they wait and step through a longer march when they move. Install over the previous build. Android asks before the install.",
    sha256: "0e4a01da0f6ff015f8778560a66e40ace5f86435a89c78027a1359ffa53b58f6"
  },
  {
    name: "Lyra Starfall",
    kind: "game",
    icon: "lyra-icon.png",
    file: "LyraStarfall-1.0.apk",
    href: "https://github.com/cannergtfo-commits/polygon-v2-amm/releases/download/blazar-apps/LyraStarfall-1.0.apk",
    match: "LyraStarfall",
    play: "https://blazarforce.net/lyra/",
    version: "1.0",
    size: "75 MB",
    updated: "October 20, 2026",
    summary: "Space-elf side scroller. Punch, kick, and shoot from the forest through the city to a dragon.",
    notes: "Install from this shelf. Android asks before the install. The browser game is the same hunt, on this site.",
    sha256: "765959936caeb7b27d8ba2825c26235da6fe0639042a3fbb0a42847292b70c26"
  }
];
