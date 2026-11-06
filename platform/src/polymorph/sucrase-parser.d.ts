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
