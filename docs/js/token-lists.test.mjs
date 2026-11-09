// node docs/js/token-lists.test.mjs
import assert from "node:assert/strict";
import { mergeTokenList, isReserved, skeleton, nameProblem, reservedReason } from "./token-lists.mjs";

const base = [{ symbol: "BZB", name: "BlazarBits", address: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807", decimals: 18 }];
const list = {
  tokens: [
    { chainId: 137, address: "0x3333333333333333333333333333333333333333", name: "Grad  Frog", symbol: "FROG", decimals: 18, logoURI: "https://launch.blazarforce.net/img/x.webp", extensions: { pair: "0x33eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } },
    { chainId: 137, address: "0x462d8d82c2b2d2ddabf7f8a93928de09d47a5807", name: "Fake BZB", symbol: "BZB", decimals: 18 },
    { chainId: 1, address: "0x4444444444444444444444444444444444444444", name: "Mainnet", symbol: "ETHX", decimals: 18 },
    { chainId: 137, address: "nope", name: "Bad", symbol: "BAD", decimals: 18 },
    { chainId: 137, address: "0x5555555555555555555555555555555555555555", name: "Js", symbol: "J S\u202e", decimals: 18, logoURI: "javascript:alert(1)" },
    { chainId: 137, address: "0x6666666666666666666666666666666666666666", name: "USD Coin", symbol: "USDC", decimals: 18 },
    { chainId: 137, address: "0x7777777777777777777777777777777777777777", name: "Bzb again", symbol: "bzb", decimals: 18 },
    { chainId: 137, address: "0x8888888888888888888888888888888888888888", name: "Game Gem", symbol: "GEM", decimals: 18, extensions: { pair: "0x88eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", quoteAsset: "BZB", verified: false } },
    { chainId: 137, address: "0x9999999999999999999999999999999999999999", name: "Frog clone", symbol: "frog", decimals: 18 },
  ],
};
const tokens = base.slice();
const added = mergeTokenList(tokens, list, "PolyPump");
assert.equal(added.length, 2); // USDC / BZB / second FROG impersonators dropped; "J S<RLO>" (bidi control in the raw symbol, L-1) too
assert.equal(tokens[0].name, "BlazarBits"); // pinned entry never overridden
assert.equal(added[0].symbol, "FROG");
assert.equal(added[0].name, "Grad Frog");
assert.equal(added[0].pair, "0x33eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
assert.equal(added[0].source, "PolyPump");
assert.ok(!added.some((t) => t.symbol === "JS"));
assert.equal(added[1].symbol, "GEM");
assert.equal(added[1].quoteAsset, "BZB");
// a javascript: logo is still never taken
const js = mergeTokenList(base.slice(), { tokens: [{ chainId: 137, address: "0x" + "5".repeat(40), name: "Js", symbol: "JS", decimals: 18, logoURI: "javascript:alert(1)" }] }, "PolyPump");
assert.equal(js[0].logo, undefined);
assert.ok(added.every((t) => t.unverified === true));
assert.equal(mergeTokenList(tokens, list, "PolyPump").length, 0); // idempotent
assert.deepEqual(mergeTokenList(tokens, null, "x"), []);

// B-2: homoglyph, suffix and name impersonation are dropped; ordinary tokens still merge.
const picker = [
  { symbol: "BzB", name: "BlazarBits", address: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807", decimals: 18 },
  { symbol: "USDC", name: "USD Coin", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  { symbol: "GHST", name: "Aavegotchi", address: "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7", decimals: 18 },
];
const fakes = [
  ["USD\u0421", "Robo"], // Cyrillic С
  ["\u0412ZB", "Robo"], // Cyrillic В
  ["WP\u041eL", "Robo"], // Cyrillic О
  ["USD\u0422", "Robo"], // Cyrillic Т
  ["W\u0411TC", "Robo"], // Cyrillic Б
  ["\u00b5SDC", "Robo"], // micro sign
  ["COIN", "USD \u0421oin"], // Cyrillic С in the name
  ["USDC2", "Robo"],
  ["USDCx", "Robo"],
  ["BB", "BlazarBits"],
  ["BB2", "Blazar Bits"],
  ["XUSDC", "Robo"],
  ["GOTCHI", "Aavegotchi"], // name already in the picker
  ["GH5T", "Aavegotchi\u200b"], // zero-width name copy
];
let n = 0x100;
const addr = () => "0x" + (n++).toString(16).padStart(40, "0");
const hostile = { tokens: fakes.map(([symbol, name]) => ({ chainId: 137, address: addr(), name, symbol, decimals: 18 })) };
hostile.tokens.push({ chainId: 137, address: addr(), name: "Honest Frog", symbol: "HFROG", decimals: 18, extensions: { quoteAsset: "BZB", verified: false }, tags: ["polypump", "thin_pool"] });
hostile.tokens.push({ chainId: 137, address: addr(), name: "Honest Fr0g", symbol: "HFR0G", decimals: 18 }); // skeleton dup of HFROG
hostile.tokens.push({ chainId: 137, address: addr(), name: "Ball Game", symbol: "BALL", decimals: 18, extensions: { quoteAsset: "POL" } });
const pk = picker.slice();
const ok = mergeTokenList(pk, hostile, "PolyPump");
assert.deepEqual(ok.map((t) => t.symbol), ["HFROG", "BALL"]);
assert.equal(ok[0].thinPool, true); // B-4
assert.equal(ok[1].thinPool, undefined);
for (const [symbol, name] of fakes.slice(0, 12)) assert.equal(isReserved(name, symbol), true, `${name}/${symbol}`);
assert.equal(skeleton("USD \u0421oin"), "USDCOIN");

// L-1: invisible / format / bidi characters are stripped first and refused, raw or cleaned.
const hiddenNames = ["My USD\u200bC Token", "USD\u2060Coin", "Teth\ufeffer Gold", "US\u00adDC Coin", "Rev \u202eCDSU"];
for (const n of hiddenNames) assert.match(nameProblem(n) || "", /invisible|text-direction/, JSON.stringify(n));
assert.equal(skeleton("My USD\u200bC Token"), "MYUSDCTOKEN");
// L-2: Latin mixed with another script (Lisu, Coptic); pure scripts are fine.
assert.match(nameProblem("\ua4f4SD Coin") || "", /mix Latin/);
assert.match(nameProblem("USD \u2c9ein") || "", /mix Latin/);
assert.equal(nameProblem("\u041c\u043e\u0441\u043a\u0432\u0430"), null);
// I-1: ordinary words pass, impersonations do not.
for (const sy of ["POLE", "BALE", "UNIX", "ETHE", "LINKX", "DAL", "MAL", "UNL"]) assert.equal(reservedReason("Robo", sy), null, sy);
for (const sy of ["USDC2", "USDCx", "BZB2", "ETHX", "DAl", "link"]) assert.notEqual(reservedReason("Robo", sy), null, sy);
const sneaky = { tokens: [
  ...hiddenNames.map((name, k) => ({ chainId: 137, address: "0x" + (0x900 + k).toString(16).padStart(40, "0"), name, symbol: "SNK" + k, decimals: 18 })),
  { chainId: 137, address: "0x" + "a1".repeat(20), name: "\ua4f4SD Coin", symbol: "LSD", decimals: 18 },
  { chainId: 137, address: "0x" + "a2".repeat(20), name: "Plain", symbol: "US\u200bDC", decimals: 18 },
  { chainId: 137, address: "0x" + "a3".repeat(20), name: "Pole Vault", symbol: "POLE", decimals: 18 },
] };
const pk2 = picker.slice();
assert.deepEqual(mergeTokenList(pk2, sneaky, "PolyPump").map((t) => t.symbol), ["POLE"]);
console.log("token-lists ok");
