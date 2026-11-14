// Generates Android launcher icons (legacy, round, adaptive foreground) and splash screens
// from public/icons/icon.svg. Run: node scripts/make-android-assets.cjs (needs Playwright).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const res = path.join(__dirname, '../android/app/src/main/res');
const svg = fs.readFileSync(path.join(__dirname, '../public/icons/icon.svg'), 'utf8');
const glyph = svg.replace(/<rect width="512" height="512"[^>]*\/>/, ''); // icon without its background
const BG = '#0f766e';
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  async function render(file, w, h, html, transparent = false) {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${html}</body></html>`);
    await p.screenshot({ path: file, omitBackground: transparent });
  }
  const sized = (s, size) => s.replace('<svg ', `<svg width="${size}" height="${size}" `);
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(res, 'mipmap-' + d);
    const L = Math.round(48 * k);
    await render(path.join(dir, 'ic_launcher.png'), L, L, sized(svg, L), true);
    await render(path.join(dir, 'ic_launcher_round.png'), L, L,
      `<div style="width:${L}px;height:${L}px;border-radius:50%;overflow:hidden;background:${BG}">${sized(svg, L)}</div>`, true);
    const F = Math.round(108 * k), inner = Math.round(F * 0.62);
    await render(path.join(dir, 'ic_launcher_foreground.png'), F, F,
      `<div style="width:${F}px;height:${F}px;display:flex;align-items:center;justify-content:center">${sized(glyph, inner)}</div>`, true);
  }
  // splash screens: replace every existing splash.png keeping its size
  const splashes = execSync(`find ${res} -name splash.png`).toString().trim().split('\n');
  for (const f of splashes) {
    const [w, h] = execSync(`python3 -c "from PIL import Image;print(*Image.open('${f}').size)"`).toString().trim().split(' ').map(Number);
    const s = Math.round(Math.min(w, h) * 0.32);
    await render(f, w, h, `<div style="width:${w}px;height:${h}px;background:${BG};display:flex;align-items:center;justify-content:center">${sized(glyph, s)}</div>`);
  }
  await b.close();
  console.log('android assets generated');
})();
