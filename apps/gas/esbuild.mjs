import { build } from "esbuild";
import { argv } from "process";

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
  console.log("built: dist/Code.js");
}
