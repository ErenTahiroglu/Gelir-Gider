import type { Database } from "../../src/db/client";

/**
 * Minimal in-memory fake of the exact Drizzle query shapes the Budget V2
 * semantic classification services issue: `select().from(t)` with
 * `where(and(eq|inArray))`, `orderBy(desc|asc)`, `for("update")`, `limit(n)`,
 * and `insert(t).values(v).onConflictDoNothing({target})?.returning()`, plus
 * `transaction(cb)`. It decodes conditions structurally from the SQL
 * `queryChunks` -- it does NOT reimplement a query planner.
 *
 * For deterministic lost-race simulation it exposes one-shot hooks:
 *   fake.hook("tx:start", fn)     -- fires once, just before a transaction body
 *   fake.hook("insert:before", fn) -- fires once, just before an insert materializes
 * A registered hook is consumed (spliced) the next time that seam is reached,
 * so a test can commit a "winner" revision in the gap between a caller's
 * pre-transaction idempotency lookup and its in-transaction recheck / insert.
 */
export type Row = Record<string, unknown>;

interface Cond {
	col: string;
	op: "eq" | "in";
	val: unknown;
}

function collect(cond: unknown, out: Cond[]): void {
	const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
	if (!Array.isArray(chunks)) return;
	let curCol: string | undefined;
	let inMode = false;
	const inVals: unknown[] = [];
	const flushIn = () => {
		if (inMode && curCol) out.push({ col: curCol, op: "in", val: [...inVals] });
		inMode = false;
		inVals.length = 0;
	};
	for (const ch of chunks) {
		if (ch && typeof ch === "object" && "queryChunks" in (ch as object)) {
			flushIn();
			collect(ch, out);
			continue;
		}
		const ctor = (ch as { constructor?: { name?: string } })?.constructor?.name;
		if (
			ch &&
			typeof ch === "object" &&
			"name" in (ch as object) &&
			ctor !== "StringChunk" &&
			ctor !== "Param"
		) {
			flushIn();
			curCol = (ch as { name: string }).name;
			continue;
		}
		if (ctor === "StringChunk") {
			const txt = String((ch as { value?: unknown }).value ?? "");
			if (txt.includes(" in (")) inMode = true;
			continue;
		}
		if (ctor === "Param") {
			const value = (ch as { value: unknown }).value;
			if (inMode) inVals.push(value);
			else if (curCol) out.push({ col: curCol, op: "eq", val: value });
		}
	}
	flushIn();
}

function colKey(table: unknown, sqlName: string): string {
	for (const [k, c] of Object.entries(table as Record<string, unknown>)) {
		if (
			c &&
			typeof c === "object" &&
			(c as { name?: unknown }).name === sqlName
		) {
			return k;
		}
	}
	throw new Error(`pg-fake: unknown column "${sqlName}"`);
}

type HookName = "tx:start" | "insert:before";

export interface PgFake {
	db: Database;
	store: Map<unknown, Row[]>;
	seed(table: unknown, rows: Row[]): void;
	rows(table: unknown): Row[];
	/** Register a one-shot hook consumed the next time that seam is reached. */
	hook(name: HookName, fn: () => unknown | Promise<unknown>): void;
}

let counter = 0;
export function makePgFake(): PgFake {
	const store = new Map<unknown, Row[]>();
	const hooks: Record<HookName, Array<() => unknown | Promise<unknown>>> = {
		"tx:start": [],
		"insert:before": [],
	};
	const fireHooks = async (name: HookName) => {
		for (const fn of hooks[name].splice(0)) await fn();
	};
	const tableRows = (t: unknown): Row[] => {
		let r = store.get(t);
		if (!r) {
			r = [];
			store.set(t, r);
		}
		return r;
	};

	function makeSelect() {
		let table: unknown;
		let rows: Row[] = [];
		let lim: number | undefined;
		const b = {
			from(t: unknown) {
				table = t;
				rows = [...tableRows(t)];
				return b;
			},
			where(cond: unknown) {
				const conds: Cond[] = [];
				collect(cond, conds);
				for (const c of conds) {
					const jk = colKey(table, c.col);
					if (c.op === "eq") rows = rows.filter((r) => r[jk] === c.val);
					else rows = rows.filter((r) => (c.val as unknown[]).includes(r[jk]));
				}
				return b;
			},
			for() {
				return b;
			},
			orderBy(...orders: unknown[]) {
				const specs = orders.map((o) => {
					const chunks = (o as { queryChunks: unknown[] }).queryChunks;
					const col = chunks.find(
						(c) =>
							c &&
							typeof c === "object" &&
							"name" in (c as object) &&
							(c as { constructor?: { name?: string } }).constructor?.name !==
								"StringChunk",
					) as { name: string };
					const dir = chunks.some((c) =>
						String((c as { value?: unknown })?.value ?? "").includes("desc"),
					)
						? "desc"
						: "asc";
					return { jk: colKey(table, col.name), dir };
				});
				rows = [...rows].sort((x, y) => {
					for (const s of specs) {
						const a = x[s.jk] as number | string;
						const bb = y[s.jk] as number | string;
						if (a !== bb)
							return (a < bb ? -1 : 1) * (s.dir === "desc" ? -1 : 1);
					}
					return 0;
				});
				return b;
			},
			limit(n: number) {
				lim = n;
				return b;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder
			then(res: (v: unknown) => void, rej: (e: unknown) => void) {
				try {
					res(lim !== undefined ? rows.slice(0, lim) : rows);
				} catch (e) {
					rej(e);
				}
			},
		};
		return b;
	}

	const handle = {
		select: () => makeSelect(),
		insert: (t: unknown) => ({
			values(v: Row) {
				let conflictCols: string[] | null = null;
				const chain = {
					onConflictDoNothing(cfg?: { target?: unknown }) {
						const tgt = cfg?.target;
						const cols = Array.isArray(tgt)
							? tgt
							: tgt && typeof tgt === "object" && "name" in (tgt as object)
								? [tgt]
								: [];
						conflictCols = cols.map((c) =>
							colKey(t, (c as { name: string }).name),
						);
						return chain;
					},
					async returning() {
						await fireHooks("insert:before");
						if (conflictCols && conflictCols.length > 0) {
							const clash = tableRows(t).some((r) =>
								(conflictCols as string[]).every((jk) => r[jk] === v[jk]),
							);
							if (clash) return [];
						}
						const rec: Row = {
							id: `fake-${++counter}-${crypto.randomUUID()}`,
							createdAt: new Date(),
							...v,
						};
						tableRows(t).push(rec);
						return [rec];
					},
				};
				return chain;
			},
		}),
		transaction: async (cb: (tx: unknown) => unknown) => {
			await fireHooks("tx:start");
			return cb(handle);
		},
	};

	return {
		db: handle as unknown as Database,
		store,
		seed(table, rows) {
			tableRows(table).push(...rows);
		},
		rows: tableRows,
		hook(name, fn) {
			hooks[name].push(fn);
		},
	};
}
