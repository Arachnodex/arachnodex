const {copyFileSync, existsSync, mkdirSync} = require("node:fs");
const {dirname, resolve} = require("node:path");

const rootReadme = resolve(__dirname, "..", "README.md");
const coreReadme = resolve(__dirname, "..", "packages", "core", "README.md");

if(!existsSync(rootReadme)) {
    throw new Error(`Root README not found: ${rootReadme}`);
}

mkdirSync(dirname(coreReadme), {recursive: true});
copyFileSync(rootReadme, coreReadme);
console.log("Synced README.md to packages/core/README.md");
