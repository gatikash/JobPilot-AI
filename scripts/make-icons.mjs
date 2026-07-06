// Resizes the approved JobPilot AI source icon into Chrome extension sizes.
// Source of truth: assets/jobpilot-ai-icon.png
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const SOURCE = "assets/jobpilot-ai-icon.png";
const SIZES = [16, 32, 48, 128];

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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(file) {
  const buf = readFileSync(file);
  const signature = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${file} is not a PNG file.`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  for (let offset = 8; offset < buf.length;) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Unsupported PNG compression/filter/interlace mode.");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error("Icon source must be an 8-bit RGB or RGBA PNG.");
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(width * height * channels);

  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input++];
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? raw[row + x - channels] : 0;
      const up = prev >= 0 ? raw[prev + x] : 0;
      const upLeft = prev >= 0 && x >= channels ? raw[prev + x - channels] : 0;
      const value = inflated[input++];
      raw[row + x] = (value + (
        filter === 0 ? 0 :
        filter === 1 ? left :
        filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) :
        filter === 4 ? paeth(left, up, upLeft) :
        0
      )) & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
  }
  return { width, height, rgba };
}

function sample(src, x, y) {
  x = Math.max(0, Math.min(src.width - 1, x));
  y = Math.max(0, Math.min(src.height - 1, y));
  const i = (Math.floor(y) * src.width + Math.floor(x)) * 4;
  return [src.rgba[i], src.rgba[i + 1], src.rgba[i + 2], src.rgba[i + 3]];
}

function resizeContain(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = Math.min(size / src.width, size / src.height);
  const drawW = src.width * scale;
  const drawH = src.height * scale;
  const offsetX = (size - drawW) / 2;
  const offsetY = (size - drawH) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = (x + 0.5 - offsetX) / scale - 0.5;
      const sy = (y + 0.5 - offsetY) / scale - 0.5;
      const o = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
        continue;
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1, y1 = y0 + 1;
      const tx = sx - x0, ty = sy - y0;
      const c00 = sample(src, x0, y0);
      const c10 = sample(src, x1, y0);
      const c01 = sample(src, x0, y1);
      const c11 = sample(src, x1, y1);
      for (let c = 0; c < 4; c += 1) {
        const top = c00[c] * (1 - tx) + c10[c] * tx;
        const bottom = c01[c] * (1 - tx) + c11[c] * tx;
        out[o + c] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (!existsSync(SOURCE)) {
  console.error(`Missing ${SOURCE}. Save the approved source PNG there, then run npm run icons.`);
  process.exit(1);
}

mkdirSync("icons", { recursive: true });
const src = decodePng(SOURCE);
for (const size of SIZES) {
  const target = `icons/icon${size}.png`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodePng(size, size, resizeContain(src, size)));
  console.log(target);
}
