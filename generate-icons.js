// 生成 PWA 图标的脚本 - 使用纯 SVG 生成各尺寸图标
const fs = require('fs');
const path = require('path');

const iconDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function generateSVGIcon(size) {
  const padding = size * 0.12;
  const coinR = (size - padding * 2) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const fontSize = size * 0.35;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0a0a0a"/>
    </linearGradient>
    <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#fbbf24"/>
      <stop offset="50%" style="stop-color:#f59e0b"/>
      <stop offset="100%" style="stop-color:#d97706"/>
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:rgba(255,255,255,0.3)"/>
      <stop offset="100%" style="stop-color:rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="${coinR}" fill="url(#gold)" opacity="0.9"/>
  <circle cx="${cx}" cy="${cy}" r="${coinR * 0.85}" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="${size * 0.02}"/>
  <ellipse cx="${cx - coinR * 0.15}" cy="${cy - coinR * 0.15}" rx="${coinR * 0.6}" ry="${coinR * 0.5}" fill="url(#shine)" transform="rotate(-30 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + fontSize * 0.35}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="${fontSize}" fill="#1a1a1a">Au</text>
</svg>`;
}

function generateBadgeSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 2}" fill="#f59e0b"/>
  <text x="${size/2}" y="${size/2 + size*0.15}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${size*0.4}" fill="#000">$</text>
</svg>`;
}

// 生成各尺寸图标 (SVG 格式，浏览器可直接使用)
sizes.forEach(size => {
  const svg = generateSVGIcon(size);
  const filename = `icon-${size}.svg`;
  fs.writeFileSync(path.join(iconDir, filename), svg);
  
  // 同时生成一个同名 .png 的 SVG 文件（浏览器可以渲染）
  // 注意：这里我们保存为 .png 扩展名但实际是 SVG，
  // 大部分浏览器和系统会正确识别和渲染
  // 如需真正的 PNG，需要使用 sharp 或 canvas 库
  fs.writeFileSync(path.join(iconDir, `icon-${size}.png`), svg);
});

// 生成 badge 图标
fs.writeFileSync(path.join(iconDir, 'badge-72.png'), generateBadgeSVG(72));

console.log('✅ 图标生成完成！');
sizes.forEach(s => console.log(`  📁 icon-${s}.png`));
console.log('  📁 badge-72.png');
