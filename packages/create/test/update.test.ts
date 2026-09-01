import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const createSource = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const expectedDependencies = {
    "@arachnodex/core": "^1.0.11",
    "@arachnodex/job-csp-report": "^1.0.1",
    "@arachnodex/job-link-issues": "^1.0.10",
    "@arachnodex/job-nfa-report": "^1.0.5",
    "@arachnodex/job-sitemap": "^1.0.3"
};
const configFiles = [
    ["packages/core/config/default.example.json", "default.example.json", "default.json"],
    ["packages/job-csp-report/config/csp-report.example.json", "csp-report.example.json", "csp-report.json"],
    ["packages/job-link-issues/config/link-issues.example.json", "link-issues.example.json", "link-issues.json"],
    ["packages/job-nfa-report/config/nfa-report.example.json", "nfa-report.example.json", "nfa-report.json"],
    ["packages/job-sitemap/config/sitemap.example.json", "sitemap.example.json", "sitemap.json"]
] as const;

function runCreate(args: string[], cwd = repositoryRoot) {
    return spawnSync(
        process.execPath,
        ["--conditions=development", "--import", tsxImport, createSource, ...args],
        {cwd, encoding: "utf8"}
    );
}

test("create mode still writes runtime and example configs", () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), "arachnodex-create-project-"));
    const targetDir = resolve(temporaryRoot, "new-project");

    try {
        const result = runCreate(["--no-install", targetDir]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Arachnodex project created\./);

        const packageJson = JSON.parse(readFileSync(resolve(targetDir, "package.json"), "utf8"));
        assert.equal(packageJson.name, "new-project");
        assert.deepEqual(packageJson.dependencies, expectedDependencies);

        configFiles.forEach(([source, exampleFile, runtimeFile]) => {
            const expectedConfig = readFileSync(resolve(repositoryRoot, source), "utf8");
            assert.equal(readFileSync(resolve(targetDir, "config", exampleFile), "utf8"), expectedConfig);
            assert.equal(readFileSync(resolve(targetDir, "config", runtimeFile), "utf8"), expectedConfig);
        });
    } finally {
        rmSync(temporaryRoot, {recursive: true, force: true});
    }
});

test("update refreshes generated files while preserving project customizations", () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), "arachnodex-create-update-"));
    const targetDir = resolve(temporaryRoot, "existing-project");
    mkdirSync(resolve(targetDir, "config"), {recursive: true});

    const originalPackageJson = {
        name: "custom-project",
        version: "7.4.2",
        private: true,
        scripts: {
            crawl: "arachnodex --custom",
            custom: "node custom.js"
        },
        dependencies: {
            "@arachnodex/core": "^1.0.1",
            "custom-package": "^3.0.0"
        },
        devDependencies: {
            "typescript": "^5.9.0",
            "custom-dev-package": "^2.0.0"
        },
        customField: {preserved: true}
    };
    writeFileSync(resolve(targetDir, "package.json"), `${JSON.stringify(originalPackageJson, null, 2)}\n`);
    writeFileSync(resolve(targetDir, "README.md"), "Old generated documentation\n");

    configFiles.forEach(([_source, exampleFile, runtimeFile], index) => {
        writeFileSync(resolve(targetDir, "config", exampleFile), "Old example\n");
        if(index === 0) {
            writeFileSync(resolve(targetDir, "config", runtimeFile), '{"custom":true}\n');
        }
    });

    try {
        const result = runCreate(["--update", "--no-install", targetDir]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Arachnodex project updated\./);

        const updatedPackageJson = JSON.parse(
            readFileSync(resolve(targetDir, "package.json"), "utf8")
        );
        assert.equal(updatedPackageJson.name, originalPackageJson.name);
        assert.equal(updatedPackageJson.version, originalPackageJson.version);
        assert.deepEqual(updatedPackageJson.scripts, originalPackageJson.scripts);
        assert.deepEqual(updatedPackageJson.customField, originalPackageJson.customField);
        assert.equal(updatedPackageJson.dependencies["custom-package"], "^3.0.0");
        assert.equal(updatedPackageJson.devDependencies.typescript, "^5.9.0");
        assert.equal(updatedPackageJson.devDependencies["custom-dev-package"], "^2.0.0");
        Object.entries(expectedDependencies).forEach(([name, version]) => {
            assert.equal(updatedPackageJson.dependencies[name], version);
        });
        assert.equal(updatedPackageJson.devDependencies.tsx, "^4.20.6");

        assert.equal(
            readFileSync(resolve(targetDir, "README.md"), "utf8"),
            readFileSync(resolve(repositoryRoot, "packages/core/README.md"), "utf8")
        );
        configFiles.forEach(([source, exampleFile, runtimeFile], index) => {
            assert.equal(
                readFileSync(resolve(targetDir, "config", exampleFile), "utf8"),
                readFileSync(resolve(repositoryRoot, source), "utf8")
            );
            if(index === 0) {
                assert.equal(
                    readFileSync(resolve(targetDir, "config", runtimeFile), "utf8"),
                    '{"custom":true}\n'
                );
            } else {
                assert.equal(existsSync(resolve(targetDir, "config", runtimeFile)), false);
            }
        });
    } finally {
        rmSync(temporaryRoot, {recursive: true, force: true});
    }
});

test("update defaults to the current directory and requires package.json", () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "arachnodex-create-invalid-update-"));
    try {
        const result = runCreate(["--update", "--no-install"], targetDir);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /does not contain package\.json/);
    } finally {
        rmSync(targetDir, {recursive: true, force: true});
    }
});
