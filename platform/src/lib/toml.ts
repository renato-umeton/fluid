// fluid.toml handling on the platform: the same minimal dialect as the stock
// reader (sections, key = value, strings, numbers, booleans, comments), plus
// an editor that changes one value while keeping comments and layout.

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

export function formatTomlValue(value: TomlValue): string {
	if (typeof value === "string") {
		if (/["\n\\]/.test(value)) throw new Error(`fluid.toml: string values may not contain quotes, backslashes, or newlines: ${JSON.stringify(value)}`);
		return `"${value}"`;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`fluid.toml: number must be finite, got ${value}`);
		return String(value);
	}
	return value ? "true" : "false";
}

/**
 * Sets `key` in `section` (null = top level) and returns the new text. An
 * existing line keeps its trailing comment; a missing key is appended to its
 * section; a missing section is appended at the end.
 */
export function setTomlValue(text: string, section: string | null, key: string, value: TomlValue): string {
	if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`fluid.toml: invalid key ${JSON.stringify(key)}`);
	if (section !== null && !/^[A-Za-z0-9_.-]+$/.test(section)) throw new Error(`fluid.toml: invalid section ${JSON.stringify(section)}`);
	const lines = text.replace(/\n+$/, "").split(/\r?\n/);
	const formatted = formatTomlValue(value);
	let current: string | null = null;
	let sectionEnd = section === null ? firstSectionIndex(lines) : -1;
	for (let i = 0; i < lines.length; i++) {
		const content = stripComment(lines[i]!).trim();
		const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(content);
		if (header) {
			current = header[1]!;
			if (current === section) sectionEnd = i + 1;
			continue;
		}
		if (current !== section) continue;
		if (section !== null && content !== "") sectionEnd = i + 1;
		const pair = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)([^#]*?)(\s*#.*)?$/.exec(lines[i]!);
		if (pair && pair[2] === key) {
			lines[i] = `${pair[1]}${key}${pair[3]}${formatted}${pair[5] ?? ""}`;
			return `${lines.join("\n")}\n`;
		}
	}
	const newLine = `${key} = ${formatted}`;
	if (section !== null && sectionEnd === -1) return `${lines.join("\n")}\n\n[${section}]\n${newLine}\n`;
	lines.splice(sectionEnd, 0, newLine);
	return `${lines.join("\n")}\n`;
}

function firstSectionIndex(lines: string[]): number {
	const index = lines.findIndex((line) => /^\[[A-Za-z0-9_.-]+\]$/.test(stripComment(line).trim()));
	if (index === -1) return lines.length;
	let end = index;
	while (end > 0 && lines[end - 1]!.trim() === "") end--;
	return end;
}
