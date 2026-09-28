/**
 * Query Security Boundary
 *
 * Adheres strictly to Section 7:
 *   - Only actively fetches financial queries while auth state === "UNLOCKED".
 *   - On PRIVACY_HIDDEN, REAUTH_REQUIRED, REAUTHENTICATING:
 *       cancels active financial queries; preserves in-memory cache for same-session reauth.
 *   - On AUTH_REQUIRED, LOGOUT_FAILED_LOCKED, FATAL_AUTH_STATE, BOOTSTRAP_REQUIRED:
 *       clears sensitive financial query cache completely.
 *   - Never persists financial cache to localStorage, IndexedDB, or service workers.
 */

import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useRef } from "react";
import { useAuth } from "../auth/auth-context";
import type { AuthState } from "../auth/auth-types";

export function QuerySecurityBoundary({
	children,
}: {
	children: React.ReactNode;
}) {
	const { state } = useAuth();
	const queryClient = useQueryClient();
	const prevStateRef = useRef<AuthState["status"]>(state.status);

	useEffect(() => {
		const current = state.status;
		prevStateRef.current = current;

		// 1. Session-ending / unauthenticated states: CLEAR query cache
		if (
			current === "AUTH_REQUIRED" ||
			current === "LOGOUT_FAILED_LOCKED" ||
			current === "FATAL_AUTH_STATE" ||
			current === "BOOTSTRAP_REQUIRED"
		) {
			queryClient.clear();
			return;
		}

		// 2. Privacy / lock states: cancel active queries, preserve cache for same-session reauth
		if (
			current === "PRIVACY_HIDDEN" ||
			current === "REAUTH_REQUIRED" ||
			current === "REAUTHENTICATING"
		) {
			void queryClient.cancelQueries();
		}
	}, [state.status, queryClient]);

	return <>{children}</>;
}
