import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { matchesAnyGlob, type GozzleProjectConfig } from "../config/project.js";

/**
 * Filter a list of paths to the ones gozzle should verify: those matching the
 * configured query/migration globs, or — with no config — any `.sql` file.
 */
export function selectVerifiableFiles(
  files: string[],
  config?: GozzleProjectConfig
): string[] {
  const globs = config ? [...config.queries, ...config.migrations] : [];
  return files.filter((file) =>
    globs.length > 0
      ? matchesAnyGlob(file, globs)
      : file.replaceAll("\\", "/").endsWith(".sql")
  );
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".gozzle"
]);

/** Walk `root`, returning forward-slash paths relative to it (skipping junk). */
export async function walkFiles(
  root: string,
  dir: string = root
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...(await walkFiles(root, full)));
    } else if (entry.isFile()) {
      files.push(relative(root, full).split(sep).join("/"));
    }
  }
  return files;
}

/** Discover every configured query/migration file under `root` as absolute paths. */
export async function discoverConfiguredFiles(
  root: string,
  config: GozzleProjectConfig
): Promise<string[]> {
  const all = await walkFiles(root);
  return selectVerifiableFiles(all, config).map((rel) => join(root, rel));
}
