/**
 * TanStack Query Client Foundation
 *
 * Adheres strictly to Section 6 & 7:
 *   - Singleton QueryClient instance
 *   - Conservative bounded retries: deterministic 4xx never retried; max 1 retry for transient network/5xx
 *   - Stale time set conservatively
 *   - No financial arithmetic inside query infrastructure
 */

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/errors";

export function createApplicationQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000, // 30s
				gcTime: 5 * 60_000, // 5 min
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Never retry deterministic 4xx errors
					if (
						error instanceof ApiError &&
						error.status >= 400 &&
						error.status < 500
					) {
						return false;
					}
					// Retry transient errors at most once
					return failureCount < 1;
				},
			},
		},
	});
}

export const queryClient = createApplicationQueryClient();
