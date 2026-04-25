/**
 * ui.js - Application state, UI rendering, and the main App controller.
 *
 * Manages the image queue, preview, metadata display, and local-only actions
 * for randomizing, stripping, and downloading processed JPEGs.
 */

import {
  fmtBytes, escapeHtml, makeId,
  dataUrlToBlob, stripViaCanvas,
} from './helpers.js';
import {
  generateFake, enforceUsGpsOnDataUrl, readBackExifStrict,
  parseFileExif, renderMeta,
} from './exif.js';

export const S = {
  items: [],
  activeId: null,
  tab: 'orig',
  fieldCounts: { orig: 0 },
};

function createItem(file) {
  return {
    id: makeId(),
    file,
    previewUrl: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : '',
    origExif: {},
    modDataUrl: null,
    modBlob: null,
    modPreviewUrl: '',
    fakeExif: null,
    fakePiexif: null,
    fakeCamera: null,
    fakeLocation: null,
    error: null,
    processing: false,
  };
}

function getItem(id) {
  return S.items.find(item => item.id === id) || null;
}

function getActiveItem() {
  return getItem(S.activeId);
}

function getProcessedItems() {
  return S.items.filter(item => item.modBlob || item.modDataUrl);
}

function getDisplayUrl(item) {
  return item?.modPreviewUrl || item?.modDataUrl || item?.previewUrl || '';
}

function hasProcessedOutput(item) {
  return !!(item?.modBlob || item?.modDataUrl);
}

function splitFileName(name) {
  const safeName = String(name || 'image.jpg').trim() || 'image.jpg';
  const match = safeName.match(/^(.*?)(\.[^.]+)?$/);
  const base = (match?.[1] || safeName).trim() || 'image';
  const ext = (match?.[2] || '').trim();
  return { base, ext };
}

/**
 * Camera-appropriate filename matching the faked camera model.
 * Uses today's actual date with random time for date-based formats.
 */
function getOutputName(item) {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const YYYY = now.getFullYear();
  const MM = p(now.getMonth() + 1);
  const DD = p(now.getDate());
  const hh = p(Math.floor(Math.random() * 24));
  const mm = p(Math.floor(Math.random() * 60));
  const ss = p(Math.floor(Math.random() * 60));
  const ms = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const seq = Math.floor(Math.random() * 9000) + 1000;

  const make = item?.fakeCamera?.make || '';

  switch (make) {
    case 'Apple':    return `IMG_${seq}.JPG`;
    case 'Samsung':  return `${YYYY}${MM}${DD}_${hh}${mm}${ss}.jpg`;
    case 'Google':   return `PXL_${YYYY}${MM}${DD}_${hh}${mm}${ss}${ms}.jpg`;
    case 'Canon':    return `IMG_${seq}.JPG`;
    case 'Nikon':    return `DSC_${seq}.JPG`;
    case 'Sony':     return `DSC0${seq}.JPG`;
    case 'FUJIFILM': return `DSCF${seq}.JPG`;
    default:         return `IMG_${YYYY}${MM}${DD}_${hh}${mm}${ss}.jpg`;
  }
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
  item.modDataUrl = null;
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
      : `<div class="batch-thumb-empty"><span class="material-icons">image</span></div>`;

    return `
      <div class="batch-item${item.id === S.activeId ? ' active' : ''}" onclick="App.select('${item.id}')">
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

  if (btnRandom) btnRandom.disabled = !hasCurrent || current.processing;
  if (btnClear) btnClear.disabled = !hasCurrent || current.processing;
  if (btnRandomAll) btnRandomAll.disabled = !S.items.length || anyProcessing;
  if (btnDownload) btnDownload.disabled = !hasOutput;
  if (btnDownloadAll) btnDownloadAll.disabled = !getProcessedItems().length;
}

function renderActiveTab() {
  const body = document.getElementById('metaBody');
  const current = getActiveItem();
  if (!body) return;

  if (!current) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">image</span></div><p>Select one or more images to begin.</p></div>`;
    setBadge('none', 'No image');
    updateTabCounts();
    setTabs();
    updateActionButtons();
    return;
  }

  if (hasProcessedOutput(current) && !current.fakeExif) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">cleaning_services</span></div><p>Metadata was stripped from this image.</p></div>`;
    S.fieldCounts.orig = 0;
    setBadge('cleared', 'Cleared');
  } else if (current.fakeExif) {
    const res = renderMeta(current.fakeExif, true);
    body.innerHTML = res.html;
    S.fieldCounts.orig = res.count;
    setBadge('fake', 'Randomized');
  } else if (!current.origExif || Object.keys(current.origExif).length === 0) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">photo_camera</span></div><p>No EXIF metadata found.</p></div>`;
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

async function hydrateItem(file) {
  const item = createItem(file);
  item.processing = true;
  item.origExif = await parseFileExif(file);
  item.processing = false;
  return item;
}

async function ensureBlob(item) {
  if (item.modBlob) return item.modBlob;
  if (!item.modDataUrl) throw new Error('No processed file available yet.');
  item.modBlob = dataUrlToBlob(item.modDataUrl);
  return item.modBlob;
}

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

async function processRandomizeItem(item, options = {}) {
  const { deferRender = false } = options;
  item.processing = true;
  item.error = null;
  if (!deferRender) renderCurrentItem();

  try {
    let originalDate = null;
    if (document.getElementById('chkKeepDate')?.checked && item.origExif) {
      const raw = item.origExif.DateTimeOriginal || item.origExif.DateTime || item.origExif.CreateDate;
      if (raw instanceof Date) {
        originalDate = raw;
      } else if (typeof raw === 'string') {
        const parts = raw.match(/(\d{4}):(\d{2}):(\d{2})/);
        if (parts) originalDate = new Date(parseInt(parts[1], 10), parseInt(parts[2], 10) - 1, parseInt(parts[3], 10));
      }
    }

    const fake = generateFake({ originalDate });
    const canvasResult = await stripViaCanvas(item.previewUrl);
    const cleanJpeg = canvasResult.dataUrl;

    const px = window.piexif;
    fake.piexif.Exif[px.ExifIFD.PixelXDimension] = canvasResult.width;
    fake.piexif.Exif[px.ExifIFD.PixelYDimension] = canvasResult.height;
    fake.display.PixelXDimension = canvasResult.width;
    fake.display.PixelYDimension = canvasResult.height;

    const bytes = px.dump(fake.piexif);
    let modDataUrl = px.insert(bytes, cleanJpeg);
    modDataUrl = enforceUsGpsOnDataUrl(modDataUrl, fake.loc, fake.display.GPSAltitude);

    const verified = await readBackExifStrict(modDataUrl);

    releaseProcessedResources(item);
    item.modBlob = verified.blob;
    item.modPreviewUrl = (typeof URL !== 'undefined' && URL.createObjectURL)
      ? URL.createObjectURL(verified.blob)
      : modDataUrl;
    item.modDataUrl = item.modPreviewUrl ? null : modDataUrl;
    item.fakeExif = {
      ...verified.exif,
      GPSLatitude: fake.loc.lat,
      GPSLongitude: -Math.abs(fake.loc.lon),
      GPSAltitude: fake.display.GPSAltitude,
      GPSLatitudeRef: 'N',
      GPSLongitudeRef: 'W',
    };
    item.fakePiexif = fake.piexif;
    item.fakeCamera = fake.cam;
    item.fakeLocation = { ...fake.loc, lon: -Math.abs(fake.loc.lon) };

    const locTxt = item.fakeLocation?.city ? ` | ${item.fakeLocation.city}` : '';
    if (verified.warning) {
      showToast(`${verified.warning} Some sites strip metadata on upload.`, 'warning');
    } else {
      showToast(`Randomized ${item.file.name}${locTxt}`, 'info');
    }
  } catch (e) {
    item.error = e.message;
    releaseProcessedResources(item);
    item.fakeExif = null;
    item.fakePiexif = null;
    item.fakeCamera = null;
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
    const canvasResult = await stripViaCanvas(item.previewUrl);
    const newBlob = dataUrlToBlob(canvasResult.dataUrl);

    releaseProcessedResources(item);
    item.modBlob = newBlob;
    item.modPreviewUrl = (typeof URL !== 'undefined' && URL.createObjectURL)
      ? URL.createObjectURL(item.modBlob)
      : canvasResult.dataUrl;
    item.modDataUrl = item.modPreviewUrl ? null : canvasResult.dataUrl;
    item.fakeExif = null;
    item.fakePiexif = null;
    item.fakeCamera = null;
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
    const files = Array.from(filesLike || []).filter(file => (file.type || '').startsWith('image/'));
    if (!files.length) {
      showToast('Select image files only.', 'warning');
      return;
    }

    const grid = document.getElementById('contentGrid');
    if (grid) grid.style.display = 'grid';

    let added = 0;
    const renderEvery = files.length > 20 ? 8 : files.length > 8 ? 4 : 1;

    for (const file of files) {
      try {
        const item = await hydrateItem(file);
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
    if (!item) return;
    try {
      await processRandomizeItem(item);
      renderCurrentItem();
    } catch (e) {
      showToast(`Error generating metadata: ${e.message}`, 'error');
    }
  },

  async randomizeAll() {
    if (!S.items.length) return;
    let completed = 0;

    for (const item of S.items) {
      S.activeId = item.id;
      if (completed === 0 || completed % 4 === 0) renderCurrentItem();
      try {
        await processRandomizeItem(item, { deferRender: true });
        completed++;
        if (completed % 4 === 0) {
          renderCurrentItem();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch (e) {
        showToast(`Batch failed for ${item.file.name}: ${e.message}`, 'error');
      }
    }

    renderCurrentItem();
    showToast(`Randomized ${completed} image${completed === 1 ? '' : 's'} in the batch.`, 'success');
  },

  async clear() {
    const item = getActiveItem();
    if (!item) return;
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
      downloadBlob(await ensureBlob(item), getOutputName(item));
    } catch (e) {
      showToast(`Download failed: ${e.message}`, 'error');
    }
  },

  async downloadAll() {
    for (const item of getProcessedItems()) {
      try {
        downloadBlob(await ensureBlob(item), getOutputName(item));
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
    if (icon) icon.textContent = next === 'dark' ? 'light_mode' : 'dark_mode';
  },

  reset() {
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
