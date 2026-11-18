// Run against a local production preview. Optional directory stores the 240 review images.
const { chromium } = require('playwright');
const { mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const url = process.argv[2] || 'http://127.0.0.1:4174/';
const captures = process.argv[3];
const book = JSON.parse(readFileSync(path.join(__dirname, '../public/data/book_index.json'))).stretches;

// Compare real canvas pixels with and without an individual bundle. Only draws
// into the offscreen muscle pass are suppressed. The production camera, skin,
// lighting, foreground limbs and solid props participate in both frames.
function instrument() {
  const gl = WebGL2RenderingContext.prototype;
  const probe = window.bundleProbe = { omit: 'none', requested: false, bundles: 0 };
  let framebuffer = null;
  let bundle = 0;
  const bind = gl.bindFramebuffer;
  gl.bindFramebuffer = function (target, value) {
    if (target !== this.READ_FRAMEBUFFER) framebuffer = value;
    return bind.call(this, target, value);
  };
  const draw = gl.drawElements;
  gl.drawElements = function (...args) {
    if (framebuffer) {
      probe.ready = true;
      const index = bundle++;
      if (probe.omit === 'all' || probe.omit === index) return;
    }
    return draw.apply(this, args);
  };
  const clear = gl.clear;
  gl.clear = function (mask) {
    if (mask & this.COLOR_BUFFER_BIT) {
      if (framebuffer) bundle = 0;
      else if (probe.requested) {
        probe.requested = false;
        probe.bundles = bundle;
        // Read the final framebuffer after all the synchronous scene draws and
        // before the browser discards the drawing buffer for presentation.
        queueMicrotask(() => {
          const width = this.drawingBufferWidth, height = this.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels);
          probe.pixels = pixels;
        });
      }
    }
    return clear.call(this, mask);
  };
}

async function difference(page, omit) {
  return page.evaluate(async omit => {
    const p = window.bundleProbe;
    p.omit = omit;
    p.requested = true;
    p.pixels = null;
    // Invalidate a paused stage without changing the pose, camera or labels.
    const labels = document.querySelector('#btn-toggle-labels');
    labels.click();
    labels.click();
    for (let i = 0; i < 30 && !p.pixels; i++) await new Promise(requestAnimationFrame);
    if (!p.pixels) throw Error('No presented frame');
    if (omit === 'none') {
      p.reference = p.pixels;
      return p.bundles;
    }
    let count = 0;
    for (let i = 0; i < p.pixels.length; i += 4) {
      const delta = Math.max(Math.abs(p.pixels[i] - p.reference[i]),
        Math.abs(p.pixels[i + 1] - p.reference[i + 1]), Math.abs(p.pixels[i + 2] - p.reference[i + 2]));
      if (delta >= 8) count++;
    }
    return count;
  }, omit);
}

async function select(page, exercise, phase, mistake) {
  await page.evaluate(hash => { location.hash = hash; },
    'stretch=' + exercise.slug + '&phase=' + phase + (mistake ? '&mode=mistake' : ''));
  const index = ['setup', 'stretch', 'resist', 'deepen'].indexOf(phase);
  await page.waitForFunction(({ label, mistake, index }) =>
    document.querySelector('#coach-eyebrow')?.textContent.includes(label) &&
    document.querySelector('#btn-mode-mistake')?.getAttribute('aria-pressed') === String(mistake) &&
    (mistake || document.querySelectorAll('#hud-mini-steps button')[index]?.getAttribute('aria-pressed') === 'true') &&
    !document.querySelector('#btn-play-pause')?.disabled, { index, label: '#' + String(exercise.order).padStart(2, '0') + '/', mistake });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function review(browser, name, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: name === 'portrait' || name === 'landscape' });
  try {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(instrument);
    await page.goto(url + '#stretch=quadratus-lumborum-seated&phase=setup');
    await page.waitForFunction(() => window.bundleProbe.ready);
    const commentView = name === 'comment';
    const exercises = commentView ? book.filter(e => e.slug === 'quadratus-lumborum-seated') : book;
    for (const exercise of exercises) {
      for (const phase of commentView ? ['setup', 'stretch', 'resist', 'deepen', 'mistake'] : ['stretch', 'mistake']) {
        const mistake = phase === 'mistake';
        await select(page, exercise, mistake ? 'stretch' : phase, mistake);
        const bundles = await difference(page, 'none');
        assert(bundles > 0, exercise.slug + ' did not draw any target bundles');
        const total = await difference(page, 'all');
        const each = [];
        for (let i = 0; i < bundles; i++) each.push(await difference(page, i));
        await difference(page, 'none');
        console.log(JSON.stringify({ view: name, exercise: exercise.order, phase, total, each }));
        assert(total >= 12 && each.every(count => count > 0), name + ' ' + exercise.slug + '/' + phase + ': occluded target');
        if (commentView) assert(each.length === 2 && Math.min(...each) >= 50, 'Both lumbar bundles must be distinguishable');
        if (captures) await page.locator('.viewport-wrap').screenshot({
          path: path.join(captures, name + '-' + exercise.order + '-' + phase + '.jpg'), type: 'jpeg', quality: 88,
        });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

(async () => {
  if (captures) mkdirSync(captures, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });
  try {
    for (const layout of [['comment', 915, 953], ['desktop', 1440, 900], ['portrait', 390, 844], ['landscape', 844, 390]]) {
      await review(browser, ...layout);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
