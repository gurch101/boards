import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: ["public/app.js"],
  outfile: "public/app.bundle.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof"
});

const bundle = await readFile("public/app.bundle.js");
const version = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
const indexPath = "public/index.html";
const index = await readFile(indexPath, "utf8");
await writeFile(indexPath, index.replace(/\/app\.bundle\.js(?:\?v=[^\"]+)?/, `/app.bundle.js?v=${version}`));
