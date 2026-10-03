// In-memory Durable Object state for Node tests: ctx.storage.sql backed by
// node:sqlite, plus alarm get/set/delete.
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

function cursor(rows: Row[]) {
	return {
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
			return rows[0]!;
		},
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	};
}

export interface FakeState {
	storage: {
		sql: { exec(query: string, ...bindings: unknown[]): ReturnType<typeof cursor> };
		getAlarm(): Promise<number | null>;
		setAlarm(at: number): Promise<void>;
		deleteAlarm(): Promise<void>;
	};
	alarmAt: number | null;
}

export function fakeState(): FakeState {
	const db = new DatabaseSync(":memory:");
	const state: FakeState = {
		alarmAt: null,
		storage: {
			sql: {
				exec(query, ...bindings) {
					const statement = db.prepare(query);
					const params = bindings as (string | number | null)[];
					if (statement.columns().length === 0) {
						statement.run(...params);
						return cursor([]);
					}
					return cursor(statement.all(...params).map((row) => ({ ...row })));
				},
			},
			getAlarm: async () => state.alarmAt,
			setAlarm: async (at) => {
				state.alarmAt = at;
			},
			deleteAlarm: async () => {
				state.alarmAt = null;
			},
		},
	};
	return state;
}

/** Constructs a Durable Object class over a fake state. */
export function construct<T>(Class: new (ctx: never, env: never) => T, env: unknown = {}): { instance: T; state: FakeState } {
	const state = fakeState();
	return { instance: new Class(state as never, env as never), state };
}
