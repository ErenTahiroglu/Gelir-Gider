/**
 * SPA ROUTER & DOCUMENT NAVIGATION BOUNDARY
 *
 * Distinguishes browser/PWA top-level document navigations from programmatic API fetches
 * for paths shared between TanStack Router SPA routes and backend API endpoints.
 *
 * In Cloudflare Workers with Static Assets, routes configured in `run_worker_first`
 * enter the Worker before static asset matching. When the incoming request is a
 * safe document navigation (GET/HEAD with Sec-Fetch-Mode: navigate or HTML accept)
 * to a known SPA route, the Worker delegates to `env.ASSETS.fetch(request)` so that
 * Cloudflare Static Assets (with SPA fallback) serves `index.html`.
 *
 * For API requests, mutations (POST/PUT/PATCH/DELETE), or unknown paths, requests
 * continue through to Hono backend routers and security/domain handlers.
 */

/**
 * Exact static frontend routes declared in `frontend/src/App.tsx`.
 */
export const STATIC_SPA_ROUTES = new Set([
	"/",
	"/unlock",
	"/transactions",
	"/manual-expenses/new",
	"/settings/quick-templates",
	"/settings/devices",
	"/cards",
	"/cards/new",
	"/people",
	"/people/new",
	"/goals",
	"/goals/new",
	"/midas",
	"/long-term",
	"/long-term/new",
	"/income",
	"/income/sources/new",
	"/income/entitlements/new",
	"/income/receipts/new",
	"/month-close",
	"/month-close/wizard",
	"/imports",
	"/notifications",
]);

/**
 * Parameterized frontend routes declared in `frontend/src/App.tsx`.
 * Each pattern matches a single URL path segment per parameter (`[^/]+`).
 */
export const DYNAMIC_SPA_ROUTE_PATTERNS: readonly RegExp[] = [
	// Transactions: /transactions/$transactionId
	/^\/transactions\/[^/]+$/,
	// Manual expenses: /manual-expenses/$expenseId/edit
	/^\/manual-expenses\/[^/]+\/edit$/,
	// Cards: /cards/$cardId, /cards/$cardId/edit, statements, purchases, split
	/^\/cards\/[^/]+$/,
	/^\/cards\/[^/]+\/edit$/,
	/^\/cards\/[^/]+\/statements\/new$/,
	/^\/cards\/[^/]+\/statements\/[^/]+$/,
	/^\/cards\/[^/]+\/purchases\/new$/,
	/^\/cards\/[^/]+\/purchases\/[^/]+$/,
	/^\/cards\/[^/]+\/purchases\/[^/]+\/split$/,
	// People: /people/$personId, edit, obligations, settle
	/^\/people\/[^/]+$/,
	/^\/people\/[^/]+\/edit$/,
	/^\/people\/[^/]+\/obligations\/new$/,
	/^\/people\/[^/]+\/obligations\/[^/]+$/,
	/^\/people\/[^/]+\/settle$/,
	// Goals: /goals/$goalId, edit
	/^\/goals\/[^/]+$/,
	/^\/goals\/[^/]+\/edit$/,
	// Long term: /long-term/$taskId
	/^\/long-term\/[^/]+$/,
	// Income: /income/entitlements/$entitlementId, /income/receipts/$incomeReceiptId
	/^\/income\/entitlements\/[^/]+$/,
	/^\/income\/receipts\/[^/]+$/,
	// Month close: /month-close/$periodMonth
	/^\/month-close\/[^/]+$/,
	// Imports: /imports/$batchId, /imports/$batchId/review
	/^\/imports\/[^/]+$/,
	/^\/imports\/[^/]+\/review$/,
];

/**
 * Checks whether a URL pathname matches a known frontend SPA route.
 */
export function isSpaRoutePath(pathname: string): boolean {
	let normalized = pathname;
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	if (STATIC_SPA_ROUTES.has(normalized)) {
		return true;
	}

	for (const pattern of DYNAMIC_SPA_ROUTE_PATTERNS) {
		if (pattern.test(normalized)) {
			return true;
		}
	}

	return false;
}

/**
 * Checks whether an incoming HTTP request represents a browser/PWA document navigation.
 *
 * Rules:
 * 1. Method MUST be GET or HEAD. Any mutation (POST/PUT/PATCH/DELETE) is never a document navigation.
 * 2. If `Sec-Fetch-Mode` header is present:
 *    - "navigate" indicates a top-level document navigation (PWA launch, reload, URL entry, link click).
 *    - Any other value ("cors", "no-cors", "same-origin", "websocket") indicates a subresource/API fetch.
 * 3. Fallback when `Sec-Fetch-Mode` is absent (older clients / synthetic requests):
 *    - `Accept` header must contain "text/html" and must not prioritize "application/json" over HTML.
 */
export function isDocumentNavigationRequest(request: Request): boolean {
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return false;
	}

	const secFetchMode = request.headers.get("sec-fetch-mode")?.toLowerCase();
	if (
		secFetchMode !== undefined &&
		secFetchMode !== null &&
		secFetchMode !== ""
	) {
		return secFetchMode === "navigate";
	}

	const accept = request.headers.get("accept")?.toLowerCase() ?? "";
	if (!accept.includes("text/html")) {
		return false;
	}

	const jsonIndex = accept.indexOf("application/json");
	const htmlIndex = accept.indexOf("text/html");
	if (jsonIndex !== -1 && jsonIndex < htmlIndex) {
		return false;
	}

	return true;
}

/**
 * Authoritative check combining document navigation semantics and frontend route whitelist.
 */
export function isSpaDocumentNavigation(request: Request): boolean {
	if (!isDocumentNavigationRequest(request)) {
		return false;
	}

	try {
		const url = new URL(request.url);
		return isSpaRoutePath(url.pathname);
	} catch {
		return false;
	}
}
