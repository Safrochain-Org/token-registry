#!/usr/bin/env tsx
/**
 * Rewrites every relative "./images/..." reference in chain.json / assetlist.json /
 * nft-assetlist.json into a full raw.githubusercontent.com URL so external
 * consumers (Safrimba, Keplr, Mintscan, …) can pull logos without cloning.
 *
 *   default: https://raw.githubusercontent.com/safrochain/token-registry/main/<network>/<chain>/images/<file>
 *   override: REGISTRY_REPO="org/repo" REGISTRY_BRANCH="main" pnpm tsx scripts/rewrite-image-urls.ts
 *
 * Idempotent — already-absolute URLs are left alone.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.REGISTRY_REPO || "Safrochain-Org/token-registry";
const BRANCH = process.env.REGISTRY_BRANCH || "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

function rewriteValue(val: unknown, fileRel: string): unknown {
  if (typeof val === "string" && val.startsWith("./images/")) {
    // fileRel is something like "testnet/safrochain/assetlist.json"
    // chain folder is the parent of that file (testnet/safrochain)
    const chainFolder = dirname(fileRel);
    const stripped = val.replace(/^\.\//, "");
    return `${RAW_BASE}/${chainFolder}/${stripped}`;
  }
  if (Array.isArray(val)) return val.map(v => rewriteValue(v, fileRel));
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as object)) out[k] = rewriteValue(v, fileRel);
    return out;
  }
  return val;
}

const patterns = [
  "mainnet/*/chain.json",
  "testnet/*/chain.json",
  "devnet/*/chain.json",
  "mainnet/*/assetlist.json",
  "testnet/*/assetlist.json",
  "devnet/*/assetlist.json",
  "mainnet/*/nft-assetlist.json",
  "testnet/*/nft-assetlist.json",
  "devnet/*/nft-assetlist.json",
];

const files = await fg(patterns, { cwd: ROOT });
console.log(`Rewriting ${files.length} file(s) → ${RAW_BASE}/<network>/<chain>/images/...`);

let changed = 0;
for (const rel of files) {
  const abs = resolve(ROOT, rel);
  const original = await readFile(abs, "utf8");
  const data = JSON.parse(original);
  const rewritten = rewriteValue(data, rel);
  const next = JSON.stringify(rewritten, null, 2) + "\n";
  if (next !== original) {
    await writeFile(abs, next);
    changed++;
    console.log(`  ✓ ${rel}`);
  }
}
console.log(`\nDone — ${changed} file(s) modified.`);
