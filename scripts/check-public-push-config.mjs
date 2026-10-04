import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "frontend", ".env.production");

function fail(reason) {
  console.error(`Public push configuration: FAIL (${reason})`);
  process.exit(1);
}

if (!fs.existsSync(configPath)) fail("production config missing");

const contents = fs.readFileSync(configPath, "utf8");
const match = /^VITE_WEB_PUSH_VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)\r?\n?$/.exec(contents);
if (!match) fail("expected exactly one public VAPID assignment");

const key = match[1];
if (key.length % 4 === 1) fail("invalid base64url length");

const decoded = Buffer.from(key, "base64url");
if (decoded.toString("base64url") !== key) fail("invalid unpadded base64url");
if (decoded.length !== 65 || decoded[0] !== 0x04) {
  fail("expected a 65-byte uncompressed P-256 public point");
}

// Vite gives shell variables precedence over .env.production. Refuse an accidental
// override so a routine build cannot silently deploy another public key.
if (
  process.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY !== undefined &&
  process.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY !== key
) {
  fail("shell public VAPID override differs from committed production config");
}

console.log("Public push configuration: PASS (65-byte uncompressed P-256 public point)");
