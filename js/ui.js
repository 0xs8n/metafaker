/**
 * ui.js - Application state, UI rendering, and the main App controller.
 *
 * Manages the image queue, preview, metadata display, and local-only actions
 * for randomizing, stripping, and downloading processed JPEGs.
 */

import {
  fmtBytes, escapeHtml, makeId, rnd,
  stripViaCanvas, makePreviewBlob, insertAfterSoi, iccApp2Segment,
} from './helpers.js';
import { dumpExifSafe } from './exif-writer.js';
import { buildXmpPacket, xmpSegment, buildPhotoshopApp13 } from './provenance.js';
import {
  generateFake, generateGraphic, readBackExifStrict,
  parseFileExif, readUserComment, renderMeta,
} from './exif.js';
import { classifyInput, sniffFormat, measureContent } from './classify.js';
import { ICONS } from './icons.js';

/** Wrap a serialised TIFF block ("Exif\0\0" + data) as an APP1 segment. */
function exifApp1Segment(tiffStr) {
  const len = tiffStr.length + 2;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xFF; seg[1] = 0xE1;
  seg[2] = (len >> 8) & 0xFF; seg[3] = len & 0xFF;
  for (let i = 0; i < tiffStr.length; i++) seg[4 + i] = tiffStr.charCodeAt(i) & 0xFF;
  return seg;
}

export const S = {
  items: [],
  activeId: null,
  tab: 'orig',
  fieldCounts: { orig: 0 },
  busy: false,   // a batch run is in progress; actions that would race it are refused
  run: 0,        // bumped by reset(), which cancels a running batch
};

function createItem(file) {
  return {
    id: makeId(),
    file,
    previewUrl: '',
    origExif: {},
    modBlob: null,
    modPreviewUrl: '',
    fakeExif: null,
    fakePiexif: null,
    fakeCamera: null,
    fakeLocation: null,
    inputClass: { isPhoto: true, kind: 'photo', reason: '' },
    error: null,
    processing: false,
  };
}

/**
 * Decode an image once to read the content signals the classifier uses and to
 * make the small copy the page displays. Resolves { content, preview }; both
 * are null when the browser cannot decode the file here (HEIC in Chrome, SVG).
 */
async function readImageInfo(file) {
  if (typeof createImageBitmap !== 'function') return { content: null, preview: null };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return { content: null, preview: null }; }
  try {
    let content = null, preview = null;
    try { content = measureContent(bmp); } catch { content = null; }
    try { preview = await makePreviewBlob(bmp); } catch { preview = null; }
    return { content, preview };
  } finally {
    if (bmp.close) bmp.close();
  }
}

/** The file's real format, from its first bytes. */
async function readFormat(file) {
  try { return sniffFormat(new Uint8Array(await file.slice(0, 1024).arrayBuffer())); }
  catch { return 'unknown'; }
}

function getItem(id) {
  return S.items.find(item => item.id === id) || null;
}

function getActiveItem() {
  return getItem(S.activeId);
}

function getProcessedItems() {
  return S.items.filter(item => item.modBlob);
}

function getDisplayUrl(item) {
  return item?.modPreviewUrl || item?.previewUrl || '';
}

function hasProcessedOutput(item) {
  return !!item?.modBlob;
}

/** A random hex stem carrying no time information, for an output with no generated capture date to name itself after. */
function randomStem(n = 8) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * 16)];
  return s;
}

/**
 * The name Camera Raw or Lightroom gives an export: the source file's own stem
 * with a lowercase .jpg extension. A photo's source file is the generated one
 * its XMP records as crs:RawFileName (DSC_4821.NEF, PXL_20240612_141503123.jpg,
 * IMG_0734.jpg …), so the download name and the metadata tell the same story.
 * The user's real filename is never used. Uppercase .JPG is what the camera
 * writes, not what an editor writes.
 *
 * A metadata-stripped file carries no EXIF timestamp to echo, so naming it
 * from a date (even a generated one) would assert a capture time the file
 * doesn't have, and the only date actually available then would be the real
 * clock the tool ran on. It gets a random, time-free stem instead
 * (`processClearItem` sets `fakeStem` for exactly this reason). The fallback
 * below only runs if some future caller forgets to set a stem.
 */
/**
 * The original's capture date and time, as its camera's clock wrote them.
 * exifr revives EXIF dates as local Date objects whose fields are that wall
 * clock; a string that slipped through unrevived is read the same way.
 * ModifyDate is the last resort: it names the last save, not the capture.
 */
function originalCaptureDate(exif) {
  const raw = exif && (exif.DateTimeOriginal || exif.CreateDate || exif.DateTimeDigitized || exif.ModifyDate || exif.DateTime);
  if (raw instanceof Date) return isNaN(raw) ? null : raw;
  const m = typeof raw === 'string' && raw.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const KEEP_DATE_DROPPED = {
  missing: 'its metadata carries no capture date to keep',
  old: 'its original date is older than every camera the tool can name',
  future: 'its original date and time have not happened yet in a US time zone',
};

function getOutputName(item) {
  if (item?.fakeStem) return `${item.fakeStem}.jpg`;
  return `img_${randomStem()}.jpg`;
}

function releaseItemResources(item) {
  if (!item?.previewUrl || !window.URL?.revokeObjectURL) return;
  try { window.URL.revokeObjectURL(item.previewUrl); } catch (e) {}
  item.previewUrl = '';
}

function releaseProcessedResources(item) {
  if (item?.modPreviewUrl && window.URL?.revokeObjectURL) {
    try { window.URL.revokeObjectURL(item.modPreviewUrl); } catch (e) {}
  }
  item.modPreviewUrl = '';
  item.modBlob = null;
}

function describeItemStatus(item) {
  if (!item) return { text: 'Idle', className: '' };
  if (item.processing) return { text: 'Processing', className: 'processing' };
  if (item.error) return { text: 'Error', className: 'error' };
  if (hasProcessedOutput(item) && item.fakeExif) return { text: 'Randomized', className: 'ready' };
  if (hasProcessedOutput(item)) return { text: 'Stripped', className: 'ready' };
  return { text: 'Loaded', className: '' };
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast-${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

function setBadge(type, text) {
  const b = document.getElementById('metaBadge');
  if (!b) return;
  b.className = `badge badge-${type}`;
  b.textContent = text;
}

function setTabs() {
  const origTab = document.getElementById('tabOrig');
  if (origTab) origTab.classList.toggle('active', true);
}

function updateTabCounts() {
  const current = getActiveItem();
  const displayExif = current?.fakeExif || current?.origExif;
  S.fieldCounts.orig = displayExif && Object.keys(displayExif).length
    ? renderMeta(displayExif, !!current?.fakeExif).count
    : 0;
  const origEl = document.getElementById('countOrig');
  if (origEl) origEl.textContent = S.fieldCounts.orig || '0';
}

function renderBatchStrip() {
  const strip = document.getElementById('batchStrip');
  const summary = document.getElementById('batchSummary');
  const count = document.getElementById('batchCount');
  if (!strip || !summary || !count) return;

  count.textContent = S.items.length;

  if (!S.items.length) {
    summary.textContent = 'No images loaded yet.';
    strip.innerHTML = '';
    return;
  }

  const processed = getProcessedItems().length;
  summary.textContent = `${S.items.length} image${S.items.length === 1 ? '' : 's'} queued | ${processed} processed`;

  const lightBatchMode = S.items.length > 24;

  strip.innerHTML = S.items.map(item => {
    const status = describeItemStatus(item);
    const displayUrl = getDisplayUrl(item);
    const canRenderThumb = !!displayUrl && (!lightBatchMode || item.id === S.activeId);
    const thumb = canRenderThumb
      ? `<img class="batch-thumb" loading="lazy" decoding="async" src="${displayUrl}" alt="${escapeHtml(item.file.name)}">`
      : `<div class="batch-thumb-empty">${ICONS.image}</div>`;

    return `
      <div class="batch-item${item.id === S.activeId ? ' active' : ''}" data-id="${escapeHtml(item.id)}">
        ${thumb}
        <div class="batch-item-body">
          <div class="batch-item-name">${escapeHtml(item.file.name)}</div>
          <div class="batch-status">
            <span class="batch-status-tag ${status.className}">${status.text}</span>
            <span class="batch-status-meta">${fmtBytes(item.file.size)}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function updateActionButtons() {
  const current = getActiveItem();
  const hasCurrent = !!current;
  const hasOutput = hasProcessedOutput(current);
  const anyProcessing = S.items.some(item => item.processing);

  const btnRandom = document.getElementById('btnRandom');
  const btnClear = document.getElementById('btnClear');
  const btnRandomAll = document.getElementById('btnRandomAll');
  const btnDownload = document.getElementById('btnDownload');
  const btnDownloadAll = document.getElementById('btnDownloadAll');

  if (btnRandom) btnRandom.disabled = S.busy || !hasCurrent || current.processing;
  if (btnClear) btnClear.disabled = S.busy || !hasCurrent || current.processing;
  if (btnRandomAll) btnRandomAll.disabled = S.busy || !S.items.length || anyProcessing;
  if (btnDownload) btnDownload.disabled = !hasOutput;
  if (btnDownloadAll) btnDownloadAll.disabled = !getProcessedItems().length;
}

function renderActiveTab() {
  const body = document.getElementById('metaBody');
  const current = getActiveItem();
  if (!body) return;

  if (!current) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon">${ICONS.image}</div><p>Select one or more images to begin.</p></div>`;
    setBadge('none', 'No image');
    updateTabCounts();
    setTabs();
    updateActionButtons();
    return;
  }

  if (hasProcessedOutput(current) && !current.fakeExif) {
    const stripNote = (current.inputClass && !current.inputClass.isPhoto)
      ? `This looks like ${current.inputClass.kind === 'graphic' ? 'a graphic' : 'a screenshot'}, not a camera photo, so no camera details were added. Its metadata was removed instead.`
      : `Metadata was stripped from this image.`;
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon">${ICONS.clean}</div><p>${escapeHtml(stripNote)}</p></div>`;
    S.fieldCounts.orig = 0;
    setBadge('cleared', 'Cleared');
  } else if (current.fakeExif) {
    const res = renderMeta(current.fakeExif, true);
    body.innerHTML = res.html;
    S.fieldCounts.orig = res.count;
    setBadge('fake', 'Randomized');
  } else if (!current.origExif || Object.keys(current.origExif).length === 0) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon">${ICONS.camera}</div><p>No EXIF metadata found.</p></div>`;
    S.fieldCounts.orig = 0;
    setBadge('original', 'Original');
  } else {
    const res = renderMeta(current.origExif, false);
    body.innerHTML = res.html;
    S.fieldCounts.orig = res.count;
    setBadge('original', 'Original');
  }

  updateTabCounts();
  setTabs();
  updateActionButtons();
}

function renderCurrentItem() {
  const current = getActiveItem();
  const grid = document.getElementById('contentGrid');
  const previewImg = document.getElementById('previewImg');
  const previewName = document.getElementById('previewName');
  const previewMeta = document.getElementById('previewMeta');

  renderBatchStrip();

  if (!current) {
    if (grid) grid.style.display = 'none';
    renderActiveTab();
    return;
  }

  if (grid) grid.style.display = 'grid';
  if (previewImg) previewImg.src = getDisplayUrl(current);
  if (previewName) previewName.textContent = current.file.name;
  if (previewMeta) {
    previewMeta.textContent = `${fmtBytes(current.file.size)} | ${current.file.type || 'image'} | ${describeItemStatus(current).text}`;
  }

  renderActiveTab();
}

async function hydrateItem(file, format) {
  const item = createItem(file);
  item.processing = true;
  item.format = format;
  item.origExif = await parseFileExif(file);
  const info = await readImageInfo(file);
  // SVG has no bitmap decode here, but an <img> shows it at any size.
  item.previewUrl = URL.createObjectURL(info.preview || file);
  item.inputClass = classifyInput({ format, exif: item.origExif, userComment: await readUserComment(file), content: info.content });
  item.processing = false;
  return item;
}

const IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'avif', 'heic', 'svg']);

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

/**
 * Render the pixel container and wrap the four Adobe metadata segments around
 * it (Exif, Photoshop APP13, ICC, XMP), the same way for a photo and for
 * an exported graphic. `fake` is a generateFake or generateGraphic result;
 * `pixelCam` drives the pixel pipeline (camera colour for a photo, {} for a
 * graphic). Returns { verified, preview, width, height }.
 */
async function assembleAdobeExport(item, fake, pixelCam) {
  const canvasResult = await stripViaCanvas(item.file, { ...pixelCam, thumbnail: true });
  const px = window.piexif;

  const thumb = canvasResult.thumb;
  if (thumb) {
    fake.piexif.thumbnail = thumb.binary;
    fake.piexif['1st'][px.ImageIFD.Compression]    = 6;
    fake.piexif['1st'][px.ImageIFD.XResolution]    = [72, 1];
    fake.piexif['1st'][px.ImageIFD.YResolution]    = [72, 1];
    fake.piexif['1st'][px.ImageIFD.ResolutionUnit] = 2;
  }

  const tiff = dumpExifSafe(fake.piexif, px, { littleEndian: true });
  const exifApp1 = exifApp1Segment(tiff);
  const app13 = buildPhotoshopApp13({
    dpi: fake.editor.dpi, capture: fake.capture, offset: fake.offset || '+00:00',
    thumb: thumb ? thumb.bytes : null,
    thumbWidth: thumb ? thumb.width : 0, thumbHeight: thumb ? thumb.height : 0,
  });
  const xmp = xmpSegment(buildXmpPacket({
    capture: fake.capture, exportAt: fake.exportAt,
    offsetCapture: fake.offset, offsetExport: fake.exportOffset, subsec: fake.subsec,
    lens: fake.lensMeta, editor: fake.editor, source: fake.source, scene: fake.scene, aux: fake.aux,
    crop: canvasResult.crop,
  }));
  const out = insertAfterSoi(canvasResult.bytes, [exifApp1, app13, iccApp2Segment(), xmp]);
  const verified = await readBackExifStrict(out);
  return { verified, preview: canvasResult.preview, width: canvasResult.width, height: canvasResult.height };
}

function setOutput(item, blob, preview) {
  releaseProcessedResources(item);
  item.modBlob = blob;
  item.modPreviewUrl = URL.createObjectURL(preview || blob);
}

/**
 * A non-photo (screenshot, graphic) written as an Adobe-exported graphic:
 * editor provenance only, no camera, no lens, no exposure, no GPS. One of two
 * non-photo outputs; the other is the plain clean strip. Varying them keeps
 * stripped non-photos from all sharing one blank signature.
 */
async function processGraphicItem(item, options = {}) {
  const { deferRender = false } = options;
  item.processing = true;
  item.error = null;
  if (!deferRender) renderCurrentItem();
  try {
    const fake = generateGraphic();
    const { verified, preview } = await assembleAdobeExport(item, fake, { minimal: true });
    setOutput(item, verified.blob, preview);
    item.fakeExif = { ...verified.exif };      // editor provenance, no camera, no GPS
    item.fakePiexif = fake.piexif;
    item.fakeCamera = null;
    item.fakeStem = fake.source.fileName.replace(/\.[^.]+$/, '');
    item.fakeDate = fake.capture;
    item.fakeLocation = null;
  } catch (e) {
    item.error = e.message;
    releaseProcessedResources(item);
    item.fakeExif = null; item.fakePiexif = null; item.fakeCamera = null; item.fakeStem = null; item.fakeLocation = null;
    throw e;
  } finally {
    item.processing = false;
    if (!deferRender) renderCurrentItem();
  }
}

async function processRandomizeItem(item, options = {}) {
  // quiet: a batch reports once at the end instead of per image, so its
  // summary is not buried under one notice per file.
  const { deferRender = false, quiet = false } = options;

  // A screenshot or exported graphic never passed through a lens, so giving it
  // a camera, lens, exposure and GPS would make it inconsistent with what it
  // is. The honest output is a file with no camera information — which is what
  // a real shared screenshot looks like — so the randomize path cleans it
  // instead, in one of the two ways below.
  if (!item.inputClass?.isPhoto) {
    // Two non-photo outputs, chosen at random so they do not all share one
    // signature: a plain clean strip, or an Adobe-exported graphic carrying
    // editor provenance only. Neither invents a camera, a lens or GPS.
    if (rnd() < 0.45) await processClearItem(item, { deferRender });
    else              await processGraphicItem(item, { deferRender });
    if (!quiet) {
      const what = item.inputClass?.kind === 'graphic' ? 'a graphic' : 'a screenshot';
      const why = item.inputClass?.reason ? ` (${item.inputClass.reason})` : '';
      showToast(`${item.file.name} looks like ${what}, not a camera photo${why}. It was cleaned of camera, lens and location details rather than given new camera metadata.`, 'warning');
    }
    return;
  }

  item.processing = true;
  item.error = null;
  if (!deferRender) renderCurrentItem();

  try {
    const keepDate = !!document.getElementById('chkKeepDate')?.checked;
    const originalDate = keepDate ? originalCaptureDate(item.origExif) : null;

    const fake = generateFake({ originalDate });
    item.keepDateDropped = keepDate ? (originalDate ? fake.keepDateDropped : 'missing') : null;
    // Render the pixel container and wrap the Adobe metadata segments around it.
    const { verified, preview, width, height } = await assembleAdobeExport(item, fake, { ...fake.cam, iso: fake.display.ISO });
    fake.display.PixelXDimension = width;
    fake.display.PixelYDimension = height;

    setOutput(item, verified.blob, preview);
    item.fakeExif = {
      ...verified.exif,
      GPSLatitude:    fake.loc.lat,
      GPSLongitude:   fake.loc.lon,
      GPSAltitude:    fake.display.GPSAltitude,
      GPSLatitudeRef: fake.loc.lat >= 0 ? 'N' : 'S',
      GPSLongitudeRef: fake.loc.lon >= 0 ? 'E' : 'W',
    };
    item.fakePiexif = fake.piexif;
    item.fakeCamera = fake.cam;
    item.fakeDate   = fake.capture;
    item.fakeSubSec = fake.subsec;
    item.fakeStem   = fake.source.fileName.replace(/\.[^.]+$/, '');
    item.fakeLocation = { ...fake.loc };

    const locTxt = item.fakeLocation?.city ? ` | ${item.fakeLocation.city}` : '';
    if (verified.warning) {
      showToast(`${verified.warning} Some sites strip metadata on upload.`, 'warning');
    } else if (item.keepDateDropped && !quiet) {
      showToast(`${item.file.name}: ${KEEP_DATE_DROPPED[item.keepDateDropped]}, so a new date was generated instead.`, 'warning');
    } else if (!quiet) {
      showToast(`Randomized ${item.file.name}${locTxt}`, 'info');
    }
  } catch (e) {
    item.error = e.message;
    releaseProcessedResources(item);
    item.fakeExif = null;
    item.fakePiexif = null;
    item.fakeCamera = null; item.fakeStem = null;
    item.fakeLocation = null;
    throw e;
  } finally {
    item.processing = false;
    if (!deferRender) renderCurrentItem();
  }
}

async function processClearItem(item, options = {}) {
  const { deferRender = false } = options;
  item.processing = true;
  item.error = null;
  if (!deferRender) renderCurrentItem();

  try {
    // The export with its metadata removed: no Exif, no XMP, no ICC profile,
    // Adobe's APP14 left in place, which is what `exiftool -all=` leaves on a
    // Camera Raw export. A real photo keeps the full privacy pixel pipeline
    // (the sensor-pattern protection still applies); a non-photo uses the
    // light path, since a screenshot has no sensor fingerprint to remove.
    const canvasResult = await stripViaCanvas(item.file, { minimal: !item.inputClass?.isPhoto });
    setOutput(item, new Blob([canvasResult.bytes], { type: 'image/jpeg' }), canvasResult.preview);
    item.fakeExif = null;
    item.fakePiexif = null;
    item.fakeCamera = null;
    // No EXIF survives the strip, so the download name carries no date either
    // — a random stem, not the real clock the tool ran on.
    item.fakeStem = `img_${randomStem()}`;
    item.fakeLocation = null;
    showToast(`Metadata stripped from ${item.file.name}.`, 'success');
  } catch (e) {
    item.error = e.message;
    releaseProcessedResources(item);
    throw e;
  } finally {
    item.processing = false;
    if (!deferRender) renderCurrentItem();
  }
}

export const App = {
  async loadFiles(filesLike) {
    // Decide by the file's bytes, not its MIME type: Windows Chrome reports no
    // type at all for .heic files and for images without an extension.
    const all = Array.from(filesLike || []);
    const files = [], skipped = [];
    for (const file of all) {
      const format = await readFormat(file);
      if (IMAGE_FORMATS.has(format)) files.push({ file, format });
      else skipped.push(file.name);
    }
    if (skipped.length) {
      const list = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '');
      showToast(`Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'} that ${skipped.length === 1 ? 'is' : 'are'} not a supported image: ${list}.`, 'warning');
    }
    if (!files.length) return;

    const grid = document.getElementById('contentGrid');
    if (grid) grid.style.display = 'grid';

    let added = 0;
    const renderEvery = files.length > 20 ? 8 : files.length > 8 ? 4 : 1;

    for (const { file, format } of files) {
      try {
        const item = await hydrateItem(file, format);
        S.items.push(item);
        S.activeId = item.id;
        added++;
        if (added === 1 || added === files.length || added % renderEvery === 0) renderCurrentItem();
      } catch (e) {
        showToast(`Could not load ${file.name}: ${e.message}`, 'error');
      }
    }

    if (added) {
      S.tab = 'orig';
      renderCurrentItem();
      showToast(`Loaded ${added} image${added === 1 ? '' : 's'} into the batch.`, 'success');
    }
  },

  select(id) {
    if (!getItem(id)) return;
    S.activeId = id;
    renderCurrentItem();
  },

  async randomize() {
    const item = getActiveItem();
    if (!item || S.busy || item.processing) return;
    try {
      await processRandomizeItem(item);
      renderCurrentItem();
    } catch (e) {
      showToast(`Error generating metadata: ${e.message}`, 'error');
    }
  },

  async randomizeAll() {
    if (!S.items.length || S.busy) return;
    S.busy = true;
    const run = S.run;
    const failed = [];
    let photos = 0, cleaned = 0, dropped = 0;
    updateActionButtons();

    // Every image gets its own independent identity — camera, lens, city,
    // dates, filename — exactly as Randomize Current gives it, so images
    // processed together cannot be linked to each other through it.
    try {
      for (const item of [...S.items]) {
        if (S.run !== run) break;                 // the queue was cleared
        S.activeId = item.id;
        if (photos + cleaned === 0 || (photos + cleaned) % 4 === 0) renderCurrentItem();
        try {
          await processRandomizeItem(item, { deferRender: true, quiet: true });
          if (S.run !== run) { releaseProcessedResources(item); break; }
          if (item.inputClass?.isPhoto) photos++; else cleaned++;
          if (item.keepDateDropped) dropped++;
          if ((photos + cleaned) % 4 === 0) {
            renderCurrentItem();
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        } catch (e) {
          if (S.run !== run) break;
          failed.push(`${item.file.name} (${e.message})`);
        }
      }
    } finally {
      S.busy = false;
    }
    if (S.run !== run) return;

    renderCurrentItem();
    const parts = [];
    if (photos) parts.push(`randomized ${photos} photo${photos === 1 ? '' : 's'}`);
    if (cleaned) parts.push(`cleaned ${cleaned} screenshot${cleaned === 1 ? '' : 's'} or graphic${cleaned === 1 ? '' : 's'} without adding a camera`);
    if (parts.length) {
      const msg = parts.join(' and ');
      showToast(msg.charAt(0).toUpperCase() + msg.slice(1) + '.', 'success');
    }
    if (dropped) {
      showToast(`${dropped} image${dropped === 1 ? '' : 's'} could not keep ${dropped === 1 ? 'its' : 'their'} original date (none in the metadata, older than every camera the tool can name, or not yet reached in a US time zone), so new dates were generated.`, 'warning');
    }
    // "Keep original date" was ticked: images from the same day keep that
    // day, which links them to each other, not only to their originals.
    if (document.getElementById('chkKeepDate')?.checked) {
      const byDay = new Map();
      for (const item of S.items) {
        if (!(item.fakeDate instanceof Date) || isNaN(item.fakeDate)) continue;
        const day = item.fakeDate.toDateString();
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
      const shared = [...byDay.values()].filter(n => n > 1).reduce((sum, n) => sum + n, 0);
      if (shared) {
        showToast(`${shared} output${shared === 1 ? '' : 's'} share a calendar day with another output in this batch, which links them to each other.`, 'warning');
      }
    }
    if (failed.length) {
      showToast(`Could not process ${failed.length} file${failed.length === 1 ? '' : 's'}: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '; …' : ''}`, 'error');
    }
  },

  async clear() {
    const item = getActiveItem();
    if (!item || S.busy || item.processing) return;
    try {
      await processClearItem(item);
      renderCurrentItem();
    } catch (e) {
      showToast(`Strip failed: ${e.message}`, 'error');
    }
  },

  async download() {
    const item = getActiveItem();
    if (!hasProcessedOutput(item)) return;
    try {
      downloadBlob(item.modBlob, getOutputName(item));
    } catch (e) {
      showToast(`Download failed: ${e.message}`, 'error');
    }
  },

  /** The name Download would give this item. Exposed for tools/check.js. */
  outputName(id) {
    return getOutputName(getItem(id));
  },

  async downloadAll() {
    for (const item of getProcessedItems()) {
      try {
        downloadBlob(item.modBlob, getOutputName(item));
        await new Promise(resolve => setTimeout(resolve, 180));
      } catch (e) {
        showToast(`Download failed for ${item.file.name}: ${e.message}`, 'error');
      }
    }
  },

  setTab(t) {
    if (t !== 'orig') return;
    S.tab = 'orig';
    renderCurrentItem();
  },

  toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('metafaker.theme', next);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.innerHTML = next === 'dark' ? ICONS.sun : ICONS.moon;
  },

  reset() {
    S.run++;          // stops a running batch before its next image
    S.busy = false;
    S.items.forEach(item => {
      releaseItemResources(item);
      releaseProcessedResources(item);
    });
    S.items = [];
    S.activeId = null;
    S.tab = 'orig';
    S.fieldCounts = { orig: 0 };

    const grid = document.getElementById('contentGrid');
    const previewImg = document.getElementById('previewImg');
    const previewName = document.getElementById('previewName');
    const previewMeta = document.getElementById('previewMeta');
    const fileInput = document.getElementById('fileInput');

    if (grid) grid.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (previewName) previewName.textContent = '-';
    if (previewMeta) previewMeta.textContent = '-';
    if (fileInput) fileInput.value = '';

    renderBatchStrip();
    renderActiveTab();
    setTabs();
    updateActionButtons();
  },
};
