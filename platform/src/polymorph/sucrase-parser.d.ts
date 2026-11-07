// The parts of sucrase's internal parser that tokens.ts reads. Sucrase's
// public entry has no token API, so tokens.ts imports these files of its ES
// module build directly. They are typed unknown on purpose: the adapter checks
// their shape at run time instead of trusting a declaration that an upgrade
// could outdate.
declare module "sucrase/dist/esm/parser/index.js" {
	export const parse: unknown;
}

declare module "sucrase/dist/esm/parser/tokenizer/types.js" {
	export const TokenType: unknown;
}

// The parser's state, which keeps the last token array until the next parse.
// tokens.ts parses an empty module after each read so a large array can be
// collected, and polymorph-morph.test.ts reads the state to check that.
declare module "sucrase/dist/esm/parser/traverser/base.js" {
	export let state: unknown;
}
