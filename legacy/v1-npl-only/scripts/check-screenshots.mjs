#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = 'test-artifacts/screenshots';
const required = {
  'c-app-seckill.png': [1000, 800],
  'c-app-mall.png': [1000, 800],
  'c-app-stores.png': [1000, 800],
  'c-app-assets.png': [1000, 800],
  'merchant.png': [1000, 700],
  'admin.png': [1000, 700],
  'contact-sheet.png': [700, 800]
};

const missing = Object.entries(required).filter(([name, [minWidth, minHeight]]) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file) || fs.statSync(file).size <= 10_000) return true;
  const dimensions = pngDimensions(file);
  return !dimensions || dimensions.width < minWidth || dimensions.height < minHeight;
}).map(([name]) => name);

if (missing.length) {
  console.error(`screenshots check: FAIL missing or tiny files: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`screenshots check: PASS ${Object.keys(required).length}/${Object.keys(required).length}`);

function pngDimensions(file) {
  const buffer = fs.readFileSync(file);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
