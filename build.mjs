import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";

const outdir = "dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  target: "chrome114",
  logLevel: "info",
};

// Background service worker (module) and extension pages are ESM;
// the content script must be a classic script, so bundle it as IIFE.
await esbuild.build({
  ...common,
  entryPoints: ["src/background/index.ts"],
  outfile: `${outdir}/background.js`,
  format: "esm",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/content/index.ts"],
  outfile: `${outdir}/content.js`,
  format: "iife",
});

await esbuild.build({
  ...common,
  entryPoints: {
    "popup/popup": "src/popup/popup.ts",
    "sidepanel/sidepanel": "src/sidepanel/sidepanel.ts",
    "options/options": "src/options/options.ts",
  },
  outdir,
  format: "esm",
  splitting: false,
});

// pdf.js worker (loaded by the options page for resume text extraction)
cpSync(
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  `${outdir}/options/pdf.worker.min.mjs`,
);

// Static assets
cpSync("src/popup/popup.html", `${outdir}/popup/popup.html`);
cpSync("src/sidepanel/sidepanel.html", `${outdir}/sidepanel/sidepanel.html`);
cpSync("src/options/options.html", `${outdir}/options/options.html`);
cpSync("src/styles.css", `${outdir}/styles.css`);
cpSync("manifest.json", `${outdir}/manifest.json`);
if (existsSync("icons")) cpSync("icons", `${outdir}/icons`, { recursive: true });

console.log("Build complete -> dist/");
