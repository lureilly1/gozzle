// Quote- and paren-aware scanning shared by the query and migration validators.
// This is security-relevant parsing (it decides what counts as a top-level
// keyword vs. text inside a string literal), so it lives in one place and is
// tested once — two drifting copies would be a real footgun.

/** Scan `input`, returning the index where `matches` first holds at paren depth 0
 *  outside any string/identifier literal, or -1. */
export function scanTopLevel(
  input: string,
  matches: (character: string, index: number) => boolean
): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (input[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && matches(character, index)) return index;
  }
  return -1;
}

/** Index of a top-level keyword (whole-word, case-insensitive), or -1. */
export function findTopLevelKeyword(input: string, keyword: string): number {
  return scanTopLevel(input, (_character, index) => {
    const before = index === 0 ? " " : input[index - 1];
    const after = input[index + keyword.length] ?? " ";
    return (
      input.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Za-z0-9_]/.test(before) &&
      !/[A-Za-z0-9_]/.test(after)
    );
  });
}

/** Index where a top-level multi-word phrase (e.g. "IN PARTITION") begins, or -1. */
export function findTopLevelWords(input: string, words: string): number {
  const pattern = new RegExp(
    `^${words
      .split(/\s+/)
      .map((word) => escapeRegExp(word))
      .join("\\s+")}(?![A-Za-z0-9_])`,
    "i"
  );
  return scanTopLevel(input, (_character, index) => {
    const before = index === 0 ? " " : input[index - 1];
    return !/[A-Za-z0-9_]/.test(before) && pattern.test(input.slice(index));
  });
}

/** Blank out the contents of string/identifier literals (to spaces), so keyword
 *  and function detection never matches inside a literal. */
export function maskQuoted(input: string): string {
  const characters = [...input];
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      characters[index] = " ";
      if (character === "\\") {
        if (index + 1 < characters.length) {
          characters[index + 1] = " ";
          index += 1;
        }
      } else if (character === quote) {
        if (input[index + 1] === quote) {
          characters[index + 1] = " ";
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
