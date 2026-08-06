const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const forkRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(forkRoot, '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(forkRoot, 'version-lock.json'), 'utf8'));
const sourceRoot = path.resolve(process.argv[2] || lock.chromium.sourceRoot);
const masterPath = path.resolve(repoRoot, lock.product.iconSource);

function sourcePath(relativePath) {
  return path.join(sourceRoot, ...relativePath.split('/'));
}

async function writePng(relativePath, size, inset = 0) {
  const output = sourcePath(relativePath);
  const contentSize = Math.max(1, Math.round(size * (1 - inset * 2)));
  const image = await sharp(masterPath)
    .resize(contentSize, contentSize, { fit: 'contain' })
    .extend({
      top: Math.floor((size - contentSize) / 2),
      bottom: Math.ceil((size - contentSize) / 2),
      left: Math.floor((size - contentSize) / 2),
      right: Math.ceil((size - contentSize) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, image);
  return image;
}

async function writeMonoPng(relativePath, size) {
  const { data, info } = await sharp(masterPath)
    .resize(size, size, { fit: 'contain' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  }
  const output = sourcePath(relativePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, await sharp(data, { raw: info }).png().toBuffer());
}

async function renderWordmark(width, height, textColor) {
  const iconSize = height;
  const gap = Math.max(3, Math.round(height * 0.18));
  const fontSize = Math.round(height * 0.57);
  const icon = await sharp(masterPath).resize(iconSize, iconSize, { fit: 'contain' }).png().toBuffer();
  const iconUri = `data:image/png;base64,${icon.toString('base64')}`;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image href="${iconUri}" width="${iconSize}" height="${iconSize}"/>
    <text x="${iconSize + gap}" y="50%" dominant-baseline="central" fill="${textColor}" font-family="Segoe UI,Arial,sans-serif" font-size="${fontSize}" font-weight="600">AI-FREE</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function writeWordmark(relativePath, width, height, textColor) {
  const output = sourcePath(relativePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, await renderWordmark(width, height, textColor));
}

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function main() {
  if (!fs.existsSync(masterPath)) throw new Error(`Brand master not found: ${masterPath}`);
  if (!fs.existsSync(sourceRoot)) throw new Error(`Chromium source root not found: ${sourceRoot}`);

  const shortcutSizes = [16, 24, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of shortcutSizes) {
    const data = await writePng(`chrome/app/theme/chromium/product_logo_${size}.png`, size);
    if ([16, 32, 48, 64, 128, 256].includes(size)) icoImages.push({ size, data });
  }
  // Chromium does not keep a standalone 32px shortcut PNG in this directory.
  icoImages.splice(1, 0, { size: 32, data: await sharp(masterPath).resize(32, 32, { fit: 'contain' }).png().toBuffer() });

  await writeMonoPng('chrome/app/theme/chromium/product_logo_22_mono.png', 22);
  await writePng('chrome/app/theme/default_100_percent/chromium/product_logo_16.png', 16);
  await writePng('chrome/app/theme/default_100_percent/chromium/product_logo_32.png', 32);
  await writePng('chrome/app/theme/default_200_percent/chromium/product_logo_16.png', 32);
  await writePng('chrome/app/theme/default_200_percent/chromium/product_logo_32.png', 64);
  await writeWordmark('chrome/app/theme/default_100_percent/chromium/product_logo_name_22.png', 97, 22, '#202124');
  await writeWordmark('chrome/app/theme/default_100_percent/chromium/product_logo_name_22_white.png', 97, 22, '#ffffff');
  await writeWordmark('chrome/app/theme/default_200_percent/chromium/product_logo_name_22.png', 194, 44, '#202124');
  await writeWordmark('chrome/app/theme/default_200_percent/chromium/product_logo_name_22_white.png', 194, 44, '#ffffff');

  await writeWordmark('components/resources/default_100_percent/chromium/product_logo.png', 171, 32, '#202124');
  await writeWordmark('components/resources/default_100_percent/chromium/product_logo_white.png', 171, 32, '#ffffff');
  await writeWordmark('components/resources/default_200_percent/chromium/product_logo.png', 342, 64, '#202124');
  await writeWordmark('components/resources/default_200_percent/chromium/product_logo_white.png', 342, 64, '#ffffff');

  await writePng('chrome/app/theme/chromium/win/tiles/Logo.png', 600, 0.12);
  await writePng('chrome/app/theme/chromium/win/tiles/SmallLogo.png', 176, 0.12);

  const ico = createIco(icoImages);
  for (const name of ['chromium.ico', 'chromium_doc.ico', 'chromium_pdf.ico']) {
    fs.writeFileSync(sourcePath(`chrome/app/theme/chromium/win/${name}`), ico);
  }

  const svgIcon = await sharp(masterPath).resize(256, 256, { fit: 'contain' }).png().toBuffer();
  const svgUri = `data:image/png;base64,${svgIcon.toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image href="${svgUri}" width="256" height="256"/></svg>\n`;
  fs.writeFileSync(sourcePath('chrome/app/theme/chromium/product_logo.svg'), svg);
  fs.writeFileSync(sourcePath('chrome/app/theme/chromium/product_logo_animation.svg'), svg);

  const hash = crypto.createHash('sha256').update(ico).digest('hex').toUpperCase();
  console.log(`Generated AI-FREE brand assets from ${masterPath}`);
  console.log(`Windows icon SHA-256: ${hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
