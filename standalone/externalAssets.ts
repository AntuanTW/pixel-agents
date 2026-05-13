import * as fs from 'fs';
import * as path from 'path';
import { decodeCharacterPng, pngToSpriteData } from '../shared/assets/pngDecoder.js';
import type { CharacterDirectionSprites } from '../shared/assets/types.js';

export interface ExternalCharacterSprites {
  characters: CharacterDirectionSprites[];
}

/** Load char_N.png files from {dir}/assets/characters/. Returns null if none found. */
export function loadExternalCharacters(dir: string): ExternalCharacterSprites | null {
  const charDir = path.join(dir, 'assets', 'characters');
  if (!fs.existsSync(charDir)) return null;

  const entries = fs.readdirSync(charDir);
  const charFiles: { index: number; filename: string }[] = [];
  for (const entry of entries) {
    const match = /^char_(\d+)\.png$/i.exec(entry);
    if (match) charFiles.push({ index: parseInt(match[1], 10), filename: entry });
  }
  if (charFiles.length === 0) return null;

  charFiles.sort((a, b) => a.index - b.index);
  const characters: CharacterDirectionSprites[] = [];
  for (const { filename } of charFiles) {
    try {
      const pngBuffer = fs.readFileSync(path.join(charDir, filename));
      characters.push(decodeCharacterPng(pngBuffer));
    } catch (err) {
      console.warn(`[ExternalAssets] Failed to decode ${filename}:`, err);
    }
  }
  return characters.length > 0 ? { characters } : null;
}

/** Load furniture PNGs and catalog from {dir}/assets/. Returns sprites map and catalog. */
export function loadExternalFurniture(
  dir: string,
): { catalog: Record<string, unknown>[]; sprites: Record<string, string[][]> } | null {
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) return null;

  const catalogPath = path.join(assetsDir, 'furniture-catalog.json');
  let catalog: Record<string, unknown>[] = [];
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    } catch { /* ignore bad catalog */ }
  }

  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const furniturePath = entry.furniturePath as string | undefined;
    if (!furniturePath) continue;
    const fullPath = path.join(assetsDir, furniturePath);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const pngBuffer = fs.readFileSync(fullPath);
      sprites[entry.id as string] = pngToSpriteData(pngBuffer, entry.width as number, entry.height as number);
    } catch (err) {
      console.warn(`[ExternalAssets] Failed to decode furniture ${entry.id}:`, err);
    }
  }

  return { catalog, sprites };
}
