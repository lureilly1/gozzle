import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import type { GozzleProjectConfig } from "../config/project.js";
import { selectVerifiableFiles } from "./verify-discover.js";
import type { VerifyOptions } from "./verify.js";

const execFileAsync = promisify(execFile);

/** Resolve the changed/diffed files git reports, filtered to verifiable SQL. */
export async function resolveGitFiles(
  options: VerifyOptions,
  project: GozzleProjectConfig | undefined
): Promise<string[]> {
  const root = (await gitLines(["rev-parse", "--show-toplevel"]))[0];
  if (!root) throw new Error("not inside a git repository.");

  let changed: string[];
  if (options.diff) {
    changed = await gitLines(["diff", "--name-only", options.diff]);
  } else {
    const tracked = await gitLines(["diff", "--name-only", "HEAD"]);
    const untracked = await gitLines([
      "ls-files",
      "--others",
      "--exclude-standard"
    ]);
    changed = [...new Set([...tracked, ...untracked])];
  }

  return selectVerifiableFiles(changed, project)
    .map((file) => join(root, file))
    .filter((file) => existsSync(file));
}

export function resolveGitBaseRef(options: VerifyOptions): string | undefined {
  if (!options.diff) return options.changed ? "HEAD" : undefined;
  if (options.diff.includes("...")) return options.diff.split("...")[0];
  if (options.diff.includes("..")) return options.diff.split("..")[0];
  return options.diff;
}

export async function readFileAtRef(
  ref: string,
  path: string
): Promise<string | undefined> {
  const root = (await gitLines(["rev-parse", "--show-toplevel"]))[0];
  if (!root) throw new Error("not inside a git repository.");
  const relativePath = relative(root, path).split("\\").join("/");
  try {
    const { stdout } = await execFileAsync("git", [
      "show",
      `${ref}:${relativePath}`
    ]);
    return stdout;
  } catch {
    return undefined;
  }
}

async function gitLines(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
