import { startTestServer } from "./test-server";

async function main() {
	const instance = await startTestServer();

	const shutdown = async () => {
		console.log("[E2E Test Server] Shutting down...");
		await instance.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[E2E Test Server Startup Error]", err);
	process.exit(1);
});
