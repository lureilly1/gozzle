/** Human-readable byte sizes (binary units). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Integer counts with thousands separators (e.g. 184203991 -> "184,203,991"). */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}
