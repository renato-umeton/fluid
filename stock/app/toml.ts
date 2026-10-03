// Minimal TOML reader for fluid.toml: [sections], key = value, strings,
// numbers, booleans, and comments. Anything else is rejected loudly.

export type TomlValue = string | number | boolean;
export type TomlTable = { [key: string]: TomlValue | TomlTable };

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComment(raw).trim();
    if (line === "") return;
    const section = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (section) {
      table = {};
      root[section[1]!] = table;
      return;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new Error(`fluid.toml line ${index + 1}: expected key = value, got "${raw.trim()}"`);
    table[pair[1]!] = parseValue(pair[2]!.trim(), index + 1);
  });
  return root;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    if (line[i] === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string, lineNumber: number): TomlValue {
  if (/^".*"$/.test(raw)) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new Error(`fluid.toml line ${lineNumber}: unsupported value "${raw}"`);
}
