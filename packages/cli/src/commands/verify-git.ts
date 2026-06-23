import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

async function gitLines(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
