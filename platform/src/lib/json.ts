/** JSON-serializable value: the shape of anything passed over Durable Object RPC. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
