import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface TableAssumption {
  /** Columns the table is expected to be unique by (the dedup key). */
  uniqueBy?: string[];
}

export interface GozzleProjectConfig {
  /** Default database for unqualified table names. */
  database?: string;
  /** Globs locating query `.sql` files. */
  queries: string[];
  /** Globs locating migration `.sql` files. */
  migrations: string[];
  /** Per-table assumptions that power the read-path proof. */
  assumptions: Record<string, TableAssumption>;
}

const assumptionSchema = z
  .object({
    unique_by: z.array(z.string()).optional()
  })
  .strict();

const configSchema = z
  .object({
    database: z.string().optional(),
    queries: z.array(z.string()).default([]),
    migrations: z.array(z.string()).default([]),
    assumptions: z.record(z.string(), assumptionSchema).default({})
  })
  .strict();

export const CONFIG_FILENAMES = ["gozzle.yaml", "gozzle.yml"] as const;

/** Parse and validate gozzle.yaml text. Throws on malformed config. */
export function parseProjectConfig(text: string): GozzleProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`gozzle.yaml is not valid YAML: ${detail}`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(
      `gozzle.yaml is invalid${path ? ` at "${path}"` : ""}: ${issue?.message ?? "unknown error"}`
    );
  }

  const parsed = result.data;
  return {
    database: parsed.database,
    queries: parsed.queries,
    migrations: parsed.migrations,
    assumptions: Object.fromEntries(
      Object.entries(parsed.assumptions).map(([table, value]) => [
        table,
        {
          uniqueBy: value.unique_by
        }
      ])
    )
  };
}

export interface LoadedProjectConfig {
  config: GozzleProjectConfig;
  path: string;
}

/**
 * Find and load gozzle.yaml by walking up from `cwd`. Returns undefined when no
 * config exists (gozzle.yaml is optional).
 */
export async function readProjectConfig(
  cwd: string = process.cwd()
): Promise<LoadedProjectConfig | undefined> {
  let dir = cwd;
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      let text: string;
      try {
        text = await readFile(candidate, "utf8");
      } catch {
        continue;
      }
      return { config: parseProjectConfig(text), path: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const BACKSLASH = String.fromCharCode(92);
const REGEX_SPECIALS = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  BACKSLASH
]);

// Convert a glob (supporting *, ?, ** and the **/ directory wildcard) to an
// anchored RegExp.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?"; // **/ spans zero or more directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (char === "?") {
      re += "[^/]";
    } else if (REGEX_SPECIALS.has(char)) {
      re += BACKSLASH + char;
    } else {
      re += char;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when `path` (normalized to forward slashes) matches any glob. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  const normalized = path.split(BACKSLASH).join("/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}
