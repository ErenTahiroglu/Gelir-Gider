import { ApiError } from "../api/errors";
import type {
	MidasLiquidityProductDto,
	MidasLiquidityResponse,
} from "../api/f7-types";

export type MidasLiquidityClassification =
	| { status: "LOADING" }
	| { status: "CONFIGURED"; liquidity: MidasLiquidityProductDto }
	| { status: "NOT_CONFIGURED" }
	| { status: "ERROR"; error: unknown; message: string };

/**
 * Authoritative classification of Midas liquidity state.
 *
 * Rules:
 * - isLoading: LOADING
 * - 404 + error.code === "MIDAS_ACCOUNT_NOT_FOUND": NOT_CONFIGURED
 * - Other error (network, 500, other 404, etc.): ERROR
 * - Missing or malformed liquidity DTO: ERROR (fail-closed, never treated as NOT_CONFIGURED)
 * - Valid liquidity data: CONFIGURED
 */
export function classifyMidasLiquidityState(
	isLoading: boolean,
	data: MidasLiquidityResponse | undefined,
	error: unknown,
): MidasLiquidityClassification {
	if (isLoading) {
		return { status: "LOADING" };
	}

	if (error) {
		if (error instanceof ApiError && error.code === "MIDAS_ACCOUNT_NOT_FOUND") {
			return { status: "NOT_CONFIGURED" };
		}
		const message =
			error instanceof ApiError
				? error.userMessage ||
					error.message ||
					"Midas likidite durumu doğrulanamadı."
				: error instanceof Error
					? error.message
					: "Midas likidite durumu doğrulanamadı.";
		return { status: "ERROR", error, message };
	}

	if (!data?.liquidity || typeof data.liquidity.midasAccountId !== "string") {
		return {
			status: "ERROR",
			error: new Error("Likidite verisi eksik veya geçersiz"),
			message: "Likidite durumu doğrulanamadı.",
		};
	}

	return { status: "CONFIGURED", liquidity: data.liquidity };
}
