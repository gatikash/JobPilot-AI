// Generates simple flame-colored placeholder PNG icons without any image library.
// Draws a filled rounded square in FireApply orange with an "F" cut-out look
// approximated by a lighter inner square. Pure zlib + PNG chunk writing.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let c = ~0;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  // raw image: each row prefixed with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Flame orange rounded square with a white "F" bar motif.
function pixel(x, y, s) {
  const r = s * 0.18; // corner radius
  const inCorner = (cx, cy) => {
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy > r * r;
  };
  if (
    (x < r && y < r && inCorner(r, r)) ||
    (x >= s - r && y < r && inCorner(s - r - 1, r)) ||
    (x < r && y >= s - r && inCorner(r, s - r - 1)) ||
    (x >= s - r && y >= s - r && inCorner(s - r - 1, s - r - 1))
  ) {
    return [0, 0, 0, 0];
  }
  // "F" glyph: vertical bar + two horizontal bars, in white
  const u = s / 16;
  const inV = x >= 5 * u && x < 7.5 * u && y >= 3.5 * u && y < 12.5 * u;
  const inTop = x >= 5 * u && x < 11.5 * u && y >= 3.5 * u && y < 6 * u;
  const inMid = x >= 5 * u && x < 10.5 * u && y >= 7.5 * u && y < 9.5 * u;
  if (inV || inTop || inMid) return [255, 255, 255, 255];
  // orange gradient background
  const t = y / s;
  return [Math.round(255 - 40 * t), Math.round(90 + 30 * (1 - t)), 30, 255];
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, png(size, pixel));
  console.log(`icons/icon${size}.png`);
}
