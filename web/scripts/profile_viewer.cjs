// Run against a production build with Playwright available to Node.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { createReadStream, existsSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || 'dist');
const captures = process.argv[3];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary' };
const layouts = [['desktop', 1440, 900], ['portrait', 390, 844], ['landscape', 844, 390]];

function instrument() {
  const probe = window.viewerProfile = { frames: 0, buffers: 0, textures: 0, steps: 0, surface: 0, times: [] };
  const gl = WebGL2RenderingContext.prototype;
  for (const [method, field, change] of [
    ['createBuffer', 'buffers', 1], ['deleteBuffer', 'buffers', -1],
    ['createTexture', 'textures', 1], ['deleteTexture', 'textures', -1],
  ]) {
    const original = gl[method];
    gl[method] = function (...args) {
      const result = original.apply(this, args);
      if (change > 0 ? result : args[0]) probe[field] += change;
      return result;
    };
  }
  // Count frames presented to the canvas, excluding intermediate anatomy render targets.
  let framebuffer = null;
  const bind = gl.bindFramebuffer;
  gl.bindFramebuffer = function (target, value) {
    if (target !== this.READ_FRAMEBUFFER) framebuffer = value;
    return bind.call(this, target, value);
  };
  const clear = gl.clear;
  gl.clear = function (mask) {
    if (!framebuffer && (mask & this.COLOR_BUFFER_BIT)) {
      probe.frames++;
      probe.times.push(performance.now());
    }
    return clear.call(this, mask);
  };
  const draw = gl.drawElements;
  gl.drawElements = function (...args) {
    // The shared GLB has 71k+ indices. Ignore the smaller procedural fallback.
    if (!probe.surface && args[1] >= 71000) probe.surface = performance.now();
    return draw.apply(this, args);
  };
  const observer = new MutationObserver(() => {
    if (document.querySelector('.v-step-cue')?.textContent?.trim().length > 6) {
      probe.steps = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
}

async function dragDuringPlayback(page) {
  const box = await page.locator('canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.evaluate(() => { viewerProfile.times = []; });
  const start = Date.now();
  while (Date.now() - start < 4000) {
    await page.mouse.move(x + 60 * Math.sin((Date.now() - start) / 750), y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.mouse.up();
  return page.evaluate(() => {
    const dt = viewerProfile.times.slice(1).map((t, i) => t - viewerProfile.times[i]).sort((a, b) => a - b);
    return Number(dt[Math.ceil(0.95 * dt.length) - 1].toFixed(2));
  });
}

async function select(page, exercise, mode = 'correct') {
  await page.evaluate(({ slug, mode }) => {
    location.hash = 'stretch=' + slug + '&phase=stretch' + (mode === 'mistake' ? '&mode=mistake' : '');
  }, { slug: exercise.slug, mode });
  await page.waitForFunction(n => document.querySelector('#coach-eyebrow')?.textContent.includes('#' + String(n).padStart(2, '0')), exercise.order);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function profile(browser, url, exercises, [name, width, height]) {
  const options = { viewport: { width, height }, deviceScaleFactor: 1, hasTouch: name !== 'desktop' };
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + new URL(response.url()).pathname); });
    await page.addInitScript(instrument);
    await page.goto(url);
    await page.waitForFunction(() => viewerProfile.surface > 0 && viewerProfile.steps > 0);
    const readCold = () => ({ stepsMs: Math.round(viewerProfile.steps), surfaceMs: Math.round(viewerProfile.surface) });
    const cold = [await page.evaluate(readCold)];
    await page.evaluate(() => document.querySelector('#btn-mode-mistake').click());
    const frameP95Ms = await dragDuringPlayback(page);
    await select(page, exercises[0]);
    await page.waitForTimeout(1800);
    const resources = () => page.evaluate(() => ({ buffers: viewerProfile.buffers, textures: viewerProfile.textures }));
    const start = await resources();
    const before = await page.evaluate(() => viewerProfile.frames);
    await page.waitForTimeout(1100);
    const idleFrames = (await page.evaluate(() => viewerProfile.frames)) - before;
    for (const exercise of exercises) {
      await select(page, exercise);
      if (captures) {
        const filename = name + '-' + String(exercise.order).padStart(2, '0') + '.jpg';
        await page.locator('.viewport-wrap').screenshot({ path: path.join(captures, filename), quality: 78, type: 'jpeg' });
      }
    }
    await select(page, exercises[0]);
    const end = await resources();
    if (captures) {
      for (const exercise of exercises) {
        await select(page, exercise, 'mistake');
        const filename = name + '-mistake-' + String(exercise.order).padStart(2, '0') + '.jpg';
        await page.locator('.viewport-wrap').screenshot({ path: path.join(captures, filename), quality: 78, type: 'jpeg' });
      }
    }
    for (let i = 1; i < 5; i++) {
      const fresh = await browser.newContext(options);
      try {
        const sample = await fresh.newPage();
        await sample.addInitScript(instrument);
        await sample.goto(url);
        await sample.waitForFunction(() => viewerProfile.surface > 0 && viewerProfile.steps > 0);
        cold.push(await sample.evaluate(readCold));
      } finally {
        await fresh.close();
      }
    }
    const median = key => cold.map(sample => sample[key]).sort((a, b) => a - b)[2];
    console.log(JSON.stringify({ name, stepsMs: median('stepsMs'), surfaceMs: median('surfaceMs'), cold,
      frameP95Ms, idleFrames, start, end, errors }));
  } finally {
    await context.close();
  }
}

async function main() {
  const exercises = JSON.parse(readFileSync(path.join(root, 'data/book_index.json'))).stretches;
  if (captures) mkdirSync(captures, { recursive: true });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(root + path.sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });
    try {
      for (const layout of layouts) await profile(browser, 'http://127.0.0.1:' + server.address().port, exercises, layout);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
