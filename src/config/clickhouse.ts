export interface ClickHouseConnectionConfig {
  url: string;
  username: string;
  password: string;
  database?: string;
}

export interface ClickHouseConfigEnv {
  CLICKHOUSE_URL?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_USERNAME?: string;
  CLICKHOUSE_PASSWORD?: string;
  CLICKHOUSE_DATABASE?: string;
  GOZZLE_CLICKHOUSE_URL?: string;
  GOZZLE_CLICKHOUSE_USER?: string;
  GOZZLE_CLICKHOUSE_USERNAME?: string;
  GOZZLE_CLICKHOUSE_PASSWORD?: string;
  GOZZLE_CLICKHOUSE_DATABASE?: string;
}

export function readClickHouseConfig(
  env: ClickHouseConfigEnv = process.env
): ClickHouseConnectionConfig {
  const url = firstNonEmpty(env.GOZZLE_CLICKHOUSE_URL, env.CLICKHOUSE_URL);

  if (!url) {
    throw new Error(
      "Missing ClickHouse URL. Set GOZZLE_CLICKHOUSE_URL or CLICKHOUSE_URL."
    );
  }

  validateUrl(url);

  return {
    url,
    username:
      firstNonEmpty(
        env.GOZZLE_CLICKHOUSE_USER,
        env.GOZZLE_CLICKHOUSE_USERNAME,
        env.CLICKHOUSE_USER,
        env.CLICKHOUSE_USERNAME
      ) ?? "default",
    password:
      firstNonEmpty(env.GOZZLE_CLICKHOUSE_PASSWORD, env.CLICKHOUSE_PASSWORD) ??
      "",
    database: firstNonEmpty(
      env.GOZZLE_CLICKHOUSE_DATABASE,
      env.CLICKHOUSE_DATABASE
    )
  };
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function validateUrl(url: string): void {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ClickHouse URL must use http or https.");
  }
}

