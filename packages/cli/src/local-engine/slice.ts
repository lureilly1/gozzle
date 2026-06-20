import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  ClickHouseExportClient,
  ClickHouseMetadataClient
} from "../clickhouse/client.js";
import { verifyDedup, type VerifyDedupResult } from "../clickhouse/dedup.js";
import {
  formatTableIdentifier,
  quoteIdentifier
} from "../clickhouse/identifier.js";
import {
  inspectTable,
  type TableColumn,
  type TableInspection
} from "../clickhouse/table-inspection.js";
import type { LocalSliceConfig } from "../config/local-slice.js";
import type { LocalEngine } from "./types.js";
import { totalLocalSliceBytes, workspaceSize } from "./slice-store.js";

export interface CreateLocalSliceOptions {
  table: string;
  defaultDatabase: string;
  partitionId?: string;
}

export interface LocalSliceManifest {
  version: 1;
  createdAt: string;
  engine: string;
  source: {
    table: string;
    partitionId: string;
    rows: number;
    bytesOnDisk: number;
  };
  local: {
    table: string;
    createStatement: string;
    dataFile: string;
    dataBytes: number;
  };
  proof: {
    sourceDuplicateRows: number;
    localDuplicateRows: number;
    matched: boolean;
  };
}

export interface LocalSliceResult {
  workspacePath: string;
  manifestPath: string;
  manifest: LocalSliceManifest;
  sourceProof: VerifyDedupResult;
  localProof: VerifyDedupResult;
  warnings: string[];
  workspaceSizeBytes: number;
  totalStorageBytes: number;
  cleanupCommand: string;
}

interface PartitionRow {
  partition_id: string;
  rows: string | number;
  bytes_on_disk: string | number;
}

export async function createLocalSlice(
  source: ClickHouseExportClient,
  localEngine: LocalEngine,
  options: CreateLocalSliceOptions,
  config: LocalSliceConfig
): Promise<LocalSliceResult> {
  const inspection = await inspectTable(source, {
    table: options.table,
    defaultDatabase: options.defaultDatabase
  });
  assertEligible(inspection);

  const partitions = await readPartitions(source, inspection);
  const partition = selectPartition(partitions, options.partitionId);
  enforceBudget(partition, config);
  await enforceTotalStorageBudget(partition, config);

  await mkdir(config.rootDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.rootDirectory, 0o700);
  const workspacePath = await mkdtemp(join(config.rootDirectory, "slice-"));
  const dataPath = join(workspacePath, "data.parquet");
  const manifestPath = join(workspacePath, "manifest.json");
  const localTable = `gozzle_slice.${quoteIdentifier(inspection.identifier.table)}`;
  const insertColumns = inspection.columns
    .filter(isInsertableColumn)
    .map((column) => column.name);

  try {
    const exportResult = await source.exportParquet(
      buildExportQuery(inspection, partition.partition_id, insertColumns),
      dataPath,
      { maxRows: config.maxRows, maxBytes: config.maxBytes }
    );
    const createStatement = buildLocalCreateStatement(inspection);
    const localClient = await localEngine.replay({
      workspacePath,
      createStatement,
      dataPath,
      tableName: localTable,
      insertColumns
    });

    let localProof: VerifyDedupResult;
    try {
      localProof = await verifyDedup(localClient, {
        table: `gozzle_slice.${inspection.identifier.table}`,
        defaultDatabase: "gozzle_slice"
      });
    } finally {
      await localClient.close();
    }

    const sourceProof = await verifyDedup(source, {
      table: options.table,
      defaultDatabase: options.defaultDatabase,
      partitionId: partition.partition_id
    });
    const matched = proofsMatch(sourceProof, localProof);
    const warnings = [
      "This workspace contains production data and persists until you remove it. Protect access to the slice directory and apply an appropriate retention period."
    ];
    if (!matched) {
      warnings.push(
        "Source and local proof differ. This usually means the source partition changed during export. Remove this workspace and recreate the slice before relying on it."
      );
    }
    const manifest: LocalSliceManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      engine: localEngine.name,
      source: {
        table: `${inspection.identifier.database}.${inspection.identifier.table}`,
        partitionId: partition.partition_id,
        rows: toNumber(partition.rows),
        bytesOnDisk: toNumber(partition.bytes_on_disk)
      },
      local: {
        table: `gozzle_slice.${inspection.identifier.table}`,
        createStatement,
        dataFile: "data.parquet",
        dataBytes: exportResult.bytesWritten
      },
      proof: {
        sourceDuplicateRows: sourceProof.duplicateRows,
        localDuplicateRows: localProof.duplicateRows,
        matched
      }
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });

    const workspaceSizeBytes = await workspaceSize(workspacePath);
    const totalStorageBytes = await totalLocalSliceBytes(config.rootDirectory);
    if (totalStorageBytes > config.maxTotalBytes) {
      throw new Error(
        `Creating this slice would use ${totalStorageBytes} bytes across local workspaces, above GOZZLE_MAX_TOTAL_SLICE_BYTES=${config.maxTotalBytes}. The new workspace was removed; run 'gozzle slices clean --older-than 7d' or raise the limit.`
      );
    }

    return {
      workspacePath,
      manifestPath,
      manifest,
      sourceProof,
      localProof,
      warnings,
      workspaceSizeBytes,
      totalStorageBytes,
      cleanupCommand: `gozzle slices clean ${basename(workspacePath)}`
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

async function enforceTotalStorageBudget(
  partition: PartitionRow,
  config: LocalSliceConfig
): Promise<void> {
  const current = await totalLocalSliceBytes(config.rootDirectory);
  const projectedSlice = toNumber(partition.bytes_on_disk) * 2;
  const projectedTotal = current + projectedSlice;
  if (projectedTotal > config.maxTotalBytes) {
    throw new Error(
      `Projected local slice storage is ${projectedTotal} bytes (${current} existing + approximately ${projectedSlice} for Parquet and chDB), above GOZZLE_MAX_TOTAL_SLICE_BYTES=${config.maxTotalBytes}. Run 'gozzle slices clean --older-than 7d' or raise the limit.`
    );
  }
}

async function readPartitions(
  client: ClickHouseMetadataClient,
  inspection: TableInspection
): Promise<PartitionRow[]> {
  const database = quoteStringLiteral(inspection.identifier.database);
  const table = quoteStringLiteral(inspection.identifier.table);
  return client.queryJson<PartitionRow>(`
    SELECT
      partition_id,
      sum(rows) AS rows,
      sum(bytes_on_disk) AS bytes_on_disk
    FROM system.parts
    WHERE database = ${database}
      AND table = ${table}
      AND active
    GROUP BY partition_id
    ORDER BY partition_id
  `);
}

function selectPartition(
  partitions: PartitionRow[],
  requested: string | undefined
): PartitionRow {
  if (partitions.length === 0) {
    throw new Error("The table has no active data parts to reproduce.");
  }

  if (requested) {
    const partition = partitions.find((row) => row.partition_id === requested);
    if (!partition) {
      throw new Error(`Partition not found: ${requested}`);
    }
    return partition;
  }

  if (partitions.length > 1) {
    const examples = partitions
      .slice(0, 10)
      .map((row) => row.partition_id)
      .join(", ");
    throw new Error(
      `Table has ${partitions.length} active partitions. Choose partitionId explicitly. Available: ${examples}`
    );
  }

  return partitions[0];
}

function enforceBudget(partition: PartitionRow, config: LocalSliceConfig): void {
  const rows = toNumber(partition.rows);
  const bytes = toNumber(partition.bytes_on_disk);
  if (rows > config.maxRows) {
    throw new Error(
      `Partition ${partition.partition_id} has ${rows} rows, above GOZZLE_MAX_SLICE_ROWS=${config.maxRows}. No partial slice was created.`
    );
  }
  if (bytes > config.maxBytes) {
    throw new Error(
      `Partition ${partition.partition_id} uses ${bytes} bytes on disk, above GOZZLE_MAX_SLICE_BYTES=${config.maxBytes}. No partial slice was created.`
    );
  }
}

function assertEligible(inspection: TableInspection): void {
  if (inspection.isDistributed) {
    throw new Error(
      "Distributed tables cannot be reproduced faithfully yet. Select an underlying local table."
    );
  }
  if (!inspection.isReplacingMergeTree || !inspection.sortingKey) {
    throw new Error(
      `Engine ${inspection.engine} is not eligible for the Phase 5 ReplacingMergeTree local slice.`
    );
  }
}

function buildExportQuery(
  inspection: TableInspection,
  partitionId: string,
  columns: string[]
): string {
  if (columns.length === 0) {
    throw new Error("The table has no insertable columns to export.");
  }
  return `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${formatTableIdentifier(
    inspection.identifier
  )} WHERE _partition_id = ${quoteStringLiteral(partitionId)}`;
}

export function buildLocalCreateStatement(
  inspection: TableInspection
): string {
  const columns = inspection.columns.map(formatColumn).join(",\n  ");
  const replacing = inspection.replacingMergeTree;
  const engineArguments = [
    replacing?.versionColumn,
    replacing?.deletedColumn
  ].filter(Boolean);
  const clauses = [
    "CREATE DATABASE IF NOT EXISTS gozzle_slice",
    `CREATE TABLE gozzle_slice.${quoteIdentifier(inspection.identifier.table)} (\n  ${columns}\n)`,
    `ENGINE = ReplacingMergeTree(${engineArguments.join(", ")})`,
    inspection.partitionBy ? `PARTITION BY ${inspection.partitionBy}` : undefined,
    `ORDER BY ${inspection.sortingKey}`,
    inspection.primaryKey && inspection.primaryKey !== inspection.sortingKey
      ? `PRIMARY KEY ${inspection.primaryKey}`
      : undefined
  ].filter(Boolean);

  return `${clauses[0]};\n${clauses.slice(1).join("\n")}`;
}

function formatColumn(column: TableColumn): string {
  const pieces = [quoteIdentifier(column.name), column.type];
  if (column.defaultKind && column.defaultExpression) {
    pieces.push(column.defaultKind, column.defaultExpression);
  }
  if (column.codecExpression) {
    pieces.push(
      column.codecExpression.startsWith("CODEC(")
        ? column.codecExpression
        : `CODEC(${column.codecExpression})`
    );
  }
  return pieces.join(" ");
}

function isInsertableColumn(column: TableColumn): boolean {
  return !["ALIAS", "MATERIALIZED", "EPHEMERAL"].includes(
    column.defaultKind ?? ""
  );
}

function proofsMatch(source: VerifyDedupResult, local: VerifyDedupResult): boolean {
  return (
    source.duplicateGroups === local.duplicateGroups &&
    source.duplicateRows === local.duplicateRows &&
    source.maxCopies === local.maxCopies
  );
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
