const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function generateIcon(filePath) {
  const size = 256;
  const rawData = Buffer.alloc(size * (size * 4 + 1));

  // Color palette
  // Background: Rich dark teal / slate gradient
  // Header row: Bright teal #007acc
  // Grid lines: Subtle border
  // Accent: Vibrant green / cyan #10b981
  const bgR1 = 24, bgG1 = 30, bgB1 = 44;
  const bgR2 = 15, bgG2 = 23, bgB2 = 42;

  let offset = 0;
  for (let y = 0; y < size; y++) {
    rawData[offset++] = 0; // Filter byte 0 (None)
    const t = y / size;
    const curBgR = Math.round(bgR1 * (1 - t) + bgR2 * t);
    const curBgG = Math.round(bgG1 * (1 - t) + bgG2 * t);
    const curBgB = Math.round(bgB1 * (1 - t) + bgB2 * t);

    for (let x = 0; x < size; x++) {
      // Rounded corner check (radius 48)
      const r = 48;
      let inBounds = true;
      let alpha = 255;

      const dx = x < r ? r - x : x >= size - r ? x - (size - r - 1) : 0;
      const dy = y < r ? r - y : y >= size - r ? y - (size - r - 1) : 0;
      if (dx > 0 && dy > 0) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) inBounds = false;
        else if (dist > r - 1) alpha = Math.round((r - dist) * 255);
      }

      if (!inBounds) {
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        continue;
      }

      // Default background
      let pr = curBgR;
      let pg = curBgG;
      let pb = curBgB;

      // Draw spreadsheet grid inside box [36, 36] to [220, 220]
      const minX = 36, maxX = 220, minY = 36, maxY = 220;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        const gridW = maxX - minX;
        const gridH = maxY - minY;
        const relX = x - minX;
        const relY = y - minY;

        // Card background: deep navy
        pr = 30; pg = 41; pb = 59;

        // Header row: y from 0 to 44
        if (relY <= 44) {
          pr = 14; pg = 116; pb = 144; // cyan header
        }

        // Selected active cell: row 2, col 2 (relY 88 to 132, relX 60 to 124)
        if (relY >= 46 && relY <= 88 && relX >= 60 && relX <= 122) {
          pr = 16; pg = 185; pb = 129; // emerald green active cell
        }

        // Grid lines (borders)
        const isBorder = (
          relX === 0 || relX === gridW ||
          relY === 0 || relY === gridH ||
          relY === 44 || relY === 88 || relY === 132 || relY === 176 ||
          relX === 60 || relX === 122 || relX === 184
        );

        if (isBorder) {
          pr = 71; pg = 85; pb = 105; // slate border
        }
      }

      // Border highlight on outer icon edge
      const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edgeDist === 0) {
        pr = Math.min(255, pr + 40);
        pg = Math.min(255, pg + 40);
        pb = Math.min(255, pb + 40);
      }

      rawData[offset++] = pr;
      rawData[offset++] = pg;
      rawData[offset++] = pb;
      rawData[offset++] = alpha;
    }
  }

  // Compress
  const compressed = zlib.deflateSync(rawData);

  // PNG Header
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const chunks = [
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ];

  const pngBuffer = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`Generated icon at: ${filePath} (${pngBuffer.length} bytes)`);
}

generateIcon(path.join(__dirname, '../media/icon.png'));
