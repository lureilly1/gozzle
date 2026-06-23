import { readFile } from "node:fs/promises";
import { errorMessage } from "../shared/errors.js";

import { verifyEquivalent } from "../clickhouse/equivalent.js";
import { normalizeSqlFile } from "../clickhouse/statement.js";
import { withClickHouseClient } from "../clickhouse/with-client.js";
import { formatEquivalentResult } from "../tools/verify-equivalent.js";
import { verdictExitCode } from "../shared/verdict.js";

export interface EquivalentOptions {
  json: boolean;
  sampleLimit?: number;
}

export interface ParsedEquivalentArgs {
  files: string[];
  options: EquivalentOptions;
  error?: string;
}

export function parseEquivalentArgs(argv: string[]): ParsedEquivalentArgs {
  const files: string[] = [];
  const options: EquivalentOptions = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--sample") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        return {
          files,
          options,
          error: "--sample requires a positive integer"
        };
      }
      options.sampleLimit = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { files, options, error: `Unknown flag: ${arg}` };
    } else {
      files.push(arg);
    }
  }

  return { files, options };
}

export async function runEquivalentCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const { files, options, error } = parseEquivalentArgs(argv);
  if (error) {
    console.error(error);
    return 2;
  }
  if (files.length !== 2) {
    console.error(
      "Usage: gozzle equivalent <a.sql> <b.sql> [--sample N] [--json]"
    );
    return 2;
  }

  try {
    const [left, right] = await Promise.all([
      readSql(files[0]),
      readSql(files[1])
    ]);
    return await withClickHouseClient(async (client) => {
      const result = await verifyEquivalent(client, {
        left,
        right,
        sampleLimit: options.sampleLimit
      });
      console.log(
        options.json
          ? JSON.stringify(result, null, 2)
          : formatEquivalentResult(result)
      );
      return verdictExitCode(result.verdict);
    }, env);
  } catch (runError) {
    console.error(
      `gozzle equivalent could not run.\n\n${errorMessage(runError)}`
    );
    return 2;
  }
}

async function readSql(path: string): Promise<string> {
  return normalizeSqlFile(await readFile(path, "utf8"));
}
