import { build } from "esbuild";
import { argv } from "process";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";

const isWatch = argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/index.ts"],
  outfile: "dist/book_master.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  legalComments: "none",
  logLevel: "info",
  globalName: "Gas",
  footer: {
    js: `
// Export global functions for Google Apps Script
globalThis.doGet = Gas.doGet;
globalThis.doPost = Gas.doPost;
globalThis.authorizeOnce = Gas.authorizeOnce;
// Dev test helpers (run from GAS editor)
globalThis.testBooksFind = Gas.testBooksFind;
globalThis.testBooksGetSingle = Gas.testBooksGetSingle;
globalThis.testBooksGetMultiple = Gas.testBooksGetMultiple;
globalThis.testBooksFilterMath = Gas.testBooksFilterMath;
globalThis.testBooksCreateUpdateDelete = Gas.testBooksCreateUpdateDelete;
globalThis.testBooksAll = Gas.testBooksAll;
`,
  },
};

if (isWatch) {
  const context = await build({
    ...buildOptions,
    watch: {
      onRebuild(error, result) {
        if (error) {
          console.error("watch build failed:", error);
        } else {
          console.log("watch build succeeded");
        }
      },
    },
  });
  console.log("watching for changes...");
} else {
  await build(buildOptions);
  console.log("built: dist/book_master.js");
  // Emit small top-level entry .gs so that Apps Script editor's Run menu can find callable functions
  const entryPath = "dist/_entries.gs";
  const entrySrc = `
// Auto-generated helper. Exposes simple top-level functions for manual runs.
function authorizeOnceEntry() {
  if (typeof authorizeOnce === 'function') return authorizeOnce();
  if (typeof Gas !== 'undefined' && Gas.authorizeOnce) return Gas.authorizeOnce();
}
function pingEntry() {
  if (typeof doGet === 'function') return doGet({ parameter: { op: 'ping' } });
}
`;
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, entrySrc, "utf8");
  console.log("emitted:", entryPath);
}
