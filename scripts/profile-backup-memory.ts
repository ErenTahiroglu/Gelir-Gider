/**
 * Reproducible Node profiling harness for the GG_BACKUP_V1 export / encrypt /
 * upload / read-back / verify pipeline.
 *
 * Run (Node 24+, native TypeScript):
 *
 *     node --expose-gc scripts/profile-backup-memory.ts
 *
 * `--expose-gc` is optional; when present the harness forces a collection at
 * every stage boundary so the reported `heapUsed` delta is less noisy. It is
 * still only a DIAGNOSTIC Node measurement -- it is NOT an authoritative
 * Cloudflare Workers isolate peak-memory figure (workerd is not Node, and the
 * `@cloudflare/vitest-plugin` pool this repo runs its suite under reports
 * `process.memoryUsage()` as all-zero, so an authoritative isolate peak
 * cannot be captured in this environment at all).
 *
 * Deterministic BYTE amplification (independent of runtime) is asserted as
 * permanent regression coverage in `tests/backups-memory-amplification.test.ts`.
 * This script layers Node heap/rss diagnostics on top of the exact same
 * pipeline via the shared `tests/helpers/backup-memory-profile.ts` module.
 */

import {
	MIB,
	runAmplificationPipeline,
} from "../tests/helpers/backup-memory-profile.ts";

interface MemSample {
	label: string;
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	arrayBuffers: number;
}

const maybeGc = (globalThis as { gc?: () => void }).gc;

function sampleMemory(label: string): MemSample {
	if (maybeGc) {
		maybeGc();
	}
	const m = process.memoryUsage();
	return {
		label,
		rss: m.rss,
		heapTotal: m.heapTotal,
		heapUsed: m.heapUsed,
		external: m.external,
		arrayBuffers: m.arrayBuffers,
	};
}

function mib(bytes: number): string {
	return (bytes / MIB).toFixed(2).padStart(8);
}

const TARGET_MIB = [1, 5, 10, 15, 20, 25];
const OVER_LIMIT_MIB = 30;

async function main(): Promise<void> {
	const targets = [...TARGET_MIB, OVER_LIMIT_MIB].map((n) => n * MIB);

	console.log(
		`Node ${process.version} | --expose-gc: ${maybeGc ? "yes" : "no"}\n`,
	);
	console.log(
		"NOTE: heap/rss below are DIAGNOSTIC Node figures, not Cloudflare isolate peak memory.\n",
	);

	const summary: Array<{
		target: string;
		rows: number;
		plaintext: string;
		envelope: string;
		envAmp: string;
		transientSum: string;
		transientAmp: string;
		heapUsedPeak: string;
		rssPeak: string;
	}> = [];

	for (const target of targets) {
		const samples: MemSample[] = [];
		samples.push(sampleMemory("before"));
		const result = await runAmplificationPipeline(target, (label) => {
			samples.push(sampleMemory(label));
		});
		samples.push(sampleMemory("after"));

		const heapUsedPeak = Math.max(...samples.map((s) => s.heapUsed));
		const rssPeak = Math.max(...samples.map((s) => s.rss));

		const isOver = target > 25 * MIB;
		console.log(
			`=== target ${(target / MIB).toFixed(0)} MiB${
				isOver ? " (OVER 25 MiB ceiling)" : ""
			} | ${result.rowCount} rows ===`,
		);
		console.log(
			"  stage                                                              bytes(MiB)   heapUsed   rss",
		);
		for (const stage of result.stages) {
			const s = samples.find((x) => x.label === stage.label);
			console.log(
				`  ${String(stage.stage)}. ${stage.label.padEnd(58)} ${mib(
					stage.bytes,
				)}   ${mib(s?.heapUsed ?? 0)}   ${mib(s?.rss ?? 0)}`,
			);
		}
		console.log(
			`  -> plaintext ${mib(result.plaintextBytes)} MiB | envelope ${mib(
				result.envelopeBytes,
			)} MiB (x${result.envelopeAmplification.toFixed(3)})`,
		);
		console.log(
			`  -> cumulative transient ${mib(
				result.cumulativeTransientBytes,
			)} MiB (x${result.cumulativeAmplification.toFixed(2)} of plaintext)`,
		);
		console.log(
			`  -> Node heapUsed peak ${mib(heapUsedPeak)} MiB | rss peak ${mib(
				rssPeak,
			)} MiB\n`,
		);

		summary.push({
			target: `${(target / MIB).toFixed(0)} MiB`,
			rows: result.rowCount,
			plaintext: mib(result.plaintextBytes).trim(),
			envelope: mib(result.envelopeBytes).trim(),
			envAmp: `x${result.envelopeAmplification.toFixed(3)}`,
			transientSum: mib(result.cumulativeTransientBytes).trim(),
			transientAmp: `x${result.cumulativeAmplification.toFixed(2)}`,
			heapUsedPeak: mib(heapUsedPeak).trim(),
			rssPeak: mib(rssPeak).trim(),
		});
	}

	console.log("=== SUMMARY (all sizes in MiB) ===");
	console.table(summary);
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
