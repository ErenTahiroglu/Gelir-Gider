export interface AppEnv {
	DATABASE_URL?: string | undefined;
}

export function getDatabaseUrl(env: AppEnv): string {
	const rawUrl = env.DATABASE_URL;
	if (!rawUrl || rawUrl.trim() === "") {
		throw new Error("DATABASE_URL is required");
	}

	return rawUrl.trim();
}
