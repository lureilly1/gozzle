import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageMetadata {
  version: string;
}

export function readPackageMetadata(): PackageMetadata {
  const packageJsonPath = findPackageJson(
    dirname(fileURLToPath(import.meta.url))
  );

  if (packageJsonPath) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };

    if (typeof packageJson.version === "string") {
      return {
        version: packageJson.version
      };
    }
  }

  return {
    version: "0.0.1-canary.0"
  };
}

function findPackageJson(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;

  for (let index = 0; index < 5; index += 1) {
    const candidate = join(currentDirectory, "package.json");

    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }

  return undefined;
}
