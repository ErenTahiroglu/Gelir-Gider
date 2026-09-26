import { ApiError, type ApiErrorPayload } from "./errors";

type SessionLossListener = () => void;
const sessionLossListeners = new Set<SessionLossListener>();

export function onSessionLost(listener: SessionLossListener): () => void {
	sessionLossListeners.add(listener);
	return () => {
		sessionLossListeners.delete(listener);
	};
}

function notifySessionLost(): void {
	for (const listener of sessionLossListeners) {
		try {
			listener();
		} catch (err) {
			console.error("Error in session lost listener:", err);
		}
	}
}

export interface RequestOptions extends Omit<RequestInit, "credentials"> {
	json?: unknown;
}

export async function apiFetch<T>(
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	const { json, headers: customHeaders, ...restOptions } = options;

	const headers = new Headers(customHeaders);

	// CRITICAL RULE (Section 21): NEVER manually set "Origin" header from client code!
	// In-browser same-origin requests supply the correct Origin automatically.
	if (headers.has("Origin") || headers.has("origin")) {
		headers.delete("Origin");
		headers.delete("origin");
	}

	let body: BodyInit | undefined;

	// Content-Type rule (Section 22): ONLY send application/json when a JSON body exists.
	if (json !== undefined) {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(json);
	} else if (restOptions.body !== undefined && restOptions.body !== null) {
		body = restOptions.body;
	}

	const fetchInit: RequestInit = {
		...restOptions,
		headers,
		credentials: "same-origin",
	};

	if (body !== undefined) {
		fetchInit.body = body;
	}

	let response: Response;
	try {
		response = await fetch(path, fetchInit);
	} catch (networkErr) {
		throw new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message:
				networkErr instanceof Error
					? networkErr.message
					: "Network request failed",
		});
	}

	const requestId = response.headers.get("x-request-id");
	const retryAfterHeader = response.headers.get("retry-after");
	const retryAfter = retryAfterHeader
		? Number.parseInt(retryAfterHeader, 10)
		: null;

	if (!response.ok) {
		let errorCode = "INTERNAL_ERROR";
		let errorMessage = "An error occurred";

		try {
			const errorData = (await response.json()) as ApiErrorPayload;
			if (errorData?.error?.code) {
				errorCode = errorData.error.code;
			}
			if (errorData?.error?.message) {
				errorMessage = errorData.error.message;
			}
		} catch {
			errorMessage = response.statusText || `HTTP ${response.status}`;
		}

		if (response.status === 401) {
			notifySessionLost();
		}

		throw new ApiError({
			status: response.status,
			code: errorCode,
			message: errorMessage,
			requestId,
			retryAfter: Number.isNaN(retryAfter) ? null : retryAfter,
		});
	}

	// 204 No Content
	if (response.status === 204) {
		return null as T;
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new ApiError({
			status: response.status,
			code: "UNPARSEABLE_RESPONSE",
			message: "Response could not be parsed as JSON",
			requestId,
		});
	}
}
