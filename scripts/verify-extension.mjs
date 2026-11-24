#!/usr/bin/env node
/**
 * Static verification of the MV3 extension.
 *
 * Chrome's own validator cannot run here, so this script checks everything that
 * silently breaks a "load unpacked" attempt or an extension review:
 *   - manifest is valid JSON, MV3, and every referenced file exists;
 *   - declared icons are real PNGs of the declared size;
 *   - the panel page has no inline script or inline event handler (MV3 CSP);
 *   - the panel actually talks to the app (message type, target origin) and
 *     never eval()s;
 *   - no remote code is loaded.
 *
 * Run: npm run verify:extension
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ext = join(root, "extension");

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  must(existsSync(path), `missing file: ${path}`);
  return readFileSync(path, "utf8");
}

/** Minimal PNG header reader: returns { width, height, bitDepth, colorType }. */
function pngSize(path) {
  const buffer = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    must(buffer[i] === signature[i], `${path} is not a PNG`);
  }
  must(buffer.toString("ascii", 12, 16) === "IHDR", `${path} has no IHDR chunk`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

const manifestPath = join(ext, "manifest.json");
let manifest = null;

check("manifest.json is valid MV3 JSON", () => {
  manifest = JSON.parse(read(manifestPath));
  must(manifest.manifest_version === 3, "manifest_version must be 3");
  must(typeof manifest.name === "string" && manifest.name.length > 3, "name is required");
  must(/^\d+\.\d+(\.\d+)?$/.test(manifest.version), "version must be 1.0 or 1.0.1 style");
  must(typeof manifest.description === "string" && manifest.description.length > 20, "description is required");
  must(manifest.background?.service_worker === "background.js", "background.service_worker must be background.js");
  must(manifest.side_panel?.default_path === "panel.html", "side_panel.default_path must be panel.html");
  return `${manifest.name} ${manifest.version}`;
});

check("every referenced file exists", () => {
  const files = new Set([
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ]);
  for (const file of files) {
    must(file, "empty file reference in manifest");
    must(existsSync(join(ext, file)), `missing ${file}`);
  }
  return [...files].join(", ");
});

check("icons are PNGs of the declared size", () => {
  const sizes = Object.entries(manifest.icons ?? {});
  must(sizes.length >= 3, "declare at least 16/48/128 icons");
  const details = [];
  for (const [declared, file] of sizes) {
    const { width, height, bitDepth, colorType } = pngSize(join(ext, file));
    must(width === Number(declared) && height === Number(declared), `${file} is ${width}x${height}, manifest says ${declared}`);
    must(bitDepth === 8 && colorType === 6, `${file} must be 8-bit RGBA`);
    must(statSync(join(ext, file)).size < 200_000, `${file} is too large for an icon`);
    details.push(`${file} ${width}px`);
  }
  return details.join(", ");
});

check("panel.html is CSP safe", () => {
  const html = read(join(ext, "panel.html"));
  must(!/<script(?![^>]*\bsrc=)/i.test(html), "inline <script> is blocked by the MV3 CSP");
  must(!/\son\w+\s*=/i.test(html), "inline event handlers (onclick=…) are blocked by the MV3 CSP");
  must(/<script\s+src="panel\.js"><\/script>/.test(html), "panel.js must be loaded as an external script");
  const remote = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/gi)].map((m) => m[1]);
  must(remote.length === 0, `remote resources are not allowed: ${remote.join(", ")}`);
  must(/id="app"/.test(html), "the app iframe is missing");
  must(/id="grab"/.test(html), "the grab button is missing");
  return `${html.length} chars, external script only`;
});

check("panel.js hands the document to the app with a target origin", () => {
  const js = read(join(ext, "panel.js"));
  must(/vaultbrief:document/.test(js), "message type vaultbrief:document is missing");
  must(/postMessage\([^)]*,\s*origin\)/.test(js), "postMessage must pass an explicit target origin");
  must(/new URL\(appFrame\.src\)\.origin/.test(js), "the target origin must come from the app URL");
  must(/chrome\.scripting\.executeScript/.test(js), "the page reader is missing");
  must(/lastFocusedWindow: true/.test(js), "tab query should target the last focused window");
  must(!/\beval\(|new Function\(/.test(js), "eval / new Function are not allowed in MV3");
  must(/appLoaded/.test(js), "the panel must wait for the iframe load event");
  return "message + origin + load queue present";
});

check("background service worker opens the side panel", () => {
  const js = read(join(ext, "background.js"));
  must(/sidePanel\.setPanelBehavior/.test(js), "setPanelBehavior call is missing");
  must(/openPanelOnActionClick:\s*true/.test(js), "the panel should open on action click");
  return "openPanelOnActionClick: true";
});

check("permissions are the documented minimum", () => {
  const allowed = new Set(["activeTab", "scripting", "storage", "sidePanel"]);
  for (const permission of manifest.permissions ?? []) {
    must(allowed.has(permission), `unexpected permission: ${permission}`);
  }
  must((manifest.host_permissions ?? []).length > 0, "the reader needs a host permission");
  return (manifest.permissions ?? []).join(", ");
});

const failed = results.filter((r) => !r.ok);
const payload = {
  checkedAt: new Date().toISOString(),
  extension: "extension/",
  checks: results,
  ok: failed.length === 0,
};
console.log(JSON.stringify(payload, null, 2));
if (failed.length > 0) process.exitCode = 1;
