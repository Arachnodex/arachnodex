import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "fs";
import {basename, resolve} from "path";
import {fileURLToPath} from "url";
import {spawnSync} from "child_process";

type ScaffoldConfig = {
    targetDir: string;
    install: boolean;
    force: boolean;
    update: boolean;
}

const packageDependencies = {
    "@arachnodex/core": "^1.0.11",
    "@arachnodex/job-csp-report": "^1.0.1",
    "@arachnodex/job-link-issues": "^1.0.10",
    "@arachnodex/job-nfa-report": "^1.0.5",
    "@arachnodex/job-sitemap": "^1.0.3"
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
        specifier: "@arachnodex/job-csp-report/config/csp-report.example.json",
        exampleFile: "csp-report.example.json",
        runtimeFile: "csp-report.json"
    },
    {
        specifier: "@arachnodex/job-link-issues/config/link-issues.example.json",
        exampleFile: "link-issues.example.json",
        runtimeFile: "link-issues.json"
    },
    {
        specifier: "@arachnodex/job-nfa-report/config/nfa-report.example.json",
        exampleFile: "nfa-report.example.json",
        runtimeFile: "nfa-report.json"
    },
    {
        specifier: "@arachnodex/job-sitemap/config/sitemap.example.json",
        exampleFile: "sitemap.example.json",
        runtimeFile: "sitemap.json"
    }
];

function main(): void {
    const config = parseArgs(process.argv.slice(2));
    if(config.update) {
        updateProject(config);
    } else {
        scaffoldProject(config);
    }
    if(config.install) {
        if(config.update) {
            updateDependencies(config.targetDir);
        } else {
            installDependencies(config.targetDir);
        }
    }

    console.log("");
    console.log(`Arachnodex project ${config.update ? "updated" : "created"}.`);
    console.log(`  cd ${config.targetDir}`);
    if(!config.install) {
        console.log(config.update
            ? `  npm install ${getPackageDependencySpecs().join(" ")}`
            : "  npm install");
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
    const update = args.includes("--update");
    const targetArg = args.find(arg => !arg.startsWith("-")) ?? (update ? "." : "arachnodex");
    return {
        targetDir: resolve(process.cwd(), targetArg),
        install,
        force,
        update
    };
}

function showHelp(): void {
    console.log("Create an Arachnodex crawler project.");
    console.log("");
    console.log("Usage:");
    console.log("  npm create @arachnodex [target-directory]");
    console.log("  npm create @arachnodex@latest -- --update [target-directory]");
    console.log("");
    console.log("Options:");
    console.log("  --update      Update an existing project without replacing runtime config.");
    console.log("  --no-install  Write files without running npm install.");
    console.log("  --force       Allow create mode to write into a non-empty target directory.");
    console.log("  -h, --help    Show this help message.");
}

function scaffoldProject(config: ScaffoldConfig): void {
    ensureTargetDirectory(config);
    mkdirSync(resolve(config.targetDir, "config"), {recursive: true});

    writeProjectPackageJson(config.targetDir);
    copyReadmeFile(config.targetDir);
    copyConfigExampleFiles(config.targetDir);
    copyRuntimeConfigFiles(config.targetDir);
}

function updateProject(config: ScaffoldConfig): void {
    ensureUpdateTarget(config.targetDir);
    mkdirSync(resolve(config.targetDir, "config"), {recursive: true});

    updateProjectPackageJson(config.targetDir);
    copyReadmeFile(config.targetDir);
    copyConfigExampleFiles(config.targetDir);
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

function ensureUpdateTarget(targetDir: string): void {
    if(!existsSync(targetDir)) {
        throw new Error(`Update target does not exist: ${targetDir}.`);
    }
    if(!existsSync(resolve(targetDir, "package.json"))) {
        throw new Error(`Update target does not contain package.json: ${targetDir}.`);
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
            "crawl:default": "arachnodex -c default -j sitemap -j link-issues -j nfa-report",
            "crawl:src": "node --conditions=development --import tsx node_modules/@arachnodex/core/src/index.ts",
            "crawl:src:default": "node --conditions=development --import tsx node_modules/@arachnodex/core/src/index.ts -c default -j sitemap -j link-issues -j nfa-report"
        },
        dependencies: packageDependencies,
        devDependencies: packageDevDependencies
    };

    writeFileSync(
        resolve(targetDir, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`
    );
}

function updateProjectPackageJson(targetDir: string): void {
    const packageJsonPath = resolve(targetDir, "package.json");
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if(typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Project package.json must contain a JSON object: ${packageJsonPath}.`);
    }

    const packageJson = parsed as Record<string, unknown>;
    const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
    const devDependencies = isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
    packageJson.dependencies = {
        ...dependencies,
        ...packageDependencies
    };
    packageJson.devDependencies = {
        ...packageDevDependencies,
        ...devDependencies
    };

    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePackageName(name: string): string {
    const sanitized = name.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return sanitized.length > 0 ? sanitized : "arachnodex-site";
}

function copyConfigExampleFiles(targetDir: string): void {
    configFiles.forEach(configFile => {
        const source = resolvePackageFile(configFile.specifier);
        const exampleDestination = resolve(targetDir, "config", configFile.exampleFile);
        copyFileSync(source, exampleDestination);
    });
}

function copyRuntimeConfigFiles(targetDir: string): void {
    configFiles.forEach(configFile => {
        const source = resolvePackageFile(configFile.specifier);
        const runtimeDestination = resolve(targetDir, "config", configFile.runtimeFile);
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

function updateDependencies(targetDir: string): void {
    const result = spawnSync("npm", ["install", ...getPackageDependencySpecs()], {
        cwd: targetDir,
        stdio: "inherit",
        shell: process.platform === "win32"
    });

    if(result.status !== 0) {
        throw new Error("npm install failed while updating the Arachnodex packages.");
    }
}

function getPackageDependencySpecs(): string[] {
    return Object.entries(packageDependencies).map(([name, version]) => `${name}@${version}`);
}

try {
    main();
} catch(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Create failed: ${message}`);
    process.exit(1);
}
