// Multi-page scanning workflow (fast capture, deferred enhancement):
// camera/photo -> adjustable crop -> next page … -> review (all pages straightened + enhanced
// in the background) -> PDF. No waiting for image processing between pages.
import { PDFDocument } from 'pdf-lib';
import { h, icon, iconBtn, toast, busy, nextFrame, choose, confirmDlg, pickFiles, sheet, clear } from '../ui';
import { Screen } from '../nav';
import { cameraView, releaseCamera } from './camera';
import { cropView } from './crop';
import { Quad, insetQuad } from './geometry';
import { detectDocument } from './detect';
import { FILTERS, FilterKind, Adjust, warpPerspective, applyFilter, rotateCanvas, downscale, fileToCanvas } from './process';
import { canvasToBlob, PAGE_SIZES } from '../pdf';
import { OCR_LANGS, addTextLayer, getOcrLang, recognizeCanvas, setOcrLang } from '../ocr';

interface ScanPage {
  /** Original photo; JPEG encoding finishes in the background so capture never waits on it. */
  src: Promise<Blob>;
  srcW: number;
  srcH: number;
  quad: Quad;
  detected: boolean;
  rotation: number;
  filter: FilterKind;
  adjust: Adjust;
  /** Preview: straightened only until the page is enhanced, then the enhanced result. */
  thumb: string;
  /** Enhanced output, valid while `key` matches the page's current settings. */
  out?: { blob: Blob; key: string };
  failedKey?: string;
}

export interface ScanSessionOptions {
  start: 'camera' | 'photos';
  /** Title for the final button, e.g. "Save PDF" or "Insert pages" */
  finishLabel?: string;
  onComplete(bytes: Uint8Array, name: string): void | Promise<void>;
  onExit(): void;
}

const OUT_MAX = 2600;

async function blobToCanvas(b: Blob): Promise<HTMLCanvasElement> {
  return fileToCanvas(b, 8192);
}

const keyOf = (p: ScanPage) => JSON.stringify([p.quad, p.rotation, p.filter, p.adjust]);
const isDone = (p: ScanPage) => !!p.out && p.out.key === keyOf(p);
const needsWork = (p: ScanPage) => !isDone(p) && p.failedKey !== keyOf(p);

/** Cheap straightened preview made from a downscaled copy (a few milliseconds). */
function quickThumb(src: HTMLCanvasElement, quad: Quad, rotation: number): string {
  const small = downscale(src, 900);
  const k = small.width / src.width;
  const q = quad.map((pt) => ({ x: pt.x * k, y: pt.y * k })) as Quad;
  return rotateCanvas(warpPerspective(small, small.width, small.height, q, 320), rotation).toDataURL('image/jpeg', 0.7);
}

export function createScanSession(opts: ScanSessionOptions): Screen {
  const pages: ScanPage[] = [];
  let lastFilter: FilterKind = (localStorage.getItem('scanFilter') as FilterKind) || 'enhanced';
  const root = h('div', { class: 'scan-session' });
  const camHolder: { stream: MediaStream | null } = { stream: null };
  let cleanup: (() => void) | null = null;
  let finished = false;
  let onReviewChange: (() => void) | null = null;

  function show(el: HTMLElement, destroy?: () => void) {
    cleanup?.();
    cleanup = destroy || null;
    onReviewChange = null;
    clear(root);
    root.appendChild(el);
  }

  // ---------- background enhancement queue ----------
  let running: Promise<void> | null = null;
  let progressCb: ((done: number, total: number) => void) | null = null;

  function processAll(): Promise<void> {
    if (running) return running;
    running = (async () => {
      for (;;) {
        const p = pages.find(needsWork);
        if (!p) break;
        const key = keyOf(p);
        try {
          await nextFrame(); // let the UI paint between heavy steps
          const src = await blobToCanvas(await p.src);
          const warped = warpPerspective(src, src.width, src.height, p.quad, OUT_MAX);
          await nextFrame();
          const full = rotateCanvas(applyFilter(warped, p.filter, p.adjust), p.rotation);
          const blob = await canvasToBlob(full, 'image/jpeg', 0.9);
          if (keyOf(p) === key) {
            p.out = { blob, key };
            p.thumb = downscale(full, 300).toDataURL('image/jpeg', 0.7);
          }
        } catch (e) {
          console.error('enhance failed', e);
          p.failedKey = key;
          toast('Could not enhance a page — try adjusting its crop');
        }
        onReviewChange?.();
        progressCb?.(pages.filter(isDone).length, pages.length);
      }
    })().finally(() => {
      running = null;
      onReviewChange?.();
    });
    return running;
  }

  /** Wait until every page is enhanced (used before building the PDF). */
  async function waitForAll(report: (done: number, total: number) => void) {
    progressCb = report;
    try {
      while (pages.some(needsWork)) await processAll();
    } finally {
      progressCb = null;
    }
  }

  function addPage(src: HTMLCanvasElement, quad: Quad, detected: boolean, replaceIndex?: number) {
    const prev = replaceIndex !== undefined ? pages[replaceIndex] : undefined;
    const page: ScanPage = {
      src: canvasToBlob(src, 'image/jpeg', 0.92),
      srcW: src.width,
      srcH: src.height,
      quad,
      detected,
      rotation: 0,
      filter: prev?.filter || lastFilter,
      adjust: prev ? { ...prev.adjust } : { brightness: 0, contrast: 0 },
      thumb: quickThumb(src, quad, 0),
    };
    if (replaceIndex !== undefined) pages[replaceIndex] = page;
    else pages.push(page);
  }

  // ---------- step 1: acquire ----------
  function openCamera(replaceIndex?: number) {
    const cam = cameraView({
      pageNumber: replaceIndex !== undefined ? replaceIndex + 1 : pages.length + 1,
      keepAlive: camHolder,
      onCapture: (c) => {
        cam.stop();
        startCrop(c, replaceIndex);
      },
      onGallery: () => {
        cam.stop();
        fromPhotos(replaceIndex);
      },
      onClose: () => {
        cam.stop();
        if (pages.length) showReview();
        else exit();
      },
    });
    show(cam.el, cam.stop);
  }

  async function fromPhotos(replaceIndex?: number) {
    const files = await pickFiles('image/*', replaceIndex === undefined);
    if (!files.length) {
      if (pages.length) showReview();
      else if (opts.start === 'camera') openCamera();
      else exit();
      return;
    }
    const queue = files.slice();
    const nextFile = async () => {
      const f = queue.shift();
      if (!f) {
        if (replaceIndex !== undefined) showReview();
        else askNext();
        return;
      }
      const b = busy('Loading photo…');
      try {
        const c = await fileToCanvas(f);
        b.done();
        startCrop(c, replaceIndex, () => nextFile(), queue.length ? 'Next photo' : 'Use photo');
      } catch (e: any) {
        b.done();
        toast(e?.message || 'Could not open that image');
        nextFile();
      }
    };
    await nextFile();
  }

  // ---------- step 2: crop (the only per-page step) ----------
  function startCrop(src: HTMLCanvasElement, replaceIndex?: number, afterKeep?: () => void, keepLabel?: string, existing?: ScanPage, init?: { quad: Quad; detected: boolean }) {
    let quad: Quad;
    let detected = false;
    if (init || existing) {
      quad = (init || existing)!.quad;
      detected = (init || existing)!.detected;
    } else {
      const q = detectDocument(src, src.width, src.height, 420);
      detected = !!q;
      quad = q || insetQuad(src.width, src.height, 0.05);
    }
    const fromCamera = !afterKeep && !existing && replaceIndex === undefined;
    const cv = cropView({
      source: src,
      quad,
      detected,
      pageNumber: replaceIndex !== undefined ? replaceIndex + 1 : pages.length + 1,
      onRetake: existing || init || afterKeep ? undefined : () => openCamera(replaceIndex),
      onCancel: () => {
        if (afterKeep) afterKeep();
        else if (pages.length) showReview();
        else exit();
      },
      // Camera: offer "Next page" right here so capturing many pages is one tap each.
      secondary: fromCamera ? { label: 'Next page', icon: 'camera', onClick: (q) => { addPage(src, q, detected); openCamera(); } } : undefined,
      doneLabel: existing ? undefined : fromCamera ? `Done (${pages.length + 1})` : keepLabel || (replaceIndex !== undefined ? 'Use this' : undefined),
      onDone: (q) => {
        if (existing) return startFilter(src, q, detected, replaceIndex!, existing);
        addPage(src, q, detected, replaceIndex);
        if (afterKeep) afterKeep();
        else showReview();
      },
    });
    show(cv.el, cv.destroy);
  }

  // ---------- fine-tune one page (from the review screen) ----------
  async function startFilter(src: HTMLCanvasElement, quad: Quad, detected: boolean, index: number, existing: ScanPage) {
    const b = busy('Straightening page…');
    await nextFrame();
    const warped = warpPerspective(src, src.width, src.height, quad, OUT_MAX);
    b.done();
    const prevBase = downscale(warped, 1100);
    let filter: FilterKind = existing.filter;
    let rotation = existing.rotation;
    const adjust: Adjust = { ...existing.adjust };

    const previewCanvas = h('canvas', { class: 'filter-preview' });
    const chips = h('div', { class: 'chips' });
    const renderChips = () => {
      clear(chips);
      FILTERS.forEach((f) =>
        chips.appendChild(h('button', { class: 'chip' + (f.id === filter ? ' on' : ''), onclick: () => { filter = f.id; renderChips(); refresh(); } }, f.label)),
      );
    };
    renderChips();
    let pending = 0;
    const refresh = () => {
      const token = ++pending;
      requestAnimationFrame(() => {
        if (token !== pending) return;
        const out = rotateCanvas(applyFilter(prevBase, filter, adjust), rotation);
        previewCanvas.width = out.width;
        previewCanvas.height = out.height;
        previewCanvas.getContext('2d')!.drawImage(out, 0, 0);
      });
    };
    const slider = (label: string, key: keyof Adjust) => {
      const val = h('span', { class: 'slider-val' }, String(adjust[key]));
      const input = h('input', { type: 'range', min: -100, max: 100, step: 1, value: adjust[key] }) as HTMLInputElement;
      input.value = String(adjust[key]);
      input.addEventListener('input', () => {
        adjust[key] = Number(input.value);
        val.textContent = input.value;
        refresh();
      });
      return h('label', { class: 'slider' }, h('span', null, label), input, val);
    };
    const adjustPanel = h('div', { class: 'adjust-panel hidden' }, slider('Brightness', 'brightness'), slider('Contrast', 'contrast'));

    const keep = async () => {
      const bb = busy('Enhancing page…');
      await nextFrame();
      try {
        const full = rotateCanvas(applyFilter(warped, filter, adjust), rotation);
        const blob = await canvasToBlob(full, 'image/jpeg', 0.9);
        Object.assign(existing, { quad, detected, rotation, filter, adjust, thumb: downscale(full, 300).toDataURL('image/jpeg', 0.7) });
        existing.out = { blob, key: keyOf(existing) };
        pages[index] = existing;
      } finally {
        bb.done();
      }
      showReview();
    };

    const el = h(
      'div',
      { class: 'filter-screen' },
      h('div', { class: 'top-bar dark' },
        h('button', { class: 'icon-btn', 'aria-label': 'Back to crop', onclick: () => startCrop(src, index, undefined, undefined, existing, { quad, detected }) }, icon('back')),
        h('div', { class: 'top-title' }, `Enhance page ${index + 1}`),
        h('div', { class: 'spacer-btn' }),
      ),
      h('div', { class: 'filter-stage' }, previewCanvas),
      h('div', { class: 'filter-controls' },
        chips,
        adjustPanel,
        h('div', { class: 'crop-actions' },
          h('button', { class: 'tool-btn light', onclick: () => { rotation = (rotation + 3) % 4; refresh(); } }, icon('rotl'), h('span', null, 'Left')),
          h('button', { class: 'tool-btn light', onclick: () => { rotation = (rotation + 1) % 4; refresh(); } }, icon('rotr'), h('span', null, 'Right')),
          h('button', { class: 'tool-btn light', onclick: () => adjustPanel.classList.toggle('hidden') }, icon('sliders'), h('span', null, 'Adjust')),
          h('button', { class: 'btn primary next-btn', onclick: keep }, icon('check', 18), 'Update'),
        ),
      ),
    );
    show(el);
    refresh();
  }

  // ---------- after a batch of photos: prompt for more pages ----------
  async function askNext() {
    showReview();
    const n = pages.length;
    const choice = await choose(
      `${n} page${n > 1 ? 's' : ''} added`,
      [
        { label: 'Scan more with camera', value: 'camera', icon: 'camera', desc: 'Continue with page ' + (n + 1) },
        { label: 'Add more photos', value: 'photos', icon: 'image', desc: 'Pick one or more pictures' },
        { label: `Done — review ${n} page${n > 1 ? 's' : ''}`, value: 'done', icon: 'check' },
      ],
      'Is this a multi-page document? Add more pages or finish.',
    );
    if (choice === 'camera') openCamera();
    else if (choice === 'photos') fromPhotos();
  }

  // ---------- review (enhancement runs here, in the background) ----------
  function showReview() {
    releaseCamera(camHolder);
    const grid = h('div', { class: 'thumb-grid' });
    const status = h('p', { class: 'hint-line' });
    const chips = h('div', { class: 'chips' });
    const saveBtn = h('button', { class: 'btn primary', onclick: () => finish() }, icon('save', 18), opts.finishLabel || 'Save PDF') as HTMLButtonElement;

    const renderChips = () => {
      clear(chips);
      const current = pages.length && pages.every((p) => p.filter === pages[0].filter) ? pages[0].filter : null;
      FILTERS.forEach((f) =>
        chips.appendChild(h('button', { class: 'chip' + (f.id === current ? ' on' : ''), onclick: () => {
          lastFilter = f.id;
          localStorage.setItem('scanFilter', f.id);
          pages.forEach((p) => (p.filter = f.id));
          render();
          processAll();
        } }, f.label)),
      );
    };
    const render = () => {
      clear(grid);
      pages.forEach((p, i) => {
        const done = isDone(p);
        grid.appendChild(
          h('button', { class: 'thumb' + (done ? '' : ' pending'), onclick: () => pageMenu(i) },
            h('img', { src: p.thumb, alt: `Page ${i + 1}` }),
            h('span', { class: 'thumb-num' }, String(i + 1)),
            done || p.failedKey === keyOf(p) ? null : h('div', { class: 'spinner thumb-spinner' }),
          ),
        );
      });
      grid.appendChild(h('button', { class: 'thumb add', onclick: () => addMore() }, icon('plus', 32), h('span', null, 'Add page')));
      const left = pages.filter(needsWork).length;
      status.textContent = left
        ? `Enhancing pages… ${pages.length - left} of ${pages.length} done. You can keep working meanwhile.`
        : 'Tap a page to re-crop, fine-tune, rotate, reorder or delete.';
      saveBtn.disabled = !pages.length;
      renderChips();
    };

    const el = h(
      'div',
      { class: 'review-screen' },
      h('div', { class: 'top-bar' },
        iconBtn('back', 'Back', () => exit()),
        h('div', { class: 'top-title' }, `Scanned pages (${pages.length})`),
        h('div', { class: 'spacer-btn' }),
      ),
      h('div', { class: 'review-filters' }, h('div', { class: 'label' }, 'Enhancement for all pages'), chips),
      status,
      grid,
      h('div', { class: 'bottom-bar' },
        h('button', { class: 'btn', onclick: () => addMore() }, icon('plus', 18), 'Add page'),
        saveBtn,
      ),
    );
    show(el);
    onReviewChange = render;
    render();
    processAll();
  }

  async function addMore() {
    const c = await choose('Add page', [
      { label: 'Camera', value: 'camera', icon: 'camera' },
      { label: 'Photos', value: 'photos', icon: 'image' },
    ]);
    if (c === 'camera') openCamera();
    else if (c === 'photos') fromPhotos();
  }

  async function pageMenu(i: number) {
    const p = pages[i];
    const c = await choose(`Page ${i + 1}`, [
      { label: 'Adjust crop & fine-tune', value: 'edit', icon: 'crop', desc: 'Filter, brightness, contrast' },
      { label: 'Rotate', value: 'rotate', icon: 'rotr' },
      { label: 'Retake with camera', value: 'retake', icon: 'camera' },
      { label: 'Move earlier', value: 'up', icon: 'left' },
      { label: 'Move later', value: 'down', icon: 'right' },
      { label: 'Delete page', value: 'del', icon: 'trash', danger: true },
    ]);
    if (c === 'edit') {
      const b = busy('Loading…');
      const src = await blobToCanvas(await p.src);
      b.done();
      startCrop(src, i, undefined, undefined, p);
    } else if (c === 'rotate') {
      p.rotation = (p.rotation + 1) % 4;
      showReview();
    } else if (c === 'retake') openCamera(i);
    else if (c === 'up' && i > 0) {
      [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
      showReview();
    } else if (c === 'down' && i < pages.length - 1) {
      [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
      showReview();
    } else if (c === 'del') {
      pages.splice(i, 1);
      showReview();
    }
  }

  // ---------- step 6: build PDF ----------
  function finish() {
    const d = new Date();
    const defName = `Scan ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`.replace(/\//g, '-');
    const nameIn = h('input', { class: 'field', type: 'text', value: defName }) as HTMLInputElement;
    nameIn.value = defName;
    const sizeSel = h('select', { class: 'field' },
      h('option', { value: 'auto' }, 'Fit to scan'),
      h('option', { value: 'letter' }, 'US Letter'),
      h('option', { value: 'a4' }, 'A4'),
      h('option', { value: 'legal' }, 'US Legal'),
    ) as HTMLSelectElement;
    sizeSel.value = localStorage.getItem('scanPageSize') || 'auto';
    const qualSel = h('select', { class: 'field' },
      h('option', { value: 'high' }, 'High quality'),
      h('option', { value: 'medium' }, 'Balanced'),
      h('option', { value: 'small' }, 'Smallest file'),
    ) as HTMLSelectElement;
    qualSel.value = localStorage.getItem('scanQuality') || 'medium';
    const ocrChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    ocrChk.checked = localStorage.getItem('scanOcr') !== '0';
    const langSel = h('select', { class: 'field' }, OCR_LANGS.map((l) => h('option', { value: l.code }, l.label))) as HTMLSelectElement;
    langSel.value = getOcrLang();

    const s = sheet('Save scanned document', [
      h('label', { class: 'form-row' }, h('span', null, 'Name'), nameIn),
      h('label', { class: 'form-row' }, h('span', null, 'Page size'), sizeSel),
      h('label', { class: 'form-row' }, h('span', null, 'Quality'), qualSel),
      h('label', { class: 'check-row' }, ocrChk, h('span', null, 'Make text searchable & selectable (OCR)')),
      h('label', { class: 'form-row' }, h('span', null, 'OCR language'), langSel),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => s.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          s.close();
          localStorage.setItem('scanPageSize', sizeSel.value);
          localStorage.setItem('scanQuality', qualSel.value);
          localStorage.setItem('scanOcr', ocrChk.checked ? '1' : '0');
          setOcrLang(langSel.value);
          await build(nameIn.value.trim() || defName, sizeSel.value, qualSel.value, ocrChk.checked, langSel.value);
        } }, opts.finishLabel || 'Save PDF'),
      ),
    ]);
  }

  async function build(name: string, size: string, quality: string, ocr: boolean, lang: string) {
    const b = busy('Enhancing pages…');
    try {
      await waitForAll((done, total) => b.update(`Enhancing pages… ${done} of ${total}`));
      const bad = pages.filter((p) => !isDone(p)).length;
      if (bad) throw new Error(`${bad} page(s) could not be enhanced — re-crop or delete them`);
      b.update('Building PDF…');
      const doc = await PDFDocument.create();
      doc.setTitle(name);
      doc.setProducer('PocketPDF');
      doc.setCreator('PocketPDF scanner');
      const maxDim = quality === 'high' ? 2600 : quality === 'medium' ? 2000 : 1400;
      const q = quality === 'high' ? 0.9 : quality === 'medium' ? 0.82 : 0.68;
      let ocrFailed = false;
      for (let i = 0; i < pages.length; i++) {
        b.update(`Building page ${i + 1} of ${pages.length}…`);
        await nextFrame();
        const p = pages[i];
        let canvas = await blobToCanvas(p.out!.blob);
        canvas = downscale(canvas, maxDim);
        const jpg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', q)).arrayBuffer());
        const img = await doc.embedJpg(jpg);
        const iw = canvas.width, ih = canvas.height;
        let pw: number, ph: number;
        if (size === 'auto') {
          const long = 792;
          if (ih >= iw) { ph = long; pw = (long * iw) / ih; } else { pw = long; ph = (long * ih) / iw; }
        } else {
          const [a, c] = PAGE_SIZES[size];
          [pw, ph] = iw > ih ? [c, a] : [a, c];
        }
        const page = doc.addPage([pw, ph]);
        const s = Math.min(pw / iw, ph / ih);
        const dw = iw * s, dh = ih * s, dx = (pw - dw) / 2, dy = (ph - dh) / 2;
        page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
        if (ocr && !ocrFailed) {
          try {
            b.update(`Recognizing text on page ${i + 1} of ${pages.length}…`);
            const res = await recognizeCanvas(canvas, lang, (pr, st) => {
              if (st.includes('loading') || st.includes('initializ')) b.update(`Preparing OCR (${Math.round(pr * 100)}%)…`);
              else b.update(`Recognizing text on page ${i + 1} of ${pages.length} (${Math.round(pr * 100)}%)…`);
            });
            await addTextLayer(doc, page, res.words, (x, y) => [dx + x * s, dy + dh - y * s]);
          } catch (e) {
            console.warn('OCR failed', e);
            ocrFailed = true;
          }
        }
      }
      const bytes = await doc.save();
      b.done();
      if (ocrFailed) toast('Saved without OCR (text recognition needs a one-time download — check your connection).', 4500);
      finished = true;
      await opts.onComplete(bytes, name);
    } catch (e: any) {
      b.done();
      console.error(e);
      toast('Could not build the PDF: ' + (e?.message || e));
    }
  }

  function exit() {
    opts.onExit();
  }

  // kick off
  setTimeout(() => (opts.start === 'camera' ? openCamera() : fromPhotos()), 0);

  return {
    el: root,
    destroy: () => {
      cleanup?.();
      releaseCamera(camHolder);
    },
    canLeave: async () => {
      if (finished || !pages.length) return true;
      return confirmDlg('Discard scan?', `You have ${pages.length} scanned page(s) that haven't been saved.`, 'Discard', true);
    },
  };
}
