export interface ExplainRow {
  explain: string;
}

export interface SelectionRatio {
  selected: number;
  total: number;
}

export interface IndexEvidence {
  type: "MinMax" | "Partition" | "PrimaryKey";
  condition?: string;
  parts?: SelectionRatio;
  granules?: SelectionRatio;
  keys: string[];
}

export interface TableExplainEvidence {
  table: string;
  indexes: IndexEvidence[];
}

export interface ExplainEvidence {
  lines: string[];
  tables: TableExplainEvidence[];
}

const INDEX_TYPES = new Set<IndexEvidence["type"]>([
  "MinMax",
  "Partition",
  "PrimaryKey"
]);

export function parseExplainRows(rows: ExplainRow[]): ExplainEvidence {
  const lines = rows.map((row) => row.explain);
  const tables: TableExplainEvidence[] = [];
  let table: TableExplainEvidence | undefined;
  let index: IndexEvidence | undefined;
  let indexesIndent = -1;
  let readingKeys = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    const tableMatch = trimmed.match(/^ReadFromMergeTree\s+\(([^)]+)\)$/);
    if (tableMatch) {
      table = { table: tableMatch[1], indexes: [] };
      tables.push(table);
      index = undefined;
      indexesIndent = -1;
      readingKeys = false;
      continue;
    }

    if (!table) continue;
    if (trimmed === "Indexes:") {
      indexesIndent = indent;
      index = undefined;
      continue;
    }
    if (indexesIndent === -1) continue;
    if (indent <= indexesIndent && trimmed !== "Indexes:") {
      index = undefined;
      indexesIndent = -1;
      readingKeys = false;
      continue;
    }
    if (trimmed === "Ranges:" || trimmed.startsWith("Ranges: ")) {
      index = undefined;
      readingKeys = false;
      continue;
    }
    if (INDEX_TYPES.has(trimmed as IndexEvidence["type"])) {
      index = {
        type: trimmed as IndexEvidence["type"],
        keys: []
      };
      table.indexes.push(index);
      readingKeys = false;
      continue;
    }
    if (!index) continue;
    if (trimmed === "Keys:") {
      readingKeys = true;
      continue;
    }
    if (trimmed.startsWith("Condition:")) {
      index.condition = trimmed.slice("Condition:".length).trim();
      readingKeys = false;
      continue;
    }
    const parts = parseRatio(trimmed, "Parts");
    if (parts) {
      index.parts = parts;
      readingKeys = false;
      continue;
    }
    const granules = parseRatio(trimmed, "Granules");
    if (granules) {
      index.granules = granules;
      readingKeys = false;
      continue;
    }
    if (readingKeys && !trimmed.includes(":")) {
      index.keys.push(trimmed);
    }
  }

  return { lines, tables };
}

function parseRatio(line: string, label: string): SelectionRatio | undefined {
  const match = line.match(new RegExp(`^${label}:\\s*(\\d+)\\/(\\d+)$`));
  if (!match) return undefined;
  return { selected: Number(match[1]), total: Number(match[2]) };
}
