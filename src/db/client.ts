import { drizzle } from "drizzle-orm/neon-serverless";

export type Database = ReturnType<typeof createDatabase>;
export type DatabaseTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];
export type DatabaseOrTransaction = Database | DatabaseTransaction;

export function createDatabase(databaseUrl: string) {
	if (!databaseUrl || databaseUrl.trim() === "") {
		throw new Error("DATABASE_URL is required");
	}

	return drizzle({
		connection: databaseUrl,
	});
}
