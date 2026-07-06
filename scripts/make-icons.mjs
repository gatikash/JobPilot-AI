// Generates JobPilot AI search/profile PNG icons in Chrome extension sizes.
// Pure zlib + PNG chunk writing so icon generation works anywhere Node works.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function over(bottom, top) {
  const ta = top[3] / 255;
  const ba = bottom[3] / 255;
  const oa = ta + ba * (1 - ta);
  if (oa <= 0) return [0, 0, 0, 0];
  return [
    Math.round((top[0] * ta + bottom[0] * ba * (1 - ta)) / oa),
    Math.round((top[1] * ta + bottom[1] * ba * (1 - ta)) / oa),
    Math.round((top[2] * ta + bottom[2] * ba * (1 - ta)) / oa),
    Math.round(oa * 255),
  ];
}

function roundedRect(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function circle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function capsule(px, py, ax, ay, bx, by, r) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - (ax + vx * c), py - (ay + vy * c)) - r;
}

function polygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const hit = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function alphaFromDistance(d) {
  return Math.round(clamp(0.5 - d) * 255);
}

function teal(u, v, alpha = 255) {
  const t = clamp((u * 0.45 + v * 0.75) / 1.2);
  return [mix(18, 0, t), mix(210, 145, t), mix(164, 132, t), alpha];
}

function iconPixel(x, y, s) {
  const samples = 3;
  let color = [0, 0, 0, 0];

  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const u = (x + (sx + 0.5) / samples) / s;
      const v = (y + (sy + 0.5) / samples) / s;
      let c = [0, 0, 0, 0];

      const tile = roundedRect(u, v, 0.055, 0.055, 0.89, 0.89, 0.19);
      if (tile <= 0) {
        const shade = clamp(v * 1.15);
        c = over(c, [mix(255, 230, shade), mix(255, 252, shade), mix(255, 248, shade), 255]);
        const mintGlow = clamp(1 - Math.hypot(u - 0.55, v - 0.8) / 0.52);
        c = over(c, [196, 248, 235, Math.round(mintGlow * 90)]);
      }

      const shadowTile = roundedRect(u, v, 0.055, 0.055, 0.89, 0.89, 0.19);
      if (shadowTile > 0 && shadowTile < 0.035) {
        c = over(c, [28, 157, 139, Math.round((0.035 - shadowTile) * 1300)]);
      }

      const cx = 0.445;
      const cy = 0.46;
      const ringOuter = circle(u, v, cx, cy, 0.285);
      const ringInner = circle(u, v, cx, cy, 0.221);
      if (ringOuter <= 0 && ringInner >= 0) {
        c = over(c, teal(u, v, alphaFromDistance(Math.max(ringOuter, -ringInner) * s)));
      }

      const handle = capsule(u, v, 0.64, 0.65, 0.805, 0.815, 0.052);
      if (handle <= 0) c = over(c, teal(u, v, alphaFromDistance(handle * s)));

      const head = circle(u, v, cx, cy - 0.055, 0.059);
      if (head <= 0) c = over(c, teal(u, v, alphaFromDistance(head * s)));

      const body = capsule(u, v, cx - 0.087, cy + 0.104, cx + 0.087, cy + 0.104, 0.071);
      const bodyMask = v >= cy + 0.02 && v <= cy + 0.16 && body <= 0;
      if (bodyMask) c = over(c, teal(u, v, alphaFromDistance(body * s)));

      const sparkle = polygon(u, v, [
        [0.715, 0.183],
        [0.742, 0.247],
        [0.81, 0.274],
        [0.742, 0.3],
        [0.715, 0.367],
        [0.688, 0.3],
        [0.62, 0.274],
        [0.688, 0.247],
      ]);
      if (sparkle) c = over(c, teal(u, v, 245));

      color = over(color, [c[0], c[1], c[2], Math.round(c[3] / (samples * samples))]);
    }
  }

  return color;
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, png(size, iconPixel));
  console.log(`icons/icon${size}.png`);
}
