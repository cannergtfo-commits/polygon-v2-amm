/* Add a title by dropping the .apk in docs/apks/ and appending an object here.
   file is the apk name inside docs/apks/. icon is that title's own art. */
window.SEALFORGE_APPS = [
  {
    name: "Blazar Force",
    kind: "tool",
    icon: "bzb-icon.png",
    file: "BlazarForce.apk",
    version: "1.6",
    size: "189 KB",
    updated: "October 5, 2026",
    summary: "BlazarSwap on your phone. Swap, add liquidity, and stake from an encrypted on-device Polygon wallet.",
    notes: "Official Blazar Force build. The key stays encrypted in the phone keystore. Fund the copied address with POL for gas. Install over an older BlazarSwap app to keep the same wallet. Later builds replace apks/BlazarForce.apk and bump apks/blazarforce.json; the app offers that download.",
    sha256: "a26b6467202fe2b59d76dca2221df730b832a994952e70b08d2fdd429393e794"
  },
  {
    name: "Seal Forge",
    kind: "game",
    icon: "sealforge-logo.png",
    file: "SealForge.apk",
    version: "1.2",
    size: "79 MB",
    updated: "October 5, 2026",
    summary: "Dark-fantasy card game. Build a deck, find a match, and keep your rank on this phone.",
    notes: "Find a match sits you with another player. Host puts your table in the open list so someone can tap it. The game wallet stays on the device.",
    sha256: "88b113855746c4c5451136bdeaec302f24fbd2a6f5db97be89b589e3947eddef"
  }
];
