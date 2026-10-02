import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const manifestPath = path.join(distDir, ".vite", "manifest.json");

if (!fs.existsSync(manifestPath)) {
	console.error(`ERROR: Manifest not found at ${manifestPath}. Run 'npm run build' first.`);
	process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const indexEntry = manifest["index.html"];

if (!indexEntry || !indexEntry.file) {
	console.error("ERROR: 'index.html' entry not found in Vite manifest.");
	process.exit(1);
}

// Traverse static imports recursively to determine the initial static JS dependency graph.
// Dynamic imports (lazy routes) are explicitly excluded as per Section 14.
const initialJsFiles = new Set();
const visitedEntries = new Set();

function collectStaticImports(entryKey) {
	if (visitedEntries.has(entryKey)) return;
	visitedEntries.add(entryKey);

	const entry = manifest[entryKey];
	if (!entry) return;

	if (entry.file && entry.file.endsWith(".js")) {
		initialJsFiles.add(entry.file);
	}

	if (Array.isArray(entry.imports)) {
		for (const importKey of entry.imports) {
			collectStaticImports(importKey);
		}
	}
}

collectStaticImports("index.html");

const BUDGET_GZIP_BYTES = 120 * 1024; // 122,880 bytes (120 KiB)

let totalRawBytes = 0;
let totalGzipBytes = 0;

const fileDetails = [];

for (const relativeFile of initialJsFiles) {
	const absolutePath = path.join(distDir, relativeFile);
	if (!fs.existsSync(absolutePath)) {
		console.error(`ERROR: Static chunk not found at ${absolutePath}`);
		process.exit(1);
	}
	const content = fs.readFileSync(absolutePath);
	const rawBytes = content.length;
	const gzipBytes = zlib.gzipSync(content).length;

	totalRawBytes += rawBytes;
	totalGzipBytes += gzipBytes;

	fileDetails.push({
		file: relativeFile,
		rawBytes,
		gzipBytes,
	});
}

const isPass = totalGzipBytes < BUDGET_GZIP_BYTES;

console.log("=================================================");
console.log("   GELİR-GİDER FRONTEND BUNDLE BUDGET GATE (F10) ");
console.log("=================================================");
console.log("Initial JS files:");
for (const detail of fileDetails) {
	console.log(`  - ${detail.file} (${detail.rawBytes} bytes raw, ${detail.gzipBytes} bytes gzip)`);
}
console.log("-------------------------------------------------");
console.log(`Raw bytes:   ${totalRawBytes} bytes (${(totalRawBytes / 1024).toFixed(2)} kB)`);
console.log(`Gzip bytes:  ${totalGzipBytes} bytes (${(totalGzipBytes / 1024).toFixed(2)} kB)`);
console.log(`Budget:      ${BUDGET_GZIP_BYTES} bytes (120.00 KiB)`);
console.log(`PASS / FAIL: ${isPass ? "PASS" : "FAIL"}`);
console.log("=================================================");

if (!isPass) {
	console.error(`ERROR: Initial JS bundle exceeded budget by ${totalGzipBytes - BUDGET_GZIP_BYTES} gzip bytes.`);
	process.exit(1);
}

process.exit(0);
