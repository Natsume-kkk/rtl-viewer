// 将 src-tauri/icons/png/ 下的多尺寸 PNG 封装为多尺寸 ICO（Windows 资源需要），无第三方依赖。
// PNG 由 src-tauri/icons/brand.svg（meridian 设计源：design-agent outputs/rtl-viewer-meridian/assets/brand/）
// 经浏览器按 16/24/32/48/64/128/256 透明背景渲染产出；修改 brand.svg 后需重新渲染 PNG 再运行本脚本。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pngDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons", "png");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = sizes.map((size) => {
  const file = join(pngDir, `${size}.png`);
  return { size, data: readFileSync(file) };
});

const headerSize = 6 + images.length * 16;
const ico = Buffer.alloc(headerSize + images.reduce((n, i) => n + i.data.length, 0));
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(images.length, 4);
let offset = headerSize;
images.forEach((img, i) => {
  const e = 6 + i * 16;
  ico[e] = img.size >= 256 ? 0 : img.size; // 256 记为 0
  ico[e + 1] = img.size >= 256 ? 0 : img.size;
  ico[e + 2] = 0; // palette
  ico[e + 3] = 0; // reserved
  ico.writeUInt16LE(1, e + 4); // planes
  ico.writeUInt16LE(32, e + 6); // bpp
  ico.writeUInt32LE(img.data.length, e + 8);
  ico.writeUInt32LE(offset, e + 12);
  img.data.copy(ico, offset);
  offset += img.data.length;
});

const out = join(pngDir, "..", "icon.ico");
writeFileSync(out, ico);
console.log(`icon written: ${out} (${ico.length} bytes, ${images.length} sizes)`);
