import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../frontend/public");
const iconsDir = path.resolve(publicDir, "icons");

if (!fs.existsSync(iconsDir)) {
	fs.mkdirSync(iconsDir, { recursive: true });
}

// SVG template for standard GG brand icon
function createSvg(size, isMaskable = false) {
	// For maskable, safe zone is inner 80% (padding = size * 0.1)
	const padding = isMaskable ? size * 0.15 : size * 0.05;
	const innerSize = size - padding * 2;
	const rx = isMaskable ? 0 : size * 0.22; // rounded square for standard, full bleed for maskable
	const fontSize = Math.round(innerSize * 0.44);
	const textY = Math.round(size / 2 + fontSize * 0.35);

	if (isMaskable) {
		return `
		<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
			<rect width="${size}" height="${size}" fill="#4f46e5" />
			<defs>
				<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="#6366f1" />
					<stop offset="100%" stop-color="#4338ca" />
				</linearGradient>
			</defs>
			<circle cx="${size / 2}" cy="${size / 2}" r="${innerSize * 0.48}" fill="url(#grad)" />
			<text x="${size / 2}" y="${textY}" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-0.04em">GG</text>
		</svg>`;
	}

	return `
	<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
				<stop offset="0%" stop-color="#6366f1" />
				<stop offset="100%" stop-color="#4338ca" />
			</linearGradient>
			<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
				<feDropShadow dx="0" dy="${size * 0.03}" stdDeviation="${size * 0.04}" flood-color="#000000" flood-opacity="0.25" />
			</filter>
		</defs>
		<rect x="${padding}" y="${padding}" width="${innerSize}" height="${innerSize}" rx="${rx}" fill="url(#brandGrad)" filter="url(#shadow)" />
		<text x="${size / 2}" y="${textY}" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-0.04em">GG</text>
	</svg>`;
}

async function generate() {
	const svg512 = Buffer.from(createSvg(512, false));
	const svg512Maskable = Buffer.from(createSvg(512, true));
	const svg192 = Buffer.from(createSvg(192, false));
	const svg180 = Buffer.from(createSvg(180, false));
	const svg64 = Buffer.from(createSvg(64, false));
	const svg32 = Buffer.from(createSvg(32, false));

	// Save SVG
	fs.writeFileSync(path.join(iconsDir, "icon.svg"), svg512);
	fs.writeFileSync(path.join(publicDir, "favicon.svg"), svg64);

	// Generate PNGs
	await sharp(svg192).png().toFile(path.join(iconsDir, "icon-192x192.png"));
	console.log("Generated icon-192x192.png");

	await sharp(svg512).png().toFile(path.join(iconsDir, "icon-512x512.png"));
	console.log("Generated icon-512x512.png");

	await sharp(svg512Maskable)
		.png()
		.toFile(path.join(iconsDir, "icon-512x512-maskable.png"));
	console.log("Generated icon-512x512-maskable.png");

	await sharp(svg180).png().toFile(path.join(publicDir, "apple-touch-icon.png"));
	console.log("Generated apple-touch-icon.png");

	// Favicon PNG (32x32) & ICO (sharp can output png, for ico we can write a standard ico format or 32x32 png as favicon)
	// A valid .ico file containing 32x32 PNG:
	const png32 = await sharp(svg32).png().toBuffer();
	const icoHeader = Buffer.from([
		0,
		0, // reserved
		1,
		0, // type 1 = icon
		1,
		0, // count = 1
		32, // width
		32, // height
		0, // color count
		0, // reserved
		1,
		0, // color planes
		32,
		0, // bits per pixel
		png32.length & 0xff,
		(png32.length >> 8) & 0xff,
		(png32.length >> 16) & 0xff,
		(png32.length >> 24) & 0xff, // byte length
		22,
		0,
		0,
		0, // offset of image data (6 header + 16 dir entry = 22)
	]);
	const icoBuffer = Buffer.concat([icoHeader, png32]);
	fs.writeFileSync(path.join(publicDir, "favicon.ico"), icoBuffer);
	console.log("Generated favicon.ico");
}

generate().catch((err) => {
	console.error(err);
	process.exit(1);
});
