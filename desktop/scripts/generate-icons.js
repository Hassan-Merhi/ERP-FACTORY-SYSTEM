/**
 * generate-icons.js
 * Run: node scripts/generate-icons.js
 *
 * Reads the HMD logo from the web app's public directory and outputs
 * all icon sizes required by Electron + the Microsoft Store.
 *
 * Requires: sharp  (installed via npm install in desktop/)
 */

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const SOURCE = path.resolve(__dirname, '../../client/public/hmd-logo-clean.png');
const OUT    = path.resolve(__dirname, '../icons');
// electron-builder has no appx.assets option: AppxTarget picks user tile assets
// up from <buildResources>/appx, and buildResources is `build` in
// electron-builder.config.js. Writing them anywhere else leaves the package
// with electron-builder's own placeholder tiles.
const STORE  = path.resolve(__dirname, '../build/appx');

[OUT, STORE].forEach(d => fs.mkdirSync(d, { recursive: true }));

async function resize(src, dest, width, height, fit = 'contain', background = { r:15, g:23, b:42, alpha:1 }) {
  await sharp(src)
    .resize(width, height, { fit, background })
    .png()
    .toFile(dest);
  console.log('✓', path.relative(path.resolve(__dirname, '..'), dest));
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Source image not found:', SOURCE);
    console.error('Run from the desktop/ directory or adjust SOURCE in this script.');
    process.exit(1);
  }

  console.log('Generating icons from:', SOURCE);
  console.log('Output dir:', OUT);
  console.log('');

  const windowsSizes = [16, 24, 32, 48, 64, 96, 128, 256];
  for (const s of windowsSizes) {
    await resize(SOURCE, path.join(OUT, `${s}x${s}.png`), s, s, 'contain', { r:15, g:23, b:42, alpha:1 });
  }

  await resize(SOURCE, path.join(OUT, 'icon.png'), 256, 256, 'contain', { r:15, g:23, b:42, alpha:1 });

  const storeSizes = [
    { name: 'Square44x44Logo.png',   w: 44,  h: 44  },
    { name: 'Square50x50Logo.png',   w: 50,  h: 50  },
    { name: 'Square150x150Logo.png', w: 150, h: 150 },
    { name: 'Square300x300Logo.png', w: 300, h: 300 },
    { name: 'Wide310x150Logo.png',   w: 310, h: 150 },
    { name: 'Square310x310Logo.png', w: 310, h: 310 },
    { name: 'StoreLogo.png',         w: 50,  h: 50  },
  ];

  for (const { name, w, h } of storeSizes) {
    await resize(SOURCE, path.join(STORE, name), w, h, 'contain', { r:15, g:23, b:42, alpha:1 });
  }

  await buildIco();

  console.log('');
  console.log('All icons generated successfully.');
  console.log('Next step: run  npm run build:unsigned  to produce the APPX/MSIX.');
}

async function buildIco() {
  const icoSizes   = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = [];

  for (const s of icoSizes) {
    const buf = await sharp(SOURCE)
      .resize(s, s, { fit: 'contain', background: { r:15, g:23, b:42, alpha:1 } })
      .png()
      .toBuffer();
    icoBuffers.push({ size: s, buffer: buf });
  }

  const ico = buildIcoBuffer(icoBuffers);
  const dest = path.join(OUT, 'icon.ico');
  fs.writeFileSync(dest, ico);
  console.log('✓', path.relative(path.resolve(__dirname, '..'), dest), '(ICO multi-size)');
}

function buildIcoBuffer(images) {
  const count   = images.length;
  const headerSize   = 6;
  const dirEntrySize = 16;
  const dirSize  = headerSize + count * dirEntrySize;

  let imageDataOffset = dirSize;
  const imageInfos = images.map(({ size, buffer }) => {
    const info = { size, buffer, offset: imageDataOffset };
    imageDataOffset += buffer.length;
    return info;
  });

  const totalSize = imageDataOffset;
  const buf = Buffer.alloc(totalSize);

  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(count, 4);

  let dirOffset = headerSize;
  for (const { size, buffer, offset } of imageInfos) {
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    buf.writeUInt8(w, dirOffset);
    buf.writeUInt8(h, dirOffset + 1);
    buf.writeUInt8(0, dirOffset + 2);
    buf.writeUInt8(0, dirOffset + 3);
    buf.writeUInt16LE(1, dirOffset + 4);
    buf.writeUInt16LE(32, dirOffset + 6);
    buf.writeUInt32LE(buffer.length, dirOffset + 8);
    buf.writeUInt32LE(offset, dirOffset + 12);
    dirOffset += dirEntrySize;
  }

  for (const { buffer, offset } of imageInfos) {
    buffer.copy(buf, offset);
  }

  return buf;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
