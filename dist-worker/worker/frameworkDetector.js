import { readFile } from "node:fs/promises";
import path from "node:path";
const defaultBuildSettings = {
    framework: "static",
    installCommand: "npm install",
    buildCommand: "npm run build",
    outputDirectory: "dist"
};
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value) {
    return typeof value === "string" ? value.trim() : undefined;
}
async function readJsonFile(filePath) {
    try {
        return JSON.parse(await readFile(filePath, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
        }
        throw error;
    }
}
function readVercelBuildSettings(value) {
    if (!isRecord(value)) {
        return {};
    }
    return {
        framework: stringField(value.framework),
        installCommand: stringField(value.installCommand),
        buildCommand: stringField(value.buildCommand),
        outputDirectory: stringField(value.outputDirectory),
        rootDirectory: stringField(value.rootDirectory),
        ignoreCommand: stringField(value.ignoreCommand)
    };
}
function readPackageJson(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    return {
        scripts: isRecord(value.scripts) ? value.scripts : undefined,
        dependencies: isRecord(value.dependencies) ? value.dependencies : undefined,
        devDependencies: isRecord(value.devDependencies) ? value.devDependencies : undefined
    };
}
function dependencyNames(packageJson) {
    return new Set([
        ...Object.keys(packageJson?.dependencies ?? {}),
        ...Object.keys(packageJson?.devDependencies ?? {})
    ]);
}
function hasDependency(dependencies, name) {
    return dependencies.has(name);
}
function hasBuildScript(packageJson) {
    return typeof packageJson?.scripts?.build === "string" && packageJson.scripts.build.trim().length > 0;
}
function detectFrameworkPreset(packageJson) {
    const dependencies = dependencyNames(packageJson);
    const buildCommand = hasBuildScript(packageJson) ? "npm run build" : "";
    if (hasDependency(dependencies, "next")) {
        return {
            framework: "next",
            buildCommand,
            outputDirectory: ".next"
        };
    }
    if (hasDependency(dependencies, "vite") || [...dependencies].some((name) => name.startsWith("@vitejs/"))) {
        return {
            framework: "vite",
            buildCommand,
            outputDirectory: "dist"
        };
    }
    if (hasDependency(dependencies, "astro")) {
        return {
            framework: "astro",
            buildCommand,
            outputDirectory: "dist"
        };
    }
    if (hasDependency(dependencies, "react-scripts")) {
        return {
            framework: "create-react-app",
            buildCommand,
            outputDirectory: "build"
        };
    }
    return {
        framework: "static",
        buildCommand,
        outputDirectory: defaultBuildSettings.outputDirectory
    };
}
function shouldAutoFramework(framework) {
    const normalized = framework?.trim().toLowerCase();
    return !normalized || normalized === "auto" || normalized === "static";
}
function shouldUseDetectedBuildCommand(command) {
    const normalized = command?.trim();
    return !normalized || normalized === defaultBuildSettings.buildCommand;
}
function shouldUseDetectedOutputDirectory(outputDirectory) {
    const normalized = outputDirectory?.trim();
    return !normalized || normalized === defaultBuildSettings.outputDirectory;
}
function resolveInsideRoot(sourceDirectory, rootDirectory) {
    const sourceRoot = path.resolve(sourceDirectory);
    const candidate = path.resolve(sourceRoot, rootDirectory ?? ".");
    if (candidate !== sourceRoot && !candidate.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error("Build root directory escapes the source checkout.");
    }
    return candidate;
}
export async function detectBuildSettings(sourceDirectory, requested) {
    const checkoutConfig = readVercelBuildSettings(await readJsonFile(path.resolve(sourceDirectory, "vercel.json")));
    const rootDirectory = requested.rootDirectory ?? checkoutConfig.rootDirectory;
    const projectRoot = resolveInsideRoot(sourceDirectory, rootDirectory);
    const projectConfig = projectRoot === path.resolve(sourceDirectory)
        ? checkoutConfig
        : {
            ...checkoutConfig,
            ...readVercelBuildSettings(await readJsonFile(path.resolve(projectRoot, "vercel.json")))
        };
    const packageJson = readPackageJson(await readJsonFile(path.resolve(projectRoot, "package.json")));
    const detected = detectFrameworkPreset(packageJson);
    return {
        installCommand: projectConfig.installCommand ?? requested.installCommand,
        ignoreCommand: projectConfig.ignoreCommand ?? requested.ignoreCommand,
        buildCommand: projectConfig.buildCommand ?? (shouldUseDetectedBuildCommand(requested.buildCommand) ? detected.buildCommand : requested.buildCommand),
        outputDirectory: projectConfig.outputDirectory ?? (shouldUseDetectedOutputDirectory(requested.outputDirectory) ? detected.outputDirectory : requested.outputDirectory),
        rootDirectory,
        framework: projectConfig.framework ?? (shouldAutoFramework(requested.framework) ? detected.framework : requested.framework)
    };
}
