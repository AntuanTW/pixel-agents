/**
 * Converts DBZ GBA sprite sheets to Pixel Agents character format.
 *
 * The DBZ sheets are horizontal strips of ~32px-tall sprites.
 * This script extracts frames and maps them to the Pixel Agents format:
 * 112px wide × 96px tall, 7 frames × 16px, 3 direction rows × 32px.
 *
 * Run: npx tsx scripts/convert-dbz-sprites.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const DBZ_DIR = path.resolve('dbz_assets');
const OUT_DIR = path.resolve('scripts', 'dbz-output');

// Mapping: DBZ file → output character name
const SPRITE_MAP: Record<string, string> = {
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Playable Characters - Goku.png': 'dbz_goku',
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Playable Characters - Vegeta.png': 'dbz_vegeta',
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Playable Characters - Piccolo.png': 'dbz_piccolo',
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Playable Characters - Gohan (Battle Suit).png': 'dbz_gohan',
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Playable Characters - Future Trunks (Battle Suit).png': 'dbz_trunks',
  'Game Boy Advance - Dragon Ball Z_ The Legacy of Goku II - Non-Playable Characters - Krillin.png': 'dbz_krillin',
};

// Pixel Agents character layout
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 24; // 24px visible + 8px padding = 32px row
const CHAR_ROW_H = 32;
const CHAR_TOTAL_W = 112; // 7 frames × 16px
const CHAR_TOTAL_H = 96;  // 3 rows × 32px

interface ExtractedFrame {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Extract individual sprite frames from a horizontal GBA sprite strip.
 * Assumes each frame is spriteW × spriteH, arranged left-to-right.
 */
function extractFrames(png: PNG, spriteW: number, spriteH: number): ExtractedFrame[] {
  const frames: ExtractedFrame[] = [];
  const cols = Math.floor(png.width / spriteW);
  const rows = Math.floor(png.height / spriteH);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const frame = new PNG({ width: spriteW, height: spriteH });
      for (let y = 0; y < spriteH; y++) {
        for (let x = 0; x < spriteW; x++) {
          const srcIdx = ((row * spriteH + y) * png.width + (col * spriteW + x)) * 4;
          const dstIdx = (y * spriteW + x) * 4;
          frame.data[dstIdx] = png.data[srcIdx];       // R
          frame.data[dstIdx + 1] = png.data[srcIdx + 1]; // G
          frame.data[dstIdx + 2] = png.data[srcIdx + 2]; // B
          frame.data[dstIdx + 3] = png.data[srcIdx + 3]; // A
        }
      }
      frames.push({ data: PNG.sync.write(frame), width: spriteW, height: spriteH });
    }
  }
  return frames;
}

/**
 * Scale a frame to fit the target dimensions, preserving aspect ratio
 * and centering horizontally. Uses nearest-neighbor scaling for pixel art.
 */
function scaleFrame(frame: ExtractedFrame, targetW: number, targetH: number): PNG {
  const src = PNG.sync.read(frame.data);
  const out = new PNG({ width: targetW, height: targetH });

  // Fill transparent
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = 0;
  }

  // Calculate scale to fit (maintain aspect ratio)
  const scale = Math.min(targetW / src.width, targetH / src.height);
  const scaledW = Math.floor(src.width * scale);
  const scaledH = Math.floor(src.height * scale);

  // Center
  const offsetX = Math.floor((targetW - scaledW) / 2);
  const offsetY = targetH - scaledH; // bottom-align

  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      const srcIdx = (srcY * src.width + srcX) * 4;
      const dstIdx = ((offsetY + y) * targetW + (offsetX + x)) * 4;
      out.data[dstIdx] = src.data[srcIdx];
      out.data[dstIdx + 1] = src.data[srcIdx + 1];
      out.data[dstIdx + 2] = src.data[srcIdx + 2];
      out.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return out;
}

/**
 * Create a Pixel Agents format character sprite sheet from frames.
 * Layout: 7 frames wide × 3 rows (down, up, right)
 * Each frame is 16×24px with 8px top padding per 32px row.
 */
function createCharacterSheet(frames: PNG[]): PNG {
  const out = new PNG({ width: CHAR_TOTAL_W, height: CHAR_TOTAL_H });

  // Fill transparent
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = 0;
  }

  // Arrange frames: first N frames = row 0 (down), next N = row 1 (up), next N = row 2 (right)
  // If we don't have enough frames, repeat the first few
  const framesPerRow = 7;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < framesPerRow; col++) {
      const frameIdx = (row * framesPerRow + col) % frames.length;
      if (frameIdx >= frames.length) continue; // shouldn't happen with mod

      const frame = frames[frameIdx];
      const scaled = scaleFrame(
        { data: PNG.sync.write(frame), width: frame.width, height: frame.height },
        CHAR_FRAME_W,
        CHAR_FRAME_H,
      );

      // Copy scaled frame into sheet (top-aligned: starts at row*32, with 8px top padding at row*32+8)
      const dstY = row * CHAR_ROW_H + (CHAR_ROW_H - CHAR_FRAME_H);
      const dstX = col * CHAR_FRAME_W;

      for (let y = 0; y < CHAR_FRAME_H; y++) {
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const srcIdx = (y * CHAR_FRAME_W + x) * 4;
          const dstIdx = ((dstY + y) * CHAR_TOTAL_W + (dstX + x)) * 4;
          out.data[dstIdx] = scaled.data[srcIdx];
          out.data[dstIdx + 1] = scaled.data[srcIdx + 1];
          out.data[dstIdx + 2] = scaled.data[srcIdx + 2];
          out.data[dstIdx + 3] = scaled.data[srcIdx + 3];
        }
      }
    }
  }
  return out;
}

function convertFile(filename: string, charName: string): void {
  const filePath = path.join(DBZ_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP: ${filename} not found`);
    return;
  }

  const raw = fs.readFileSync(filePath);
  const png = PNG.sync.read(raw);
  console.log(`  ${charName}: ${png.width}x${png.height}`);

  // Extract frames (GBA sprites are typically 32×32 or 48×48)
  // Try common GBA sprite sizes
  const spriteSize = png.height >= 48 ? 48 : png.height >= 32 ? 32 : png.height;
  const frames = extractFrames(png, spriteSize, spriteSize);

  if (frames.length === 0) {
    console.log(`    WARN: no frames extracted with size ${spriteSize}x${spriteSize}`);
    return;
  }

  console.log(`    Extracted ${frames.length} frames (${spriteSize}x${spriteSize})`);

  // Convert frames to PNG objects
  const framePngs = frames.map((f) => PNG.sync.read(f.data));

  // Create Pixel Agents character sheet
  const sheet = createCharacterSheet(framePngs);

  // Write output
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${charName}.png`);
  fs.writeFileSync(outPath, PNG.sync.write(sheet));
  console.log(`    → ${outPath} (${sheet.width}x${sheet.height})`);
}

function main(): void {
  console.log('DBZ Sprite Converter\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let converted = 0;
  for (const [filename, charName] of Object.entries(SPRITE_MAP)) {
    convertFile(filename, charName);
    converted++;
  }

  console.log(`\nConverted ${converted} character(s) → ${OUT_DIR}/`);
  console.log('Copy these to: webview-ui/public/assets/characters/');
  console.log('Then add them to the sprite loading pipeline in src/assetLoader.ts');
}

main();
