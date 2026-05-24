#!/usr/bin/env tsx
/**
 * Validates every chain.json / assetlist.json / nft-assetlist.json / _IBC/*.json
 * file against its JSON Schema. Exits non-zero on the first failure.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

async function loadJson<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

async function compile(schemaPath: string) {
  const schema = await loadJson(resolve(ROOT, "schemas", schemaPath));
  return ajv.compile(schema as object);
}

type Result = { file: string; ok: boolean; errors?: string };

async function validateGroup(label: string, pattern: string | string[], schemaPath: string): Promise<Result[]> {
  const validator = await compile(schemaPath);
  const files = await fg(pattern, { cwd: ROOT, absolute: true });
  const out: Result[] = [];
  for (const file of files) {
    const data = await loadJson(file);
    const ok = validator(data);
    if (ok) {
      out.push({ file, ok: true });
    } else {
      out.push({
        file,
        ok: false,
        errors: ajv.errorsText(validator.errors, { separator: "\n  " }),
      });
    }
  }
  console.log(`\n${label}: ${files.length} file(s)`);
  return out;
}

const all: Result[] = [];

all.push(...(await validateGroup("chain.json", ["mainnet/*/chain.json", "testnet/*/chain.json", "devnet/*/chain.json"], "chain.schema.json")));
all.push(...(await validateGroup("assetlist.json", ["mainnet/*/assetlist.json", "testnet/*/assetlist.json", "devnet/*/assetlist.json"], "assetlist.schema.json")));
all.push(...(await validateGroup("nft-assetlist.json", ["mainnet/*/nft-assetlist.json", "testnet/*/nft-assetlist.json", "devnet/*/nft-assetlist.json"], "nft-assetlist.schema.json")));
all.push(...(await validateGroup("_IBC/*.json", ["_IBC/*.json"], "ibc.schema.json")));

let failed = 0;
for (const r of all) {
  const rel = r.file.replace(ROOT + "/", "");
  if (r.ok) {
    console.log(`  ✓ ${rel}`);
  } else {
    failed++;
    console.error(`  ✗ ${rel}\n    ${r.errors}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed schema validation.`);
  process.exit(1);
}
console.log(`\nAll ${all.length} file(s) valid.`);

// IBC file-name convention: <chain_a>-<chain_b>.json (alphabetical)
const ibcFiles = await fg("_IBC/*.json", { cwd: ROOT });
for (const f of ibcFiles) {
  const data = await loadJson<{ chain_1: { chain_name: string }; chain_2: { chain_name: string } }>(resolve(ROOT, f));
  const expected = [data.chain_1.chain_name, data.chain_2.chain_name].sort().join("-") + ".json";
  if (basename(f) !== expected) {
    console.error(`✗ ${f} — IBC filename must be ${expected} (alphabetical)`);
    process.exit(1);
  }
}
console.log(`IBC filename convention OK.`);
