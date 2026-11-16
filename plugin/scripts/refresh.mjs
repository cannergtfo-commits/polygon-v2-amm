#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refresh } from "../src/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PLUGIN_DATA_DIR || path.join(here, "..", "data");
const full = process.argv.includes("--full");
const summary = await refresh({ dataDir, full, log: (m) => console.error(`[refresh] ${m}`) });
console.log(JSON.stringify(summary, null, 2));
