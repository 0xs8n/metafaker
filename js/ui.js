/**
 * ui.js — Application state, UI rendering, and the main App controller.
 *
 * Manages the image queue, batch panel, preview, metadata tabs,
 * cloud transfer, and all user-facing actions (randomize, strip, download, upload).
 */

import {
  fmtBytes, escapeHtml, makeId, copyText,
  dataUrlToBlob, stripViaCanvas,
} from './helpers.js';
import {
  generateFake, enforceUsGpsOnDataUrl, readBackExifStrict,
  parseFileExif, renderMeta,
} from './exif.js';

// ── Constants ────────────────────────────────────────────────────

/** Default Cloudinary configuration for the hosted app. */
export const DEFAULT_CLOUD = {
  cloudName: 'dt35oppkf',
  uploadPreset: 'metafaker-transfers',
};

// ── Application State ────────────────────────────────────────────

export const S = {
  items: [],          // Array of image items in the batch queue
  activeId: null,     // ID of the currently selected item
  tab: 'orig',        // Active metadata tab: 'orig' | 'fake' | 'cloud'
  fieldCounts: { orig: 0, fake: 0, cloud: 0 },
  cloud: {
    cloudName:    localStorage.getItem('metafaker.cloudName')    || DEFAULT_CLOUD.cloudName,
    uploadPreset: localStorage.getItem('metafaker.uploadPreset') || DEFAULT_CLOUD.uploadPreset,
  },
};

// ── Item Lifecycle ───────────────────────────────────────────────

/** Create a new queue item from a File object. */
function createItem(file) {
  return {
    id: makeId(),
    file,
    previewUrl: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : '',
    origExif: {},         // Original EXIF parsed from the uploaded file
    modDataUrl: null,     // Processed image as data URL (cleared when modBlob is set)
    modBlob: null,        // Processed image as Blob (for download/upload)
    modPreviewUrl: '',    // Object URL for previewing the processed image
    fakeExif: null,       // Generated fake EXIF (null if stripped)
    fakePiexif: null,     // piexif format of fake EXIF
    fakeCamera: null,     // Camera profile used for this item
    fakeLocation: null,   // Location used for this item
    upload: null,         // Cloud upload result { url, publicId, ... }
    error: null,          // Last error message
    processing: false,    // True while an async operation is running
  };
}

/** Find an item by ID. */
function getItem(id) { return S.items.find(item => item.id === id) || null; }

/** Get the currently selected item. */
function getActiveItem() { return getItem(S.activeId); }

/** Get all items that have been processed (randomized or stripped). */
function getProcessedItems() { return S.items.filter(item => item.modBlob || item.modDataUrl); }

/** Get all items that have been uploaded to the cloud. */
function getUploadedItems() { return S.items.filter(item => item.upload?.url); }

/** Get the best available display URL for an item (processed > original). */
function getDisplayUrl(item) { return item?.modPreviewUrl || item?.modDataUrl || item?.previewUrl || ''; }

/** Check if an item has a processed output ready. */
function hasProcessedOutput(item) { return !!(item?.modBlob || item?.modDataUrl); }

// ── File Naming ──────────────────────────────────────────────────

function splitFileName(name) {
  const safeName = String(name || 'image.jpg').trim() || 'image.jpg';
  const match = safeName.match(/^(.*?)(\.[^.]+)?$/);
  const base = (match?.[1] || safeName).trim() || 'image';
  const ext = (match?.[2] || '').trim();
  return { base, ext };
}

/** Get the output filename, preserving original name but ensuring .jpg extension. */
function getOutputName(item) {
  const { base, ext } = splitFileName(item?.file?.name || 'image.jpg');
  if (/^\.(jpe?g)$/i.test(ext)) return `${base}${ext}`;
  return `${base}.jpg`;
}

/** Generate a Cloudinary-safe public ID from the filename. */
function getCloudPublicId(item) {
  const { base } = splitFileName(getOutputName(item));
  return base.replace(/\s+/g, '_').replace(/[?&#\\%<>]/g, '_').replace(/^\/+|\/+$/g, '').replace(/_+/g, '_').trim() || 'image';
}

// ── Memory Management ────────────────────────────────────────────

/** Revoke the original preview Object URL to free memory. */
function releaseItemResources(item) {
  if (!item?.previewUrl || !window.URL?.revokeObjectURL) return;
  try { window.URL.revokeObjectURL(item.previewUrl); } catch (e) {}
  item.previewUrl = '';
}

/** Revoke processed image resources (Object URL + Blob). */
function releaseProcessedResources(item) {
  if (item?.modPreviewUrl && window.URL?.revokeObjectURL) {
    try { window.URL.revokeObjectURL(item.modPreviewUrl); } catch (e) {}
  }
  item.modPreviewUrl = '';
  item.modBlob = null;
  item.modDataUrl = null;
}

// ── Status Helpers ───────────────────────────────────────────────

/** Describe an item's current status for display. */
function describeItemStatus(item) {
  if (!item) return { text: 'Idle', className: '' };
  if (item.processing) return { text: 'Processing', className: 'processing' };
  if (item.error) return { text: 'Error', className: 'error' };
  if (item.upload?.url) return { text: 'Uploaded', className: 'uploaded' };
  if (hasProcessedOutput(item) && item.fakeExif) return { text: 'Randomized', className: 'ready' };
  if (hasProcessedOutput(item)) return { text: 'Stripped', className: 'ready' };
  return { text: 'Loaded', className: '' };
}

// ── Toast Notifications ──────────────────────────────────────────

/** Show a brief toast message. Types: 'info' | 'success' | 'error' | 'warning'. */
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast-${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ── UI Rendering ─────────────────────────────────────────────────

function setBadge(type, text) {
  const b = document.getElementById('metaBadge');
  b.className = `badge badge-${type}`;
  b.textContent = text;
}

function setTabs() {
  document.getElementById('tabOrig').classList.toggle('active', S.tab === 'orig');
  document.getElementById('tabFake').classList.toggle('active', S.tab === 'fake');
  document.getElementById('tabCloud').classList.toggle('active', S.tab === 'cloud');
}

function updateTabCounts() {
  const current = getActiveItem();
  S.fieldCounts.orig = current?.origExif && Object.keys(current.origExif).length ? renderMeta(current.origExif, false).count : 0;
  S.fieldCounts.fake = current?.fakeExif && Object.keys(current.fakeExif).length ? renderMeta(current.fakeExif, true).count : 0;
  S.fieldCounts.cloud = getUploadedItems().length;
  document.getElementById('countOrig').textContent = S.fieldCounts.orig || '0';
  document.getElementById('countFake').textContent = S.fieldCounts.fake || '0';
  document.getElementById('countCloud').textContent = S.fieldCounts.cloud || '0';
}

/** Render the batch thumbnail strip at the top. */
function renderBatchStrip() {
  const strip = document.getElementById('batchStrip');
  const summary = document.getElementById('batchSummary');
  const count = document.getElementById('batchCount');
  count.textContent = S.items.length;

  if (!S.items.length) {
    summary.textContent = 'No images loaded yet.';
    strip.innerHTML = '';
    return;
  }

  const processed = getProcessedItems().length;
  const uploaded = getUploadedItems().length;
  summary.textContent = `${S.items.length} image${S.items.length === 1 ? '' : 's'} queued | ${processed} processed | ${uploaded} uploaded`;

  // Skip thumbnail rendering for large batches to reduce memory pressure
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

/** Enable/disable action buttons based on current state. */
function updateActionButtons() {
  const current = getActiveItem();
  const hasCurrent = !!current;
  const hasOutput = hasProcessedOutput(current);
  const draftCloud = getCloudDraft();
  const hasCloudConfig = !!(draftCloud.cloudName && draftCloud.uploadPreset);
  const anyProcessing = S.items.some(item => item.processing);

  document.getElementById('btnRandom').disabled      = !hasCurrent || current.processing;
  document.getElementById('btnClear').disabled        = !hasCurrent || current.processing;
  document.getElementById('btnRandomAll').disabled    = !S.items.length || anyProcessing;
  document.getElementById('btnDownload').disabled     = !hasOutput;
  document.getElementById('btnDownloadAll').disabled  = !getProcessedItems().length;
  document.getElementById('btnUploadCurrent').disabled = !hasOutput || !hasCloudConfig || current.processing;
  document.getElementById('btnUploadAll').disabled    = !getProcessedItems().length || !hasCloudConfig || anyProcessing;
}

// ── Cloud Transfer UI ────────────────────────────────────────────

function syncCloudInputs() {
  const cn = document.getElementById('cloudNameInput');
  const up = document.getElementById('uploadPresetInput');
  if (cn) cn.value = S.cloud.cloudName;
  if (up) up.value = S.cloud.uploadPreset;
}

function getCloudDraft() {
  const cn = document.getElementById('cloudNameInput');
  const up = document.getElementById('uploadPresetInput');
  return {
    cloudName:    (cn?.value || S.cloud.cloudName || '').trim(),
    uploadPreset: (up?.value || S.cloud.uploadPreset || '').trim(),
  };
}

function syncCloudDraftFromInputs() {
  const draft = getCloudDraft();
  S.cloud.cloudName = draft.cloudName;
  S.cloud.uploadPreset = draft.uploadPreset;
  updateActionButtons();
}

function saveCloudSettingsFromInputs() {
  const cn = document.getElementById('cloudNameInput');
  const up = document.getElementById('uploadPresetInput');
  if (!cn || !up) return;
  S.cloud.cloudName = cn.value.trim();
  S.cloud.uploadPreset = up.value.trim();
  localStorage.setItem('metafaker.cloudName', S.cloud.cloudName);
  localStorage.setItem('metafaker.uploadPreset', S.cloud.uploadPreset);
}

function renderTransferRows(items) {
  if (!items.length) {
    return `<div class="transfer-note">Uploaded links will appear here after you send processed files to the cloud.</div>`;
  }
  return `<div class="transfer-list">${items.map(item => `
    <div class="transfer-row">
      <div class="transfer-row-main">
        <div class="transfer-row-name">${escapeHtml(item.file.name)}</div>
        <a class="transfer-row-url" href="${item.upload.url}" target="_blank" rel="noopener">${escapeHtml(item.upload.url)}</a>
      </div>
      <div class="transfer-row-actions">
        <button class="btn btn-secondary" onclick="App.copyUploadUrl('${item.id}')">Copy URL</button>
        <button class="btn btn-secondary" onclick="App.openUploadUrl('${item.id}')">Open</button>
      </div>
    </div>`).join('')}</div>`;
}

function renderTransferTab() {
  const current = getActiveItem();
  const uploadedItems = getUploadedItems();
  const currentPanel = current?.upload?.url
    ? renderTransferRows([current])
    : `<div class="transfer-note">${hasProcessedOutput(current) ? 'This image is processed and ready to upload.' : 'Process the current image first, then upload it from here.'}</div>`;

  return `
    <div class="transfer-card">
      <h3>Cloud Transfer</h3>
      <p>Optional. After processing on mobile, upload the final JPEGs here and open the same links on desktop.</p>
      <div class="transfer-grid">
        <div class="field">
          <label for="cloudNameInput">Cloudinary Cloud Name</label>
          <input id="cloudNameInput" type="text" placeholder="your-cloud-name" oninput="App.syncCloudDraft()">
        </div>
        <div class="field">
          <label for="uploadPresetInput">Unsigned Upload Preset</label>
          <input id="uploadPresetInput" type="text" placeholder="unsigned-upload-preset" oninput="App.syncCloudDraft()">
        </div>
      </div>
      <div class="transfer-actions">
        <button class="btn btn-secondary" onclick="App.saveCloudSettings()">Save Transfer Settings</button>
        <button class="btn btn-secondary" onclick="App.uploadCurrent()" ${hasProcessedOutput(current) ? '' : 'disabled'}>Upload Current Image</button>
        <button class="btn btn-secondary" onclick="App.uploadAll()" ${getProcessedItems().length ? '' : 'disabled'}>Upload Entire Batch</button>
        <button class="btn btn-secondary" onclick="App.copyAllUploadUrls()" ${uploadedItems.length ? '' : 'disabled'}>Copy All Uploaded URLs</button>
      </div>
      <div class="transfer-note">This static app only uploads when you press an upload button. The transfer flow uses Cloudinary unsigned uploads, which work without adding a server to this repo.</div>
      <h3>Current Image</h3>
      ${currentPanel}
      <h3>Uploaded Batch Links</h3>
      ${renderTransferRows(uploadedItems)}
    </div>`;
}

// ── Tab Rendering ────────────────────────────────────────────────

function renderActiveTab() {
  const body = document.getElementById('metaBody');
  const current = getActiveItem();

  if (!current) {
    body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">image</span></div><p>Select one or more images to begin.</p></div>`;
    setBadge('none', 'No image');
    updateTabCounts(); setTabs(); updateActionButtons();
    return;
  }

  if (S.tab === 'orig') {
    if (!current.origExif || Object.keys(current.origExif).length === 0) {
      body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">photo_camera</span></div><p>No EXIF metadata found.</p></div>`;
      S.fieldCounts.orig = 0;
    } else {
      const res = renderMeta(current.origExif, false);
      body.innerHTML = res.html;
      S.fieldCounts.orig = res.count;
    }
    setBadge('original', 'Original');
  } else if (S.tab === 'fake') {
    if (hasProcessedOutput(current) && !current.fakeExif) {
      body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">cleaning_services</span></div><p>Metadata was stripped from this image.</p></div>`;
      S.fieldCounts.fake = 0;
      setBadge('cleared', 'Cleared');
    } else if (!current.fakeExif) {
      body.innerHTML = `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">shuffle</span></div><p>Use <strong>Randomize Current</strong> or <strong>Randomize Entire Batch</strong> to generate new EXIF data.</p></div>`;
      S.fieldCounts.fake = 0;
      setBadge('none', 'Not set');
    } else {
      const res = renderMeta(current.fakeExif, true);
      body.innerHTML = res.html;
      S.fieldCounts.fake = res.count;
      setBadge('fake', 'Randomized');
    }
  } else {
    body.innerHTML = renderTransferTab();
    setBadge(current.upload?.url ? 'fake' : 'none', current.upload?.url ? 'Uploaded' : 'Transfer');
    syncCloudInputs();
  }

  updateTabCounts(); setTabs(); updateActionButtons();
}

/** Master render function — updates preview, batch strip, and active tab. */
function renderCurrentItem() {
  const current = getActiveItem();
  if (!current) {
    document.getElementById('contentGrid').style.display = 'none';
    return;
  }
  document.getElementById('contentGrid').style.display = 'grid';
  document.getElementById('previewImg').src = getDisplayUrl(current);
  document.getElementById('previewName').textContent = current.file.name;
  document.getElementById('previewMeta').textContent = `${fmtBytes(current.file.size)} | ${current.file.type || 'image'} | ${describeItemStatus(current).text}`;
  renderBatchStrip();
  renderActiveTab();
}

// ── Image Processing ─────────────────────────────────────────────

/** Load a file, parse its EXIF, and create a queue item. */
async function hydrateItem(file) {
  const item = createItem(file);
  item.processing = true;
  item.origExif = await parseFileExif(file);
  item.processing = false;
  return item;
}

/** Ensure an item has a Blob (convert from data URL if needed). */
async function ensureBlob(item) {
  if (item.modBlob) return item.modBlob;
  if (!item.modDataUrl) throw new Error('No processed file available yet.');
  item.modBlob = dataUrlToBlob(item.modDataUrl);
  return item.modBlob;
}

/** Trigger a browser download for a Blob. */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Randomize an item: strip original metadata, generate fake EXIF, inject it.
 * Sets PixelXDimension/PixelYDimension to match actual canvas output.
 */
async function processRandomizeItem(item, options = {}) {
  const { deferRender = false } = options;
  item.processing = true; item.error = null; item.upload = null;
  if (!deferRender) renderCurrentItem();

  try {
    // Read the "keep today's date" checkbox
    const useTodaysDate = !!document.getElementById('chkTodayDate')?.checked;
    const fake = generateFake({ useTodaysDate });
    const canvasResult = await stripViaCanvas(item.previewUrl);
    const cleanJpeg = canvasResult.dataUrl;

    // Set pixel dimensions to match actual canvas output
    const px = window.piexif;
    fake.piexif["Exif"][px.ExifIFD.PixelXDimension] = canvasResult.width;
    fake.piexif["Exif"][px.ExifIFD.PixelYDimension] = canvasResult.height;
    fake.display.PixelXDimension = canvasResult.width;
    fake.display.PixelYDimension = canvasResult.height;

    // Inject fake EXIF into the clean JPEG
    const bytes = px.dump(fake.piexif);
    let modDataUrl = px.insert(bytes, cleanJpeg);
    modDataUrl = enforceUsGpsOnDataUrl(modDataUrl, fake.loc, fake.display.GPSAltitude);

    // Verify the EXIF was written correctly
    const verified = await readBackExifStrict(modDataUrl);

    // Release old resources AFTER new output is ready — prevents the preview
    // from falling back to the original image (which may have EXIF orientation
    // that causes a visible rotation flash).
    releaseProcessedResources(item);
    item.modBlob = verified.blob;
    item.modPreviewUrl = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(verified.blob) : modDataUrl;
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

    const locTxt = ` | ${item.fakeLocation.city}`;
    if (verified.warning) {
      showToast(`${verified.warning} Some sites strip metadata on upload.`, 'warning');
    } else {
      showToast(`Randomized ${item.file.name}${locTxt}`, 'info');
    }
  } catch (e) {
    item.error = e.message;
    releaseProcessedResources(item);
    item.fakeExif = null; item.fakePiexif = null;
    throw e;
  } finally {
    item.processing = false;
    if (!deferRender) renderCurrentItem();
  }
}

/** Strip all metadata from an item (no fake EXIF injected). */
async function processClearItem(item, options = {}) {
  const { deferRender = false } = options;
  item.processing = true; item.error = null; item.upload = null;
  if (!deferRender) renderCurrentItem();

  try {
    const canvasResult = await stripViaCanvas(item.previewUrl);
    const newBlob = dataUrlToBlob(canvasResult.dataUrl);
    // Release old resources AFTER new output is ready (prevents rotation flash)
    releaseProcessedResources(item);
    item.modBlob = newBlob;
    item.modPreviewUrl = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(item.modBlob) : canvasResult.dataUrl;
    item.modDataUrl = item.modPreviewUrl ? null : canvasResult.dataUrl;
    item.fakeExif = null; item.fakePiexif = null;
    item.fakeCamera = null; item.fakeLocation = null;
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

/** Upload a processed item to Cloudinary. */
async function uploadItemToCloud(item) {
  if (!S.cloud.cloudName || !S.cloud.uploadPreset) {
    throw new Error('Set the Cloudinary cloud name and unsigned upload preset first.');
  }
  item.processing = true; item.error = null;
  renderCurrentItem();

  try {
    const blob = await ensureBlob(item);
    const form = new FormData();
    form.append('file', blob, getOutputName(item));
    form.append('upload_preset', S.cloud.uploadPreset);
    form.append('public_id', getCloudPublicId(item));
    form.append('filename_override', getOutputName(item));

    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(S.cloud.cloudName)}/upload`, {
      method: 'POST', body: form,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Upload failed with status ${response.status}`);

    item.upload = {
      url: data.secure_url || data.url,
      publicId: data.public_id || '',
      assetId: data.asset_id || '',
      uploadedAt: new Date().toISOString(),
    };
    showToast(`Uploaded ${item.file.name} to cloud.`, 'success');
  } catch (e) {
    item.error = e.message;
    throw e;
  } finally {
    item.processing = false;
    renderCurrentItem();
  }
}

// ── App Controller ───────────────────────────────────────────────
// Exposed on window.App so HTML onclick handlers can call methods.

export const App = {
  /** Load one or more image files into the batch queue. */
  async loadFiles(filesLike) {
    const files = Array.from(filesLike || []).filter(f => (f.type || '').startsWith('image/'));
    if (!files.length) { showToast('Select image files only.', 'warning'); return; }

    document.getElementById('contentGrid').style.display = 'grid';
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
    try { await processRandomizeItem(item); S.tab = 'fake'; renderCurrentItem(); }
    catch (e) { showToast(`Error generating metadata: ${e.message}`, 'error'); }
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
        if (completed % 4 === 0) { renderCurrentItem(); await new Promise(r => setTimeout(r, 0)); }
      } catch (e) { showToast(`Batch failed for ${item.file.name}: ${e.message}`, 'error'); }
    }
    S.tab = 'fake';
    renderCurrentItem();
    showToast(`Randomized ${completed} image${completed === 1 ? '' : 's'} in the batch.`, 'success');
  },

  async clear() {
    const item = getActiveItem();
    if (!item) return;
    try { await processClearItem(item); S.tab = 'fake'; renderCurrentItem(); }
    catch (e) { showToast(`Strip failed: ${e.message}`, 'error'); }
  },

  async download() {
    const item = getActiveItem();
    if (!hasProcessedOutput(item)) return;
    try { downloadBlob(await ensureBlob(item), getOutputName(item)); }
    catch (e) { showToast(`Download failed: ${e.message}`, 'error'); }
  },

  async downloadAll() {
    for (const item of getProcessedItems()) {
      try { downloadBlob(await ensureBlob(item), getOutputName(item)); await new Promise(r => setTimeout(r, 180)); }
      catch (e) { showToast(`Download failed for ${item.file.name}: ${e.message}`, 'error'); }
    }
  },

  saveCloudSettings() { saveCloudSettingsFromInputs(); renderCurrentItem(); showToast('Cloud transfer settings saved.', 'success'); },
  syncCloudDraft() { syncCloudDraftFromInputs(); },

  async uploadCurrent() {
    const item = getActiveItem();
    if (!hasProcessedOutput(item)) return;
    saveCloudSettingsFromInputs();
    try { await uploadItemToCloud(item); S.tab = 'cloud'; renderCurrentItem(); }
    catch (e) { showToast(`Upload failed: ${e.message}`, 'error'); }
  },

  async uploadAll() {
    saveCloudSettingsFromInputs();
    let uploaded = 0;
    for (const item of getProcessedItems()) {
      S.activeId = item.id; renderCurrentItem();
      try { await uploadItemToCloud(item); uploaded++; }
      catch (e) { showToast(`Upload failed for ${item.file.name}: ${e.message}`, 'error'); }
    }
    S.tab = 'cloud'; renderCurrentItem();
    showToast(`Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'} to the cloud.`, 'success');
  },

  async copyUploadUrl(id) {
    const item = getItem(id);
    if (!item?.upload?.url) return;
    await copyText(item.upload.url);
    showToast(`Copied ${item.file.name} URL.`, 'success');
  },

  async copyAllUploadUrls() {
    const urls = getUploadedItems().map(i => i.upload.url).join('\n');
    if (!urls) return;
    await copyText(urls);
    showToast('Copied all uploaded URLs.', 'success');
  },

  openUploadUrl(id) {
    const item = getItem(id);
    if (item?.upload?.url) window.open(item.upload.url, '_blank', 'noopener');
  },

  setTab(t) { S.tab = t; renderCurrentItem(); },

  /** Toggle between light and dark themes. */
  toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('metafaker.theme', next);
    document.getElementById('themeIcon').textContent = next === 'dark' ? 'light_mode' : 'dark_mode';
  },

  /** Clear the entire batch queue and reset state. */
  reset() {
    S.items.forEach(item => { releaseItemResources(item); releaseProcessedResources(item); });
    S.items = []; S.activeId = null; S.tab = 'orig';
    S.fieldCounts = { orig: 0, fake: 0, cloud: 0 };
    document.getElementById('contentGrid').style.display = 'none';
    document.getElementById('previewImg').src = '';
    document.getElementById('previewName').textContent = '-';
    document.getElementById('previewMeta').textContent = '-';
    document.getElementById('fileInput').value = '';
    renderBatchStrip(); setTabs(); updateActionButtons();
  },
};
