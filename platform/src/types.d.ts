// The Workers runtime provides node:buffer under nodejs_compat; only the
// Buffer constructor is used (isomorphic-git expects it on globalThis).
declare module "node:buffer" {
	export const Buffer: unknown;
}
