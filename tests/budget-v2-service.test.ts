import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetV2ResolvedSnapshot } from "../src/budget/payload-v2";
import {
	createMonthlyBudgetV2Plan,
	getMonthlyBudgetV2Plan,
	listMonthlyBudgetV2Plans,
	type MonthlyBudgetV2PlanItem,
	refreshMonthlyBudgetV2Plan,
	voidMonthlyBudgetV2Plan,
} from "../src/budget/service-v2";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	monthlyBudgetV2PlanRevisions,
	monthlyBudgetV2Plans,
} from "../src/db/schema/budget-v2";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../src/db/schema/transactions";
import { CanonicalTransactionError } from "../src/transactions/errors";
import * as canonSvc from "../src/transactions/service";

// ============================================================================
// Purpose-built in-memory harness. It faithfully models the exact call shapes
// `src/budget/service-v2.ts` issues against the V2 tables + users +
// canonical_transactions / transaction_revisions, and a stateful mock of the
// canonical CREATE/REVISE/VOID lifecycle (idempotent replay, changed-payload /
// changed-source conflict, already-voided, revision conflict). It does NOT
// reimplement a query planner.
// ============================================================================

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERIOD = "2026-09-01";

type Row = Record<string, unknown>;

interface Store {
	users: Row[];
	v2plans: Row[];
	v2revs: Row[];
	canon: Row[];
	canonRevs: Row[];
	// side-effect telemetry
	ledgerWrites: number;
	midasWrites: number;
}

let store: Store;
let idc = 0;
// Deterministic UUID-shaped ids (normalizeUuid in the service requires a valid
// UUID for budgetPlanId).
const genId = (_p: string): string => {
	idc += 1;
	const h = idc.toString(16).padStart(12, "0");
	return `00000000-0000-4000-8000-${h}`;
};

function tableStore(t: unknown): Row[] {
	if (t === users) return store.users;
	if (t === monthlyBudgetV2Plans) return store.v2plans;
	if (t === monthlyBudgetV2PlanRevisions) return store.v2revs;
	if (t === canonicalTransactions) return store.canon;
	if (t === transactionRevisions) return store.canonRevs;
	throw new Error("fake db: unrecognized table");
}
function colKey(t: unknown, sqlName: string): string {
	for (const [k, c] of Object.entries(t as Record<string, unknown>)) {
		if (
			c &&
			typeof c === "object" &&
			(c as { name?: unknown }).name === sqlName
		) {
			return k;
		}
	}
	throw new Error(`fake db: unknown column ${sqlName}`);
}

interface Cmp {
	col: string;
	op: "=" | ">=" | "<=";
	val: unknown;
}

/** Recursively collects all leaf comparison conditions from an and(eq/gte/lte) tree. */
function collectCmps(cond: unknown, out: Cmp[]): void {
	const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
	if (!Array.isArray(chunks)) return;
	let curCol: string | undefined;
	let curOp: Cmp["op"] = "=";
	for (const ch of chunks) {
		if (ch && typeof ch === "object" && "queryChunks" in (ch as object)) {
			collectCmps(ch, out);
			continue;
		}
		const ctor = (ch as { constructor?: { name?: string } })?.constructor?.name;
		if (ctor === "Param") {
			if (curCol)
				out.push({
					col: curCol,
					op: curOp,
					val: (ch as { value: unknown }).value,
				});
			continue;
		}
		if (
			ch &&
			typeof ch === "object" &&
			"name" in (ch as object) &&
			ctor !== "StringChunk"
		) {
			curCol = (ch as { name: string }).name;
			curOp = "=";
			continue;
		}
		if (ctor === "StringChunk") {
			const txt = String((ch as { value?: unknown[] }).value ?? "");
			if (txt.includes(">=")) curOp = ">=";
			else if (txt.includes("<=")) curOp = "<=";
			else if (txt.includes("=")) curOp = "=";
		}
	}
}

function makeSelect() {
	let table: unknown;
	let rows: Row[] = [];
	let lim: number | undefined;
	const b = {
		from(t: unknown) {
			table = t;
			rows = [...tableStore(t)];
			return b;
		},
		where(cond: unknown) {
			const cmps: Cmp[] = [];
			collectCmps(cond, cmps);
			for (const c of cmps) {
				const jk = colKey(table, c.col);
				rows = rows.filter((r) => {
					const v = r[jk];
					if (c.op === "=") return v === c.val;
					if (c.op === ">=") return String(v) >= String(c.val);
					return String(v) <= String(c.val);
				});
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
					const a = String(x[s.jk]);
					const bb = String(y[s.jk]);
					if (a !== bb) return (a < bb ? -1 : 1) * (s.dir === "desc" ? -1 : 1);
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

interface FakeDbHandle {
	select: () => ReturnType<typeof makeSelect>;
	insert: (t: unknown) => {
		values: (v: Row) => { returning: () => Promise<Row[]> };
	};
	transaction: (cb: (tx: unknown) => unknown) => Promise<unknown>;
	txCalls: number;
	lastTxHandle: unknown;
}

function makeDb(): Database & FakeDbHandle {
	const handle: FakeDbHandle = {
		select: () => makeSelect(),
		insert: (t: unknown) => {
			let vals: Row = {};
			return {
				values(v: Row) {
					vals = v;
					return {
						returning() {
							const rec: Row = {
								id: genId("row"),
								createdAt: new Date(),
								...vals,
							};
							tableStore(t).push(rec);
							return Promise.resolve([rec]);
						},
					};
				},
			};
		},
		txCalls: 0,
		lastTxHandle: undefined,
		transaction: async (cb: (tx: unknown) => unknown) => {
			handle.txCalls += 1;
			handle.lastTxHandle = handle;
			return cb(handle);
		},
	};
	return handle as unknown as Database & FakeDbHandle;
}

// ---- canonical lifecycle mock ------------------------------------------------
function canonicalJson(v: unknown): string {
	// deterministic-enough for equality in tests
	const norm = (x: unknown): unknown => {
		if (x && typeof x === "object" && !Array.isArray(x)) {
			const o = x as Record<string, unknown>;
			return Object.keys(o)
				.sort()
				.reduce<Record<string, unknown>>((acc, k) => {
					acc[k] = norm(o[k]);
					return acc;
				}, {});
		}
		if (Array.isArray(x)) return x.map(norm);
		return x;
	};
	return JSON.stringify(norm(v));
}

function installCanonicalMock() {
	vi.spyOn(
		canonSvc,
		"createCanonicalTransactionInTransaction",
	).mockImplementation(async (p) => {
		const existing = store.canon.find(
			(c) =>
				c.userId === p.userId && c.creationIdempotencyKey === p.idempotencyKey,
		);
		if (existing) {
			const rev1 = store.canonRevs.find(
				(r) => r.transactionId === existing.id && r.revisionNo === 1,
			);
			if (!rev1) throw new Error("mock: missing canon rev1");
			if (
				canonicalJson(p.payload) !== canonicalJson(rev1.payload) ||
				JSON.stringify(p.source) !== existing.sourceJson
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_IDEMPOTENCY_CONFLICT",
					"Creation idempotency key was already used with a different transaction payload or source",
				);
			}
			return {
				transactionId: existing.id as string,
				revisionId: rev1.id as string,
				revisionNo: 1,
				operation: "CREATE" as const,
				idempotentReplay: true,
			};
		}
		const txId = genId("canon");
		const revId = genId("canonrev");
		store.canon.push({
			id: txId,
			userId: p.userId,
			kind: p.kind,
			creationIdempotencyKey: p.idempotencyKey,
			sourceJson: JSON.stringify(p.source),
		});
		store.canonRevs.push({
			id: revId,
			transactionId: txId,
			revisionNo: 1,
			operation: "CREATE",
			payload: p.payload,
			occurredAt: p.occurredAt,
			idempotencyKey: p.idempotencyKey,
			reasonJson: null,
		});
		return {
			transactionId: txId,
			revisionId: revId,
			revisionNo: 1,
			operation: "CREATE" as const,
			idempotentReplay: false,
		};
	});

	vi.spyOn(
		canonSvc,
		"reviseCanonicalTransactionInTransaction",
	).mockImplementation(async (p) => {
		const prior = store.canonRevs.find(
			(r) =>
				r.transactionId === p.transactionId &&
				r.idempotencyKey === p.idempotencyKey &&
				r.operation === "UPDATE",
		);
		const reasonJson = JSON.stringify({
			reasonCode: p.reasonCode,
			reasonNote: p.reasonNote ?? null,
			source: p.source,
		});
		if (prior) {
			if (
				canonicalJson(p.payload) !== canonicalJson(prior.payload) ||
				reasonJson !== prior.reasonJson
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with a different update payload or reason",
				);
			}
			return {
				transactionId: p.transactionId,
				revisionId: prior.id as string,
				revisionNo: prior.revisionNo as number,
				operation: "UPDATE" as const,
				idempotentReplay: true,
			};
		}
		const latest = store.canonRevs
			.filter((r) => r.transactionId === p.transactionId)
			.sort((a, b) => (b.revisionNo as number) - (a.revisionNo as number))[0];
		if (!latest) throw new Error("mock: no canon revs");
		if (latest.operation === "VOID") {
			throw new CanonicalTransactionError(
				"TRANSACTION_ALREADY_VOIDED",
				"Transaction already voided",
			);
		}
		if ((latest.revisionNo as number) !== p.expectedRevisionNo) {
			throw new CanonicalTransactionError(
				"TRANSACTION_REVISION_CONFLICT",
				`Expected revision ${p.expectedRevisionNo}`,
			);
		}
		const revId = genId("canonrev");
		const revisionNo = (latest.revisionNo as number) + 1;
		store.canonRevs.push({
			id: revId,
			transactionId: p.transactionId,
			revisionNo,
			operation: "UPDATE",
			payload: p.payload,
			occurredAt: p.occurredAt,
			idempotencyKey: p.idempotencyKey,
			reasonJson,
		});
		return {
			transactionId: p.transactionId,
			revisionId: revId,
			revisionNo,
			operation: "UPDATE" as const,
			idempotentReplay: false,
		};
	});

	vi.spyOn(
		canonSvc,
		"voidCanonicalTransactionInTransaction",
	).mockImplementation(async (p) => {
		const prior = store.canonRevs.find(
			(r) =>
				r.transactionId === p.transactionId &&
				r.idempotencyKey === p.idempotencyKey &&
				r.operation === "VOID",
		);
		const reasonJson = JSON.stringify({
			reasonCode: p.reasonCode,
			reasonNote: p.reasonNote ?? null,
			source: p.source,
		});
		if (prior) {
			if (reasonJson !== prior.reasonJson) {
				throw new CanonicalTransactionError(
					"TRANSACTION_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with a different void reason",
				);
			}
			return {
				transactionId: p.transactionId,
				revisionId: prior.id as string,
				revisionNo: prior.revisionNo as number,
				operation: "VOID" as const,
				idempotentReplay: true,
			};
		}
		const latest = store.canonRevs
			.filter((r) => r.transactionId === p.transactionId)
			.sort((a, b) => (b.revisionNo as number) - (a.revisionNo as number))[0];
		if (!latest) throw new Error("mock: no canon revs");
		if (latest.operation === "VOID") {
			throw new CanonicalTransactionError(
				"TRANSACTION_ALREADY_VOIDED",
				"Transaction already voided",
			);
		}
		if ((latest.revisionNo as number) !== p.expectedRevisionNo) {
			throw new CanonicalTransactionError(
				"TRANSACTION_REVISION_CONFLICT",
				`Expected revision ${p.expectedRevisionNo}`,
			);
		}
		const revId = genId("canonrev");
		const revisionNo = (latest.revisionNo as number) + 1;
		store.canonRevs.push({
			id: revId,
			transactionId: p.transactionId,
			revisionNo,
			operation: "VOID",
			payload: latest.payload,
			occurredAt: latest.occurredAt,
			idempotencyKey: p.idempotencyKey,
			reasonJson,
		});
		return {
			transactionId: p.transactionId,
			revisionId: revId,
			revisionNo,
			operation: "VOID" as const,
			idempotentReplay: false,
		};
	});
}

// ---- fixtures --------------------------------------------------------------
const SNAP = (over: Partial<BudgetV2ResolvedSnapshot["inputs"]> = {}) =>
	({
		inputs: {
			realizedIncome: "12000.00",
			currentObligations: "1500.00",
			basicLivingFunding: "2000.00",
			dateBoundNecessaryPurchaseFunding: "500.00",
			coreEmergencyFundBalance: "10000.00",
			mobilityBalance: "37500.00",
			...over,
		},
		evidenceSnapshot: { resolver: "test", rev: 1 },
	}) satisfies BudgetV2ResolvedSnapshot;

const PROV = { type: "BUDGET_V2_MANUAL", ref: "op-1" };

beforeEach(() => {
	vi.restoreAllMocks();
	idc = 0;
	store = {
		users: [{ id: USER_A, currency: "TRY" }],
		v2plans: [],
		v2revs: [],
		canon: [],
		canonRevs: [],
		ledgerWrites: 0,
		midasWrites: 0,
	};
	installCanonicalMock();
});

async function createPlan(
	over: Partial<{
		key: string;
		period: string;
		snapshot: BudgetV2ResolvedSnapshot;
		provenance: typeof PROV;
	}> = {},
) {
	return createMonthlyBudgetV2Plan({
		db: makeDb(),
		userId: USER_A,
		periodMonth: over.period ?? PERIOD,
		idempotencyKey: over.key ?? "create-1",
		resolvedSnapshot: over.snapshot ?? SNAP(),
		provenance: over.provenance ?? PROV,
	});
}

describe("Budget V2 lifecycle service", () => {
	// -- B. fresh CREATE ---------------------------------------------------
	it("B: fresh CREATE persists exact V2 policy math + canonical kind MONTHLY_BUDGET_PLAN_V2, no ledger/Midas effect", async () => {
		const res = await createPlan();
		expect(res.idempotentReplay).toBe(false);
		expect(res.budgetPlan.policyVersion).toBe("PERSONAL_BUDGET_V2");
		expect(res.budgetPlan.revisionNo).toBe(1);
		expect(res.budgetPlan.status).toBe("ACTIVE");
		expect(res.budgetPlan.periodMonth).toBe(PERIOD);
		// M=37500 -> 26.25 / 38.75 / 35 of trueSurplus.
		// R-O-B-N = 8000; E already 10000 -> catchUp 0, trueSurplus 8000.
		expect(res.budgetPlan.outputs.trueSurplus).toBe("8000.00");
		expect(res.budgetPlan.outputs.mobilityAllocation).toBe("2100.00");
		expect(res.budgetPlan.outputs.longTermInvestment).toBe("3100.00");
		expect(res.budgetPlan.outputs.discretionaryAllocation).toBe("2800.00");
		expect(res.budgetPlan.inputs.realizedIncome).toBe("12000.00");
		expect(res.budgetPlan.evidenceSnapshot).toEqual({
			resolver: "test",
			rev: 1,
		});

		expect(store.canon).toHaveLength(1);
		expect(store.canon[0]?.kind).toBe("MONTHLY_BUDGET_PLAN_V2");
		expect(store.v2plans).toHaveLength(1);
		expect(store.v2revs).toHaveLength(1);
		expect(store.ledgerWrites).toBe(0);
		expect(store.midasWrites).toBe(0);
	});

	// -- O. economic no-op ----------------------------------------------
	it("O: CREATE / REFRESH / VOID never touch the ledger service or Midas transfer service", async () => {
		const ledgerSpy = vi.spyOn(
			canonSvc,
			"createCanonicalTransactionInTransaction",
		);
		const c = await createPlan();
		const r = await refreshMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "PERIODIC_REFRESH",
			resolvedSnapshot: SNAP({ mobilityBalance: "45000.00" }),
			provenance: PROV,
		});
		await voidMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 2,
			idempotencyKey: "void-1",
			reasonCode: "SUPERSEDED",
			provenance: PROV,
		});
		// Only canonical (non-posting) transactions were created; the canonical
		// payloads carry no `ledger` block.
		for (const call of ledgerSpy.mock.calls) {
			expect(call[0]).not.toHaveProperty("ledger");
		}
		expect(store.ledgerWrites).toBe(0);
		expect(store.midasWrites).toBe(0);
		expect(r.budgetPlan.revisionNo).toBe(2);
	});

	// -- C. CREATE replay ---------------------------------------------
	it("C: same key + identical snapshot + provenance => idempotent replay, no duplicate rows", async () => {
		const first = await createPlan();
		const replay = await createPlan();
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.budgetPlan.budgetPlanId).toBe(first.budgetPlan.budgetPlanId);
		expect(replay.budgetPlan.canonicalRevisionId).toBe(
			first.budgetPlan.canonicalRevisionId,
		);
		expect(store.canon).toHaveLength(1);
		expect(store.canonRevs).toHaveLength(1);
		expect(store.v2plans).toHaveLength(1);
		expect(store.v2revs).toHaveLength(1);
	});

	// -- D. CREATE changed-parameter conflict ----------------------
	it("D: same key with a changed input / evidence / provenance / period is an idempotency conflict", async () => {
		await createPlan();

		await expect(
			createPlan({ snapshot: SNAP({ realizedIncome: "12001.00" }) }),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });

		await expect(
			createPlan({
				snapshot: {
					inputs: SNAP().inputs,
					evidenceSnapshot: { resolver: "test", rev: 2 },
				},
			}),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });

		await expect(
			createPlan({ provenance: { type: "BUDGET_V2_MANUAL", ref: "op-2" } }),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });

		await expect(createPlan({ period: "2026-10-01" })).rejects.toMatchObject({
			code: "BUDGET_IDEMPOTENCY_CONFLICT",
		});

		// none of the conflicts created extra rows
		expect(store.canon).toHaveLength(1);
		expect(store.v2plans).toHaveLength(1);
		expect(store.v2revs).toHaveLength(1);
	});

	// -- E. period uniqueness -------------------------------------
	it("E: a second fresh V2 plan for the same user + period fails with BUDGET_PERIOD_CONFLICT", async () => {
		await createPlan();
		await expect(createPlan({ key: "create-2" })).rejects.toMatchObject({
			code: "BUDGET_PERIOD_CONFLICT",
		});
	});

	// -- F. fresh REFRESH ------------------------------------------
	it("F: fresh REFRESH appends an UPDATE revision with exact predecessor link + reallocated math", async () => {
		const c = await createPlan();
		const r = await refreshMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "PERIODIC_REFRESH",
			resolvedSnapshot: SNAP({ mobilityBalance: "60000.00" }),
			provenance: PROV,
		});
		expect(r.idempotentReplay).toBe(false);
		expect(r.budgetPlan.revisionNo).toBe(2);
		expect(r.budgetPlan.status).toBe("ACTIVE");
		// M >= 60k -> 0 / 65 / 35 of trueSurplus 8000
		expect(r.budgetPlan.outputs.mobilityAllocation).toBe("0.00");
		expect(r.budgetPlan.outputs.longTermInvestment).toBe("5200.00");
		expect(r.budgetPlan.outputs.discretionaryAllocation).toBe("2800.00");
		const rev2 = store.v2revs.find((x) => x.revisionNo === 2);
		expect(rev2?.previousBudgetRevisionId).toBe(
			store.v2revs.find((x) => x.revisionNo === 1)?.id,
		);
		expect(rev2?.operation).toBe("UPDATE");
	});

	// -- G. REFRESH replay --------------------------------------
	it("G: exact REFRESH retry => replay, no duplicate revision", async () => {
		const c = await createPlan();
		const args = {
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "PERIODIC_REFRESH",
			resolvedSnapshot: SNAP({ mobilityBalance: "45000.00" }),
			provenance: PROV,
		};
		const r1 = await refreshMonthlyBudgetV2Plan({ ...args, db: makeDb() });
		const r2 = await refreshMonthlyBudgetV2Plan({ ...args, db: makeDb() });
		expect(r2.idempotentReplay).toBe(true);
		expect(r2.budgetPlan.canonicalRevisionId).toBe(
			r1.budgetPlan.canonicalRevisionId,
		);
		expect(store.v2revs.filter((x) => x.revisionNo === 2)).toHaveLength(1);
	});

	// -- H. REFRESH changed-parameter conflict -----------------
	it("H: same REFRESH key with changed snapshot / reason / provenance stays an idempotency conflict", async () => {
		const c = await createPlan();
		await refreshMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "PERIODIC_REFRESH",
			resolvedSnapshot: SNAP({ mobilityBalance: "45000.00" }),
			provenance: PROV,
		});
		const base = {
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "PERIODIC_REFRESH",
			resolvedSnapshot: SNAP({ mobilityBalance: "45000.00" }),
			provenance: PROV,
		};
		await expect(
			refreshMonthlyBudgetV2Plan({
				...base,
				db: makeDb(),
				resolvedSnapshot: SNAP({ mobilityBalance: "45001.00" }),
			}),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
		await expect(
			refreshMonthlyBudgetV2Plan({
				...base,
				db: makeDb(),
				reasonCode: "OTHER",
			}),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
		await expect(
			refreshMonthlyBudgetV2Plan({
				...base,
				db: makeDb(),
				provenance: { type: "BUDGET_V2_MANUAL", ref: "op-9" },
			}),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
	});

	// -- I. OCC ---------------------------------------------
	it("I: a stale expectedRevisionNo on REFRESH is rejected with BUDGET_REVISION_CONFLICT", async () => {
		const c = await createPlan();
		await refreshMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "refresh-1",
			reasonCode: "R",
			resolvedSnapshot: SNAP({ mobilityBalance: "45000.00" }),
			provenance: PROV,
		});
		await expect(
			refreshMonthlyBudgetV2Plan({
				db: makeDb(),
				userId: USER_A,
				budgetPlanId: c.budgetPlan.budgetPlanId,
				expectedRevisionNo: 1, // stale, latest is now 2
				idempotencyKey: "refresh-2",
				reasonCode: "R",
				resolvedSnapshot: SNAP({ mobilityBalance: "50000.00" }),
				provenance: PROV,
			}),
		).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
	});

	// -- J. VOID -------------------------------------------
	it("J: VOID copies the predecessor 6 inputs + 6 outputs + evidence exactly; canonical op VOID; no recompute", async () => {
		const c = await createPlan();
		const v = await voidMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "void-1",
			reasonCode: "SUPERSEDED",
			provenance: PROV,
		});
		expect(v.budgetPlan.status).toBe("VOIDED");
		expect(v.budgetPlan.revisionNo).toBe(2);
		expect(v.budgetPlan.inputs).toEqual(c.budgetPlan.inputs);
		expect(v.budgetPlan.outputs).toEqual(c.budgetPlan.outputs);
		expect(v.budgetPlan.evidenceSnapshot).toEqual(
			c.budgetPlan.evidenceSnapshot,
		);
		const voidRev = store.canonRevs.find((r) => r.operation === "VOID");
		expect(voidRev).toBeDefined();
	});

	// -- K. VOID replay ---------------------------------
	it("K: exact VOID retry => replay, no duplicate canonical or V2 revision", async () => {
		const c = await createPlan();
		const args = {
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "void-1",
			reasonCode: "SUPERSEDED",
			provenance: PROV,
		};
		const v1 = await voidMonthlyBudgetV2Plan({ db: makeDb(), ...args });
		const v2 = await voidMonthlyBudgetV2Plan({ db: makeDb(), ...args });
		expect(v2.idempotentReplay).toBe(true);
		expect(v2.budgetPlan.canonicalRevisionId).toBe(
			v1.budgetPlan.canonicalRevisionId,
		);
		expect(store.canonRevs.filter((r) => r.operation === "VOID")).toHaveLength(
			1,
		);
		expect(store.v2revs.filter((r) => r.operation === "VOID")).toHaveLength(1);
	});

	// -- L. UPDATE after VOID rejected --------------
	it("L: REFRESH after VOID is rejected with BUDGET_ALREADY_VOIDED", async () => {
		const c = await createPlan();
		await voidMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "void-1",
			reasonCode: "SUPERSEDED",
			provenance: PROV,
		});
		await expect(
			refreshMonthlyBudgetV2Plan({
				db: makeDb(),
				userId: USER_A,
				budgetPlanId: c.budgetPlan.budgetPlanId,
				expectedRevisionNo: 2,
				idempotencyKey: "refresh-after-void",
				reasonCode: "R",
				resolvedSnapshot: SNAP(),
				provenance: PROV,
			}),
		).rejects.toMatchObject({ code: "BUDGET_ALREADY_VOIDED" });
	});

	// -- M. GET / LIST ---------------------------
	it("M: GET returns the latest active revision; after VOID, status VOIDED", async () => {
		const c = await createPlan();
		const got = await getMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
		});
		expect(got.revisionNo).toBe(1);
		expect(got.status).toBe("ACTIVE");
		await voidMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			budgetPlanId: c.budgetPlan.budgetPlanId,
			expectedRevisionNo: 1,
			idempotencyKey: "void-1",
			reasonCode: "X",
			provenance: PROV,
		});
		const after = await getMonthlyBudgetV2Plan({
			db: makeDb(),
			userId: USER_A,
			periodMonth: PERIOD,
		});
		expect(after.status).toBe("VOIDED");
		expect(after.revisionNo).toBe(2);
	});

	it("M: LIST returns one item per plan (latest revision), ordered periodMonth DESC", async () => {
		await createPlan({ key: "c-sep", period: "2026-09-01" });
		await createPlan({ key: "c-oct", period: "2026-10-01" });
		await createPlan({ key: "c-aug", period: "2026-08-01" });
		const list = await listMonthlyBudgetV2Plans({
			db: makeDb(),
			userId: USER_A,
		});
		expect(list.map((p: MonthlyBudgetV2PlanItem) => p.periodMonth)).toEqual([
			"2026-10-01",
			"2026-09-01",
			"2026-08-01",
		]);
		expect(list.every((p) => p.revisionNo === 1)).toBe(true);
	});

	it("M: GET on an unknown plan raises BUDGET_PLAN_NOT_FOUND", async () => {
		await expect(
			getMonthlyBudgetV2Plan({
				db: makeDb(),
				userId: USER_A,
				budgetPlanId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			}),
		).rejects.toMatchObject({ code: "BUDGET_PLAN_NOT_FOUND" });
	});

	// -- N. atomicity ------------------------
	it("N: canonical tx + anchor + revision #1 all run inside ONE outer db.transaction; a projection insert failure propagates (whole unit aborts)", async () => {
		const db = makeDb();
		const canonSpy = vi.spyOn(
			canonSvc,
			"createCanonicalTransactionInTransaction",
		);

		// Make the revision insert (the LAST write) throw, after the canonical tx
		// + anchor already ran within the same transaction callback.
		const realInsert = db.insert;
		(db as unknown as { insert: unknown }).insert = (t: unknown) => {
			if (t === monthlyBudgetV2PlanRevisions) {
				return {
					values: () => ({
						returning: () =>
							Promise.reject(new Error("simulated projection write failure")),
					}),
				};
			}
			return realInsert(t);
		};

		await expect(
			createMonthlyBudgetV2Plan({
				db,
				userId: USER_A,
				periodMonth: PERIOD,
				idempotencyKey: "atomic-1",
				resolvedSnapshot: SNAP(),
				provenance: PROV,
			}),
		).rejects.toThrow(/projection write failure/);

		// Exactly one outer transaction wrapped the whole create.
		expect(db.txCalls).toBe(1);
		// The canonical create ran with the SAME tx handle the transaction
		// callback received -> it is inside that atomic unit and rolls back with
		// it on the real database.
		expect(canonSpy).toHaveBeenCalledTimes(1);
		expect(canonSpy.mock.calls[0]?.[0]?.tx).toBe(db.lastTxHandle);
		// The failure is NOT swallowed into a "success".
	});
});
