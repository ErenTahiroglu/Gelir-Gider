import { drizzle } from "drizzle-orm/neon-serverless";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseUrl: string) {
	if (!databaseUrl || databaseUrl.trim() === "") {
		throw new Error("DATABASE_URL is required");
	}

	return drizzle({
		connection: databaseUrl,
	});
}
