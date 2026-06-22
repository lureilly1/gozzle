import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import {
  discoverWorkload,
  type WorkloadQuery
} from "../clickhouse/query-log.js";
import { formatBytes, formatCount } from "../shared/format.js";

export interface DiscoverOptions {
  sinceDays: number;
  limit: number;
  json: boolean;
}

export interface ParsedDiscoverArgs {
  options: DiscoverOptions;
  error?: string;
}

export function parseDiscoverArgs(argv: string[]): ParsedDiscoverArgs {
  const options: DiscoverOptions = { sinceDays: 7, limit: 20, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--since") {
      const value = argv[i + 1];
      const days = parseSince(value);
      if (days === undefined) {
        return { options, error: "--since requires a duration like 7d" };
      }
      options.sinceDays = days;
      i += 1;
    } else if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        return { options, error: "--limit requires a positive integer" };
      }
      options.limit = value;
      i += 1;
    } else {
      return { options, error: `Unknown argument: ${arg}` };
    }
  }

  return { options };
}

function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)d?$/.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1]);
  return days >= 1 ? days : undefined;
}

export async function runDiscoverCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const { options, error } = parseDiscoverArgs(argv);
  if (error) {
    console.error(error);
    return 2;
  }

  let client: ClickHouseHttpMetadataClient | undefined;
  try {
    const config = readClickHouseConfig(env);
    client = new ClickHouseHttpMetadataClient(config);
    const workload = await discoverWorkload(client, {
      defaultDatabase: config.database ?? "default",
      sinceDays: options.sinceDays,
      limit: options.limit
    });
    console.log(
      options.json
        ? JSON.stringify(workload, null, 2)
        : formatWorkload(workload, options.sinceDays)
    );
    return 0;
  } catch (runError) {
    console.error(`gozzle discover could not run.\n\n${message(runError)}`);
    return 2;
  } finally {
    await client?.close();
  }
}

export function formatWorkload(
  workload: WorkloadQuery[],
  sinceDays: number
): string {
  if (workload.length === 0) {
    return `No SELECTs found in system.query_log over the last ${sinceDays}d.`;
  }

  const lines = [
    `Top ${workload.length} SELECT(s) by bytes read (last ${sinceDays}d):`,
    ""
  ];
  workload.forEach((query, index) => {
    const tables =
      query.tables.length === 0
        ? "(none)"
        : query.tables
            .map((table) =>
              query.replacingTables.includes(table)
                ? `${table} [ReplacingMergeTree]`
                : table
            )
            .join(", ");
    lines.push(
      `${index + 1}. ${formatBytes(query.totalReadBytes)} read · ${formatCount(
        query.runs
      )} run(s)`
    );
    lines.push(`   tables: ${tables}`);
    lines.push(`   ${truncate(query.sampleQuery, 120)}`);
    lines.push("");
  });

  const rmt = workload.filter((query) => query.replacingTables.length > 0).length;
  if (rmt > 0) {
    lines.push(
      `${rmt} of ${workload.length} read ReplacingMergeTree tables — run \`gozzle verify\` on those to check for read-path overcounting.`
    );
  }
  return lines.join("\n").trimEnd();
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
