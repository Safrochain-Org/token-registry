#!/usr/bin/env tsx
/**
 * Cross-file consistency checks that are awkward to express in JSON Schema:
 *  - folder name === chain.json#chain_name
 *  - assetlist.chain_name matches the parent folder
 *  - asset.display is one of the denom_units
 *  - asset.base appears at exponent 0
 *  - asset.base is unique within a chain
 *  - nft.collection_id is unique within a chain
 *  - IBC chain_1/chain_2 chain_names exist as folders in the matching network
 *  - IBC traces on assets resolve to a declared channel
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors: string[] = [];

async function loadJson<T = any>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function isDir(p: string) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

const NETWORKS = ["mainnet", "testnet", "devnet"] as const;

type Asset = {
  type_asset: string;
  base: string;
  display: string;
  denom_units: Array<{ denom: string; exponent: number }>;
  traces?: Array<{ counterparty: { chain_name: string; channel_id?: string }; chain?: { channel_id?: string } }>;
};
type AssetList = { chain_name: string; assets: Asset[] };
type NftList = { chain_name: string; assets: Array<{ collection_id: string }> };
type Chain = { chain_name: string; network_type: string };
type Ibc = {
  chain_1: { chain_name: string };
  chain_2: { chain_name: string };
  channels: Array<{
    chain_1: { channel_id: string; port_id: string };
    chain_2: { channel_id: string; port_id: string };
  }>;
};

const chainsByNet: Record<string, Set<string>> = { mainnet: new Set(), testnet: new Set(), devnet: new Set() };

for (const net of NETWORKS) {
  const netDir = resolve(ROOT, net);
  if (!(await isDir(netDir))) continue;
  const entries = await readdir(netDir);

  for (const folder of entries) {
    const folderPath = resolve(netDir, folder);
    if (!(await isDir(folderPath))) continue;

    const chainPath = resolve(folderPath, "chain.json");
    let chain: Chain;
    try {
      chain = await loadJson<Chain>(chainPath);
    } catch {
      errors.push(`${net}/${folder}/chain.json — missing or unreadable`);
      continue;
    }

    if (chain.chain_name !== folder) {
      errors.push(`${net}/${folder}/chain.json — chain_name "${chain.chain_name}" does not match folder "${folder}"`);
    }
    if (chain.network_type !== net) {
      errors.push(`${net}/${folder}/chain.json — network_type "${chain.network_type}" does not match parent folder "${net}"`);
    }
    chainsByNet[net].add(folder);

    // ---- assetlist ----
    try {
      const al = await loadJson<AssetList>(resolve(folderPath, "assetlist.json"));
      if (al.chain_name !== folder) errors.push(`${net}/${folder}/assetlist.json — chain_name "${al.chain_name}" ≠ folder`);

      const seenBases = new Set<string>();
      for (const a of al.assets) {
        if (seenBases.has(a.base)) errors.push(`${net}/${folder}/assetlist.json — duplicate base "${a.base}"`);
        seenBases.add(a.base);

        const denoms = new Set(a.denom_units.map(u => u.denom));
        if (!denoms.has(a.display)) errors.push(`${net}/${folder}/assetlist.json — asset "${a.base}" display "${a.display}" not in denom_units`);

        const zero = a.denom_units.find(u => u.exponent === 0);
        if (!zero) errors.push(`${net}/${folder}/assetlist.json — asset "${a.base}" has no exponent-0 denom_unit`);
        else if (zero.denom !== a.base) errors.push(`${net}/${folder}/assetlist.json — asset "${a.base}" exponent-0 denom "${zero.denom}" must equal base`);
      }
    } catch {
      // assetlist optional but recommended; warn rather than error
      console.warn(`note: ${net}/${folder}/assetlist.json missing`);
    }

    // ---- nft list ----
    try {
      const nl = await loadJson<NftList>(resolve(folderPath, "nft-assetlist.json"));
      if (nl.chain_name !== folder) errors.push(`${net}/${folder}/nft-assetlist.json — chain_name "${nl.chain_name}" ≠ folder`);
      const seenIds = new Set<string>();
      for (const c of nl.assets) {
        if (seenIds.has(c.collection_id)) errors.push(`${net}/${folder}/nft-assetlist.json — duplicate collection_id "${c.collection_id}"`);
        seenIds.add(c.collection_id);
      }
    } catch {
      console.warn(`note: ${net}/${folder}/nft-assetlist.json missing`);
    }
  }
}

// ---- _IBC ----
const ibcFiles = await fg("_IBC/*.json", { cwd: ROOT, absolute: true });
const ibcChannelsByChain: Record<string, Set<string>> = {};

for (const f of ibcFiles) {
  const ibc = await loadJson<Ibc>(f);
  const a = ibc.chain_1.chain_name;
  const b = ibc.chain_2.chain_name;

  const expected = [a, b].sort().join("-") + ".json";
  if (basename(f) !== expected) errors.push(`_IBC/${basename(f)} — filename must be ${expected} (alphabetical)`);

  // both chains must exist in one matching network (mainnet↔mainnet, testnet↔testnet)
  const matchingNet = NETWORKS.find(n => chainsByNet[n].has(a) && chainsByNet[n].has(b));
  if (!matchingNet) errors.push(`_IBC/${basename(f)} — chains "${a}" and "${b}" are not both declared in the same network folder`);

  for (const ch of ibc.channels) {
    (ibcChannelsByChain[a] ??= new Set()).add(ch.chain_1.channel_id);
    (ibcChannelsByChain[b] ??= new Set()).add(ch.chain_2.channel_id);
  }
}

// ---- asset traces must point at declared IBC channels ----
const assetlists = await fg(["mainnet/*/assetlist.json", "testnet/*/assetlist.json"], { cwd: ROOT, absolute: true });
for (const f of assetlists) {
  const al = await loadJson<AssetList>(f);
  for (const a of al.assets) {
    for (const t of a.traces ?? []) {
      if (t.counterparty?.channel_id) {
        const remote = t.counterparty.chain_name;
        const ch = t.counterparty.channel_id;
        if (!ibcChannelsByChain[remote]?.has(ch)) {
          errors.push(`${f.replace(ROOT + "/", "")} — asset "${a.base}" trace counterparty channel ${remote}/${ch} not found in _IBC/`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`\n${errors.length} lint error(s):`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`Lint clean — ${Object.values(chainsByNet).reduce((s, set) => s + set.size, 0)} chain(s), ${ibcFiles.length} IBC file(s).`);
