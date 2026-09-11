import { drizzle } from "drizzle-orm/neon-serverless";

export type Database = ReturnType<typeof drizzle>;
export type DatabaseTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];
export type DatabaseOrTransaction = Database | DatabaseTransaction;

let databaseFactoryOverride:
	| ((databaseUrl: string) => DatabaseOrTransaction)
	| null = null;

export function setDatabaseFactoryOverrideForTest(
	factory: ((databaseUrl: string) => DatabaseOrTransaction) | null,
) {
	databaseFactoryOverride = factory;
}

export function createDatabase(databaseUrl: string): Database {
	if (databaseFactoryOverride) {
		return databaseFactoryOverride(databaseUrl) as Database;
	}

	if (!databaseUrl || databaseUrl.trim() === "") {
		throw new Error("DATABASE_URL is required");
	}

	return drizzle({
		connection: databaseUrl,
	});
}
