// 从现有品牌源生成双色轮廓，使用项目 Tauri CLI 渲染，再封装 Windows 多尺寸图标。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = join(root, "src-tauri", "icons");
const tempRoot = join(root, ".tmp", "make-icon");
mkdirSync(tempRoot, { recursive: true });
const temp = mkdtempSync(join(tempRoot, "render-"));
const sizes = [16, 24, 32, 48, 64, 128, 256];

function outlinedSvg(source, foreground, outline) {
  const paths = source.match(/<path\b[^>]*\/>/g);
  const width = Number(source.match(/stroke-width="(\d+)"/)?.[1]);
  if (paths?.length !== 2 || !width) throw new Error("Unexpected brand SVG structure");
  const outlines = paths.map((path) => path.replace("<path ", `<path stroke="${outline}" stroke-width="${width + 8}" `));
  return source.replace('stroke="#ffffff"', `stroke="${foreground}"`)
    .replace(paths[0], `${outlines.join("\n")}\n${paths[0]}`);
}

function pack(images, out) {
  const headerSize = 6 + images.length * 16;
  const ico = Buffer.alloc(headerSize + images.reduce((n, i) => n + i.data.length, 0));
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    ico[e] = img.size >= 256 ? 0 : img.size;
    ico[e + 1] = ico[e];
    ico.writeUInt16LE(1, e + 4);
    ico.writeUInt16LE(32, e + 6);
    ico.writeUInt32LE(img.data.length, e + 8);
    ico.writeUInt32LE(offset, e + 12);
    img.data.copy(ico, offset);
    offset += img.data.length;
  });
  writeFileSync(out, ico);
  console.log(`icon written: ${out} (${ico.length} bytes, ${images.length} sizes)`);
}

try {
  for (const [name, foreground, outline] of [["", "#ffffff", "#20252c"], ["-light", "#20252c", "#ffffff"]]) {
    const images = [];
    for (const small of [true, false]) {
      const subset = sizes.filter((size) => (size <= 24) === small);
      const source = readFileSync(join(iconDir, small ? "brand-small.svg" : "brand.svg"), "utf8");
      const svg = join(temp, `brand${name}${small ? "-small" : ""}.svg`);
      const rendered = join(temp, `png${name}${small ? "-small" : ""}`);
      writeFileSync(svg, outlinedSvg(source, foreground, outline));
      execFileSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
        "icon", svg, "-o", rendered, ...subset.flatMap((size) => ["-p", String(size)])], { stdio: "inherit" });
      for (const size of subset) images.push({ size, data: readFileSync(join(rendered, `${size}x${size}.png`)) });
    }
    const pngDir = join(iconDir, `png${name}`);
    mkdirSync(pngDir, { recursive: true });
    for (const { size, data } of images) writeFileSync(join(pngDir, `${size}.png`), data);
    pack(images, join(iconDir, `icon${name}.ico`));
  }
} finally {
  // mkdtemp 返回的目录由本次调用独占，仅清理该目录。
  rmSync(temp, { recursive: true, force: true });
}
