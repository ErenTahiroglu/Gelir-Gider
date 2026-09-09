export const OPERATIONAL_EVENT_CODES = [
	"HTTP_REQUEST_COMPLETED",
	"HTTP_REQUEST_FAILED",
	"SCHEDULED_NOTIFICATION_COMPLETED",
	"SCHEDULED_NOTIFICATION_FAILED",
	"BACKUP_STARTED",
	"BACKUP_COMPLETED",
	"BACKUP_IN_PROGRESS",
	"BACKUP_FAILED",
	"BACKUP_RETENTION_FAILED",
	"READINESS_FAILED",
	"BUDGET_CHECKPOINT_PROCESSOR_COMPLETED",
	"BUDGET_CHECKPOINT_PROCESSOR_FAILED",
] as const;

export type OperationalEventCode = (typeof OPERATIONAL_EVENT_CODES)[number];

export type OperationalEventLevel = "info" | "warn" | "error";

/**
 * A NARROW, closed shape for everything this system is ever allowed to log.
 * The real safety mechanism here is the TypeScript type itself: every
 * in-repo call site is statically restricted to exactly these fields, so a
 * raw exception object, a request body, a query string, cookies, or an
 * Authorization header can never be passed in without an explicit `as any`
 * bypass. `counts` is deliberately restricted to a flat `Record<string,
 * number>` of small named counters -- never arbitrary nested data.
 */
export interface OperationalEvent {
	timestamp?: string;
	level: OperationalEventLevel;
	eventCode: OperationalEventCode;
	component: string;
	requestId?: string | null;
	durationMs?: number | null;
	counts?: Record<string, number> | null;
	statusCode?: string | number | null;
	safeCode?: string | null;
}

const ALLOWED_KEYS = new Set<string>([
	"timestamp",
	"level",
	"eventCode",
	"component",
	"requestId",
	"durationMs",
	"counts",
	"statusCode",
	"safeCode",
]);

/**
 * Logs one structured operational event as a single JSON line. `console.log`
 * for `info`/`warn`, `console.error` for `error`.
 *
 * On extra-key leakage: we deliberately do NOT throw or silently strip
 * unexpected keys at runtime. The narrow `OperationalEvent` type already
 * makes it a compile-time error for any in-repo caller to pass anything
 * beyond this shape; the only way an extra key reaches here is a deliberate
 * `as any`/`as unknown` bypass, which is a code-review problem, not
 * something a logging call should paper over by throwing (a logger that can
 * crash request handling is worse than a logger that occasionally logs one
 * unexpected debug field). Instead we defensively drop unknown keys before
 * serializing, so even a bypassed call can never leak an arbitrary object
 * (e.g. a raw Error, a request body) verbatim into the log stream.
 */
export function logOperationalEvent(event: OperationalEvent): void {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(
		event as unknown as Record<string, unknown>,
	)) {
		if (ALLOWED_KEYS.has(key)) {
			sanitized[key] = value;
		}
	}
	if (typeof sanitized.timestamp !== "string") {
		sanitized.timestamp = new Date().toISOString();
	}

	const line = JSON.stringify(sanitized);
	if (event.level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}
