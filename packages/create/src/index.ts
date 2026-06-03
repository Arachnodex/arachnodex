import {copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync} from "fs";
import {basename, resolve} from "path";
import {fileURLToPath} from "url";
import {spawnSync} from "child_process";

type ScaffoldConfig = {
    targetDir: string;
    install: boolean;
    force: boolean;
}

const packageDependencies = {
    "@arachnodex/core": "^1.0.4",
    "@arachnodex/job-link-issues": "^1.0.2",
    "@arachnodex/job-sitemap": "^1.0.1"
};

const packageDevDependencies = {
    "tsx": "^4.20.6",
    "typescript": "^5.6.3"
};

const configFiles = [
    {
        specifier: "@arachnodex/core/config/default.example.json",
        exampleFile: "default.example.json",
        runtimeFile: "default.json"
    },
    {
        specifier: "@arachnodex/job-link-issues/config/link-issues.example.json",
        exampleFile: "link-issues.example.json",
        runtimeFile: "link-issues.json"
    },
    {
        specifier: "@arachnodex/job-sitemap/config/sitemap.example.json",
        exampleFile: "sitemap.example.json",
        runtimeFile: "sitemap.json"
    }
];

function main(): void {
    const config = parseArgs(process.argv.slice(2));
    scaffoldProject(config);
    if(config.install) {
        installDependencies(config.targetDir);
    }

    console.log("");
    console.log("Arachnodex project created.");
    console.log(`  cd ${config.targetDir}`);
    if(!config.install) {
        console.log("  npm install");
    }
    console.log("  npm run crawl:default");
}

function parseArgs(args: string[]): ScaffoldConfig {
    if(args.includes("-h") || args.includes("--help")) {
        showHelp();
        process.exit(0);
    }

    const install = !args.includes("--no-install");
    const force = args.includes("--force");
    const targetArg = args.find(arg => !arg.startsWith("-")) ?? "arachnodex";
    return {
        targetDir: resolve(process.cwd(), targetArg),
        install,
        force
    };
}

function showHelp(): void {
    console.log("Create an Arachnodex crawler project.");
    console.log("");
    console.log("Usage:");
    console.log("  npm create @arachnodex [target-directory]");
    console.log("");
    console.log("Options:");
    console.log("  --no-install  Write files without running npm install.");
    console.log("  --force       Allow writing into a non-empty target directory.");
    console.log("  -h, --help    Show this help message.");
}

function scaffoldProject(config: ScaffoldConfig): void {
    ensureTargetDirectory(config);
    mkdirSync(resolve(config.targetDir, "config"), {recursive: true});

    writeProjectPackageJson(config.targetDir);
    copyReadmeFile(config.targetDir);
    copyConfigFiles(config.targetDir);
}

function ensureTargetDirectory(config: ScaffoldConfig): void {
    if(!existsSync(config.targetDir)) {
        mkdirSync(config.targetDir, {recursive: true});
        return;
    }

    const entries = readdirSync(config.targetDir).filter(entry => entry !== ".DS_Store");
    if(entries.length > 0 && !config.force) {
        throw new Error(`Target directory is not empty: ${config.targetDir}. Use --force to write into it.`);
    }
}

function writeProjectPackageJson(targetDir: string): void {
    const projectName = sanitizePackageName(basename(targetDir));
    const packageJson = {
        name: projectName,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
            crawl: "arachnodex",
            "crawl:default": "arachnodex -c default -j sitemap -j link-issues",
            "crawl:src": "node --conditions=development --import tsx node_modules/@arachnodex/core/src/index.ts",
            "crawl:src:default": "node --conditions=development --import tsx node_modules/@arachnodex/core/src/index.ts -c default -j sitemap -j link-issues"
        },
        dependencies: packageDependencies,
        devDependencies: packageDevDependencies
    };

    writeFileSync(
        resolve(targetDir, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`
    );
}

function sanitizePackageName(name: string): string {
    const sanitized = name.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return sanitized.length > 0 ? sanitized : "arachnodex-site";
}

function copyConfigFiles(targetDir: string): void {
    configFiles.forEach(configFile => {
        const source = resolvePackageFile(configFile.specifier);
        const exampleDestination = resolve(targetDir, "config", configFile.exampleFile);
        const runtimeDestination = resolve(targetDir, "config", configFile.runtimeFile);
        copyFileSync(source, exampleDestination);
        copyFileSync(source, runtimeDestination);
    });
}

function copyReadmeFile(targetDir: string): void {
    const source = resolvePackageFile("@arachnodex/core/README.md");
    copyFileSync(source, resolve(targetDir, "README.md"));
}

function resolvePackageFile(specifier: string): string {
    return fileURLToPath(import.meta.resolve(specifier));
}

function installDependencies(targetDir: string): void {
    const result = spawnSync("npm", ["install"], {
        cwd: targetDir,
        stdio: "inherit",
        shell: process.platform === "win32"
    });

    if(result.status !== 0) {
        throw new Error("npm install failed in the generated project.");
    }
}

try {
    main();
} catch(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Create failed: ${message}`);
    process.exit(1);
}
