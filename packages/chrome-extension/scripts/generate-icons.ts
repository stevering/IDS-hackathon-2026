/**
 * Generates PNG icons from the root SVG asset using sharp.
 * Run once before building: pnpm generate-icons
 * Called automatically by `prebuild` and `predev` hooks.
 */
import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SVG_SOURCE = join(__dirname, "../../../assets/Shield_v2.svg");
const OUT_DIR = join(__dirname, "../public/icons");

mkdirSync(OUT_DIR, { recursive: true });

const svg = readFileSync(SVG_SOURCE);

const sizes = [16, 48, 128] as const;

async function main(): Promise<void> {
  for (const size of sizes) {
    const outPath = join(OUT_DIR, `icon${size}.png`);
    await sharp(svg).resize(size, size).png().toFile(outPath);
    console.log(`  ✓ icons/icon${size}.png`);
  }
  console.log("Icons generated.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
