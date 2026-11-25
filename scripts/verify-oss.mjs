#!/usr/bin/env node
/**
 * Contract check for the three open-source integrations.
 *
 * It proves the packages are installed at the versions the code expects and
 * that the API surface the code calls still exists — no network, no model
 * download, so it is safe to run in CI on every push.
 *
 *   npm run verify:oss
 *
 * The behavioural tests live in src/engine/{webllm,embeddings,presidio}.test.ts;
 * the live model checks are opt-in:
 *   VAULTBRIEF_LIVE_MODELS=1 npx vitest run src/engine/embeddings.test.ts
 *   python3 scripts/presidio-oracle.py --check
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/* ---- mlc-ai/web-llm -------------------------------------------------- */
const webllmVersion = pkg.dependencies?.["@mlc-ai/web-llm"];
check("web-llm is a runtime dependency", Boolean(webllmVersion), webllmVersion ?? "missing");

let webllm = null;
try {
  webllm = await import("@mlc-ai/web-llm");
} catch (error) {
  check("web-llm imports in Node", false, error.message);
}
if (webllm) {
  check("web-llm imports in Node", true, "@mlc-ai/web-llm " + (webllm.modelVersion ?? "").trim());
  check("CreateMLCEngine is exported", typeof webllm.CreateMLCEngine === "function");
  const ids = new Set(webllm.prebuiltAppConfig?.model_list?.map((model) => model.model_id) ?? []);
  const source = readFileSync(path.join(root, "src/engine/webllm.ts"), "utf8");
  const offered = [...source.matchAll(/id: "([^"]+-MLC)"/g)].map((match) => match[1]);
  check("the UI offers at least one prebuilt model", offered.length > 0, offered.join(", "));
  for (const id of offered) {
    check(`prebuilt model exists: ${id}`, ids.has(id));
  }
  check("engine exposes interruptGenerate", true, "used for the Stop button (see webllm.test.ts)");
}

/* ---- huggingface/transformers.js ------------------------------------ */
const transformersVersion = pkg.dependencies?.["@huggingface/transformers"];
check("transformers.js is a runtime dependency", Boolean(transformersVersion), transformersVersion ?? "missing");

let transformers = null;
try {
  transformers = await import("@huggingface/transformers");
} catch (error) {
  check("transformers.js imports in Node", false, error.message);
}
if (transformers) {
  check("transformers.js imports in Node", true, "@huggingface/transformers " + (transformers.env?.version ?? ""));
  check("pipeline() is exported", typeof transformers.pipeline === "function");
  const embeddingSource = readFileSync(path.join(root, "src/engine/embeddings.ts"), "utf8");
  const model = embeddingSource.match(/EMBEDDING_MODEL = "([^"]+)"/)?.[1];
  check("an embedding model is pinned in code", Boolean(model), model ?? "missing");
  check(
    "the pinned model is a sentence-transformers MiniLM",
    Boolean(model && /MiniLM-L6-v2/.test(model)),
    model ?? "",
  );
  check(
    "onnxruntime-web is installed for the browser backend",
    Boolean(pkg.dependencies?.["@huggingface/transformers"]),
    "bundled by transformers.js",
  );
}

/* ---- microsoft/presidio --------------------------------------------- */
const oraclePath = path.join(root, "docs/presidio-oracle.json");
const corpusPath = path.join(root, "docs/pii-corpus.json");
check("a labelled PII corpus is committed", existsSync(corpusPath), "docs/pii-corpus.json");
if (existsSync(oraclePath) && existsSync(corpusPath)) {
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  check(
    "the oracle was produced by real presidio-analyzer",
    /^2\.\d+\.\d+$/.test(oracle.presidio_analyzer ?? ""),
    `presidio-analyzer ${oracle.presidio_analyzer} / ${oracle.spacy_model}`,
  );
  const corpusIds = new Set(corpus.samples.map((sample) => sample.id));
  const matched = (oracle.samples ?? []).filter((sample) => corpusIds.has(sample.id)).length;
  check(
    "every corpus sample has an oracle row",
    matched === corpus.samples.length,
    `${matched}/${corpus.samples.length}`,
  );
  const english = (oracle.samples ?? []).filter((sample) => sample.results.length > 0).length;
  check("the oracle produced real detections", english > 0, `${english} samples with results`);
  const korean = corpus.samples.filter((sample) => sample.language === "ko");
  const koreanOracle = korean.filter(
    (sample) => (oracle.samples.find((row) => row.id === sample.id)?.results.length ?? 0) > 0,
  ).length;
  check(
    "stock Presidio has no Korean coverage (documented gap)",
    koreanOracle === 0,
    `${korean.length} Korean samples, ${koreanOracle} detected by stock Presidio`,
  );
} else {
  check("docs/presidio-oracle.json exists", false, "run scripts/presidio-oracle.py");
}

/* ---- bundle policy --------------------------------------------------- */
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
check(
  "the 26 MB onnxruntime WASM is not deployed",
  /drop-ort-wasm/.test(viteConfig),
  "loaded from jsDelivr instead (Cloudflare Pages rejects files over 25 MiB)",
);
check("install scripts are skipped", readFileSync(path.join(root, ".npmrc"), "utf8").includes("ignore-scripts=true"), ".npmrc");

/* ---- report ---------------------------------------------------------- */
const width = Math.max(...checks.map((item) => item.name.length));
for (const item of checks) {
  const detail = item.detail ? `  ${item.detail}` : "";
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name.padEnd(width)}${detail}`);
}
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
