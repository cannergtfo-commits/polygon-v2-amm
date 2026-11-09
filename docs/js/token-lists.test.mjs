// node docs/js/token-lists.test.mjs
import assert from "node:assert/strict";
import { mergeTokenList } from "./token-lists.mjs";

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
assert.equal(added.length, 3); // USDC / BZB / second FROG impersonators dropped
assert.equal(tokens[0].name, "BlazarBits"); // pinned entry never overridden
assert.equal(added[0].symbol, "FROG");
assert.equal(added[0].name, "Grad Frog");
assert.equal(added[0].pair, "0x33eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
assert.equal(added[0].source, "PolyPump");
assert.equal(added[1].symbol, "JS");
assert.equal(added[1].logo, undefined);
assert.equal(added[2].symbol, "GEM");
assert.equal(added[2].quoteAsset, "BZB");
assert.ok(added.every((t) => t.unverified === true));
assert.equal(mergeTokenList(tokens, list, "PolyPump").length, 0); // idempotent
assert.deepEqual(mergeTokenList(tokens, null, "x"), []);
console.log("token-lists ok");
