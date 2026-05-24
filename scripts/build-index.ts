#!/usr/bin/env tsx
/**
 * Aggregates every chain.json / assetlist.json / nft-assetlist.json / _IBC/*.json
 * into a single consumable bundle at `dist/registry.json`. Also emits
 * per-network slices (dist/<network>.json) and a `dist/index.json` manifest.
 *
 * Safrimba and Safrochain Hub fetch these at build time.
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");

async function loadJson<T = any>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}
async function isDir(p: string) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

type Chain = any;
type AssetList = { chain_name: string; assets: any[] };
type NftList = { chain_name: string; assets: any[] };
type Ibc = any;

type NetworkBundle = {
  network: "mainnet" | "testnet" | "devnet";
  chains: Record<string, { chain: Chain; assetlist: AssetList; nft_assetlist: NftList }>;
  ibc: Ibc[];
};

const NETWORKS = ["mainnet", "testnet", "devnet"] as const;
const bundles: NetworkBundle[] = [];

for (const network of NETWORKS) {
  const netDir = resolve(ROOT, network);
  if (!(await isDir(netDir))) continue;

  const bundle: NetworkBundle = { network, chains: {}, ibc: [] };
  const folders = await readdir(netDir);

  for (const folder of folders) {
    const fp = resolve(netDir, folder);
    if (!(await isDir(fp))) continue;

    const chain = await loadJson<Chain>(resolve(fp, "chain.json"));
    let assetlist: AssetList = { chain_name: folder, assets: [] };
    let nft: NftList = { chain_name: folder, assets: [] };

    try { assetlist = await loadJson<AssetList>(resolve(fp, "assetlist.json")); } catch { /* optional */ }
    try { nft = await loadJson<NftList>(resolve(fp, "nft-assetlist.json")); } catch { /* optional */ }

    bundle.chains[folder] = { chain, assetlist, nft_assetlist: nft };
  }

  bundles.push(bundle);
}

// _IBC files apply to whichever network contains both chain endpoints.
const ibcFiles = await fg("_IBC/*.json", { cwd: ROOT, absolute: true });
for (const f of ibcFiles) {
  const ibc = await loadJson<Ibc>(f);
  const match = bundles.find(b => b.chains[ibc.chain_1.chain_name] && b.chains[ibc.chain_2.chain_name]);
  if (match) match.ibc.push(ibc);
}

await mkdir(DIST, { recursive: true });

const manifest = {
  version: 1,
  generated_at: new Date().toISOString(),
  networks: bundles.map(b => ({
    network: b.network,
    chain_count: Object.keys(b.chains).length,
    asset_count: Object.values(b.chains).reduce((s, c) => s + c.assetlist.assets.length, 0),
    nft_collection_count: Object.values(b.chains).reduce((s, c) => s + c.nft_assetlist.assets.length, 0),
    ibc_path_count: b.ibc.length,
  })),
};

await writeFile(resolve(DIST, "index.json"), JSON.stringify(manifest, null, 2));
for (const b of bundles) {
  await writeFile(resolve(DIST, `${b.network}.json`), JSON.stringify(b, null, 2));
}
await writeFile(resolve(DIST, "registry.json"), JSON.stringify({ ...manifest, bundles }, null, 2));

console.log("Wrote:");
console.log(`  ${resolve(DIST, "index.json")}`);
console.log(`  ${resolve(DIST, "registry.json")}`);
for (const b of bundles) console.log(`  ${resolve(DIST, `${b.network}.json`)}`);
console.log("\nSummary:");
console.table(manifest.networks);
