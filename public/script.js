// ── DOM Elements ────────────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const fetchBtn = document.getElementById('fetchBtn');
const errorToast = document.getElementById('errorToast');
const errorText = document.getElementById('errorText');
const resultsSection = document.getElementById('resultsSection');
const formatsContainer = document.getElementById('formatsContainer');
const newDownloadBtn = document.getElementById('newDownloadBtn');
const inputSection = document.getElementById('inputSection');

const videoThumbnail = document.getElementById('videoThumbnail');
const videoDuration = document.getElementById('videoDuration');
const videoTitle = document.getElementById('videoTitle');
const videoUploader = document.getElementById('videoUploader');
const videoPlatformBadge = document.getElementById('videoPlatformBadge');
const videoPlatformName = document.getElementById('videoPlatformName');

const tabCombined = document.getElementById('tabCombined');
const tabVideoOnly = document.getElementById('tabVideoOnly');
const tabAudioOnly = document.getElementById('tabAudioOnly');
const countCombined = document.getElementById('countCombined');
const countVideoOnly = document.getElementById('countVideoOnly');
const countAudioOnly = document.getElementById('countAudioOnly');

const quickGrid = document.getElementById('quickGrid');
const advancedToggle = document.getElementById('advancedToggle');
const advancedFormats = document.getElementById('advancedFormats');

// ── State ───────────────────────────────────────────────────────────
let videoData = null;
let currentTab = 'combined';
let currentUrl = '';

// Does this browser support the File System Access API?
const HAS_FILE_PICKER = typeof window.showSaveFilePicker === 'function';

// ── Event Listeners ─────────────────────────────────────────────────
urlInput.addEventListener('input', () => {
  const hasText = urlInput.value.trim().length > 0;
  fetchBtn.disabled = !hasText;
  if (hasText) {
    pasteBtn.classList.add('hidden');
    clearBtn.classList.remove('hidden');
  } else {
    pasteBtn.classList.remove('hidden');
    clearBtn.classList.add('hidden');
  }
  hideError();
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
  urlInput.focus();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !fetchBtn.disabled) fetchVideoInfo();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    urlInput.dispatchEvent(new Event('input'));
    urlInput.focus();
    pasteBtn.style.background = 'rgba(16, 185, 129, 0.2)';
    pasteBtn.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    pasteBtn.style.color = '#34d399';
    setTimeout(() => { pasteBtn.style.background = ''; pasteBtn.style.borderColor = ''; pasteBtn.style.color = ''; }, 600);
  } catch { showError('Could not access clipboard. Please paste manually (Ctrl+V).'); }
});

fetchBtn.addEventListener('click', fetchVideoInfo);
newDownloadBtn.addEventListener('click', resetUI);

[tabCombined, tabVideoOnly, tabAudioOnly].forEach(tab => {
  tab.addEventListener('click', () => {
    currentTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderFormats();
  });
});

advancedToggle.addEventListener('click', () => {
  const isHidden = advancedFormats.classList.contains('hidden');
  advancedFormats.classList.toggle('hidden');
  advancedToggle.classList.toggle('expanded', isHidden);
  advancedToggle.innerHTML = isHidden
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Hide All Formats`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Show All Formats (Advanced)`;
});


// ═════════════════════════════════════════════════════════════════════
// ── Save-As Dialog + Streaming Download Core ────────────────────────
// ═════════════════════════════════════════════════════════════════════

/**
 * Prompts the user for a save location (if supported), then fetches the
 * URL and streams it directly to disk, reporting live progress.
 *
 * Must be called from a user-gesture handler so the file picker appears.
 *
 * @param {object} opts
 * @param {string}   opts.fetchUrl         - API endpoint to download from
 * @param {string}   opts.suggestedName    - Default filename for Save-As
 * @param {object[]} opts.fileTypes        - showSaveFilePicker types array
 * @param {function} opts.onProgress       - ({ loaded, total, speed, percent }) => void
 * @param {function} opts.onPhase          - ('picking'|'preparing'|'downloading'|'done') => void
 * @returns {Promise<{totalSize:number}|null>}  null if user cancelled picker
 */
async function streamDownload(opts) {
  const { fetchUrl, suggestedName, fileTypes, onProgress, onPhase } = opts;

  // ── 1. Ask where to save (MUST happen first, inside user gesture) ──
  let writable = null;        // WritableStream to disk (File System Access API)
  let fallbackChunks = null;  // Collected chunks for legacy fallback

  if (HAS_FILE_PICKER) {
    onPhase('picking');
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: fileTypes });
      writable = await handle.createWritable();
    } catch (err) {
      if (err.name === 'AbortError') return null; // user cancelled
      // If the API exists but threw for another reason, fall back
      console.warn('showSaveFilePicker error, falling back:', err);
      writable = null;
    }
  }

  if (!writable) fallbackChunks = [];

  // ── 2. Fetch from server ──────────────────────────────────────────
  onPhase('preparing');
  let response;
  try {
    response = await fetch(fetchUrl);
  } catch (netErr) {
    if (writable) await writable.abort();
    throw new Error('Network error — check your connection.');
  }

  if (!response.ok) {
    let msg = 'Download failed';
    try { const d = await response.json(); msg = d.error || msg; } catch (_) {}
    if (writable) await writable.abort();
    throw new Error(msg);
  }

  // Get server-provided filename (for legacy fallback)
  const cd = response.headers.get('Content-Disposition');
  let serverFilename = suggestedName;
  if (cd) {
    const m = cd.match(/filename[^;=\n]*=["']?([^"';\n]*)["']?/);
    if (m) serverFilename = decodeURIComponent(m[1]);
  }

  const totalBytes = parseInt(response.headers.get('Content-Length'), 10) || 0;

  // ── 3. Stream response body ───────────────────────────────────────
  onPhase('downloading');

  // If ReadableStream not available, degrade gracefully
  if (!response.body || !response.body.getReader) {
    const blob = await response.blob();
    if (writable) { await writable.write(blob); await writable.close(); }
    else saveBlobToFile(blob, serverFilename);
    onProgress({ loaded: blob.size, total: blob.size, speed: 0, percent: 100 });
    onPhase('done');
    return { totalSize: blob.size };
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const speedSamples = [];    // { time, bytes }
  let lastUIUpdate = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Write chunk to destination
    if (writable) await writable.write(value);
    else fallbackChunks.push(value);

    receivedBytes += value.length;

    // ── Speed calculation (sliding 3-second window) ──
    const now = performance.now();
    speedSamples.push({ time: now, bytes: receivedBytes });
    while (speedSamples.length > 1 && now - speedSamples[0].time > 3000) speedSamples.shift();

    if (now - lastUIUpdate >= 200) {               // update UI every 200ms
      lastUIUpdate = now;
      let speed = 0;
      if (speedSamples.length >= 2) {
        const oldest = speedSamples[0];
        const dt = (now - oldest.time) / 1000;
        if (dt > 0) speed = (receivedBytes - oldest.bytes) / dt;
      }
      onProgress({
        loaded: receivedBytes,
        total: totalBytes,
        speed,
        percent: totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0
      });
    }
  }

  // ── 4. Finalize ───────────────────────────────────────────────────
  if (writable) {
    await writable.close();
  } else {
    const blob = new Blob(fallbackChunks);
    saveBlobToFile(blob, serverFilename);
  }

  onProgress({ loaded: receivedBytes, total: totalBytes || receivedBytes, speed: 0, percent: 100 });
  onPhase('done');
  return { totalSize: receivedBytes };
}


// ═════════════════════════════════════════════════════════════════════
// ── Tiny Helpers ────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function saveBlobToFile(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  if (bps < 1073741824) return (bps / 1048576).toFixed(1) + ' MB/s';
  return (bps / 1073741824).toFixed(2) + ' GB/s';
}


// ═════════════════════════════════════════════════════════════════════
// ── Fetch Video Info ────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

async function fetchVideoInfo() {
  const url = urlInput.value.trim();
  if (!url) return;

  currentUrl = url;
  hideError();
  setLoading(true);

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to extract video information');
    videoData = data;
    showResults();
  } catch (err) {
    showError(err.message || 'Something went wrong. Please check the URL and try again.');
  } finally {
    setLoading(false);
  }
}


// ═════════════════════════════════════════════════════════════════════
// ── Show Results ────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function showResults() {
  videoThumbnail.src = videoData.thumbnail || '';
  videoThumbnail.onerror = () => {
    videoThumbnail.src = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="180" fill="#1a1a2e"/><text x="160" y="95" text-anchor="middle" fill="#4a4a6a" font-family="sans-serif" font-size="14">No Preview</text></svg>'
    );
  };

  videoDuration.textContent = formatDuration(videoData.duration);
  videoTitle.textContent = videoData.title;
  videoUploader.textContent = videoData.uploader || '';
  videoPlatformName.textContent = videoData.platform;

  const pc = { youtube:'#ff0033', instagram:'#e4405f', facebook:'#1877f2', tiktok:'#ff0050', twitter:'#f0f0f5', snapchat:'#fffc00', vimeo:'#1ab7ea', reddit:'#ff4500', twitch:'#9146ff', dailymotion:'#00d2f3' };
  videoPlatformBadge.style.borderColor = pc[videoData.platform] || 'rgba(255,255,255,0.3)';

  renderQuickDownload();

  const combined = videoData.formats.filter(f => f.type === 'video+audio');
  const videoOnly = videoData.formats.filter(f => f.type === 'video-only');
  const audioOnly = videoData.formats.filter(f => f.type === 'audio-only');
  countCombined.textContent = combined.length;
  countVideoOnly.textContent = videoOnly.length;
  countAudioOnly.textContent = audioOnly.length;

  if (combined.length > 0) currentTab = 'combined';
  else if (videoOnly.length > 0) currentTab = 'videoonly';
  else currentTab = 'audioonly';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === currentTab));

  renderFormats();

  advancedFormats.classList.add('hidden');
  advancedToggle.classList.remove('expanded');
  advancedToggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Show All Formats (Advanced)`;

  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ═════════════════════════════════════════════════════════════════════
// ── Quick Download Cards ────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function renderQuickDownload() {
  quickGrid.innerHTML = '';

  const qualities = videoData.availableQualities || [];
  const hasAudio = videoData.hasAudio;
  const cards = [];

  if (qualities.length > 0) {
    const best = qualities[0];
    const bestSize = best.estimatedSize || 0;
    cards.push({ key:'best', label:'Best Quality', subtitle:`Up to ${best.label} · Auto merged MP4`, iconClass:'qi-best', iconText:'★', recommended:true, filesize: bestSize });
  }
  qualities.forEach(q => {
    cards.push({ key:q.key, label:q.label, subtitle:q.subtitle+' · MP4', iconClass:`qi-${q.key}`, iconText:q.label, recommended:false, filesize: q.estimatedSize || 0 });
  });
  if (hasAudio) {
    cards.push({ key:'audio', label:'Audio Only', subtitle:'Best quality · MP3', iconClass:'qi-audio', iconText:'♫', recommended:false, filesize: videoData.bestAudioSize || 0 });
  }

  cards.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'quick-card';
    el.style.animationDelay = `${i * 60}ms`;
    el.dataset.quality = card.key;
    el.onclick = () => quickDownload(card.key, el, card.subtitle);

    const sizeText = card.filesize > 0 ? formatSize(card.filesize) : '';
    const sizeLabel = card.filesize > 0 ? `~ ${sizeText}` : '';

    el.innerHTML = `
      ${card.recommended ? '<div class="quick-card-recommend">Recommended</div>' : ''}
      <div class="quick-card-icon ${card.iconClass}">${card.iconText}</div>
      <div class="quick-card-info">
        <div class="quick-card-label">${card.label}${sizeLabel ? `<span class="quick-card-size">${sizeLabel}</span>` : ''}</div>
        <div class="quick-card-sub">${card.subtitle}</div>
        <div class="quick-card-progress-info hidden"></div>
      </div>
      <div class="quick-card-dl">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
      <div class="quick-card-progress-bar"><div class="quick-card-progress-fill"></div></div>
    `;
    quickGrid.appendChild(el);
  });
}


// ═════════════════════════════════════════════════════════════════════
// ── Quick Download Handler ──────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

async function quickDownload(quality, cardEl, originalSubtitle) {
  const subEl       = cardEl.querySelector('.quick-card-sub');
  const progInfo    = cardEl.querySelector('.quick-card-progress-info');
  const progFill    = cardEl.querySelector('.quick-card-progress-fill');
  const dlIcon      = cardEl.querySelector('.quick-card-dl');
  const origDlHTML  = dlIcon.innerHTML;

  const isAudio     = quality === 'audio';
  const title       = sanitizeFilename(videoData.title);
  const ext         = isAudio ? '.mp3' : '.mp4';
  const suggestedName = `${title}_${quality}${ext}`;

  const fileTypes = isAudio
    ? [{ description: 'Audio Files', accept: { 'audio/mpeg': ['.mp3'], 'audio/*': ['.m4a','.ogg','.opus'] } }]
    : [{ description: 'Video Files', accept: { 'video/mp4': ['.mp4'], 'video/*': ['.mkv','.webm'] } }];

  const fetchUrl = `/api/download-quality?url=${encodeURIComponent(currentUrl)}&quality=${encodeURIComponent(quality)}`;

  try {
    const result = await streamDownload({
      fetchUrl,
      suggestedName,
      fileTypes,
      onProgress({ loaded, total, speed, percent }) {
        // Progress bar
        progFill.style.width = total > 0 ? `${percent.toFixed(1)}%` : '40%';

        // Info line: "45.2 MB / 150.0 MB  ·  3.1 MB/s  ·  30%"
        const parts = [];
        parts.push(total > 0 ? `${formatSize(loaded)} / ${formatSize(total)}` : formatSize(loaded));
        if (speed > 0) parts.push(formatSpeed(speed));
        if (total > 0 && percent < 100) parts.push(`${percent.toFixed(0)}%`);
        progInfo.textContent = parts.join('  ·  ');

        subEl.textContent = total > 0 ? `Downloading — ${percent.toFixed(0)}%` : 'Downloading...';
      },
      onPhase(phase) {
        if (phase === 'picking') {
          subEl.textContent = 'Choose save location...';
        } else if (phase === 'preparing') {
          cardEl.classList.add('downloading');
          progInfo.classList.remove('hidden');
          progFill.style.width = '0%';
          progFill.classList.add('indeterminate');
          dlIcon.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>';
          subEl.textContent = '⏳ Preparing & merging on server...';
          progInfo.textContent = 'Waiting for server to process video...';
        } else if (phase === 'downloading') {
          progFill.classList.remove('indeterminate');
          subEl.textContent = 'Downloading...';
        }
      }
    });

    if (!result) {
      // User cancelled the save dialog
      subEl.textContent = originalSubtitle;
      return;
    }

    // ── Success ──
    progFill.style.width = '100%';
    progFill.classList.add('complete');
    subEl.textContent = '✓ Saved successfully!';
    progInfo.textContent = `Total: ${formatSize(result.totalSize)}`;
    dlIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    cardEl.classList.remove('downloading');
    cardEl.classList.add('download-complete');

    setTimeout(() => {
      subEl.textContent = originalSubtitle;
      progInfo.classList.add('hidden');
      progFill.style.width = '0%';
      progFill.classList.remove('complete');
      cardEl.classList.remove('download-complete');
      dlIcon.innerHTML = origDlHTML;
    }, 4000);
  } catch (err) {
    showError(err.message || 'Download failed. Please try again.');
    cardEl.classList.remove('downloading');
    subEl.textContent = originalSubtitle;
    progInfo.classList.add('hidden');
    progFill.style.width = '0%';
    progFill.classList.remove('indeterminate');
    dlIcon.innerHTML = origDlHTML;
  }
}


// ═════════════════════════════════════════════════════════════════════
// ── Render Formats (Advanced) ───────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function renderFormats() {
  formatsContainer.innerHTML = '';

  let formats;
  if (currentTab === 'combined')       formats = videoData.formats.filter(f => f.type === 'video+audio');
  else if (currentTab === 'videoonly') formats = videoData.formats.filter(f => f.type === 'video-only');
  else                                 formats = videoData.formats.filter(f => f.type === 'audio-only');

  if (formats.length === 0) {
    formatsContainer.innerHTML = `
      <div style="text-align:center;padding:2.5rem;color:var(--text-muted);">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto .75rem;opacity:.4"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        <p style="font-size:.9rem;font-weight:500">No formats available in this category</p>
        <p style="font-size:.78rem;margin-top:.3rem">Try another tab above</p>
      </div>`;
    return;
  }

  formats.forEach((fmt, i) => {
    const card = document.createElement('div');
    card.className = 'format-card';
    card.style.animationDelay = `${i * 50}ms`;

    const ql = getQualityLabel(fmt), qc = getQualityClass(fmt);
    const codec = getCodecInfo(fmt), sz = formatFileSize(fmt.filesize);
    const isVO = fmt.type === 'video-only';
    const fid = fmt.formatId;

    card.innerHTML = `
      <div class="format-quality-badge ${qc}">${ql}</div>
      <div class="format-details">
        <div class="format-details-primary">
          <span class="format-ext">${fmt.ext}</span>
          <span class="format-codec">${codec}</span>
        </div>
        <div class="format-details-secondary">
          ${fmt.resolution ? `<span class="format-resolution">${fmt.resolution}</span>` : ''}
          ${fmt.fps ? `<span class="format-fps">${fmt.fps}fps</span>` : ''}
          ${fmt.tbr ? `<span>${Math.round(fmt.tbr)} kbps</span>` : ''}
        </div>
        <div class="format-progress-info hidden"></div>
      </div>
      <div class="format-size">${sz}</div>
      <div class="format-btn-wrap">
        <button class="download-btn" data-fid="${fid}" data-merge="${isVO}"
                onclick="advancedDownload('${fid}', ${isVO}, this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
      <div class="format-card-progress-bar"><div class="format-card-progress-fill"></div></div>
    `;
    formatsContainer.appendChild(card);
  });
}


// ═════════════════════════════════════════════════════════════════════
// ── Advanced Format Download (with save-as + progress) ──────────────
// ═════════════════════════════════════════════════════════════════════

async function advancedDownload(formatId, needsMerge, btnEl) {
  const card      = btnEl.closest('.format-card');
  const progInfo  = card.querySelector('.format-progress-info');
  const progFill  = card.querySelector('.format-card-progress-fill');
  const origHTML  = btnEl.innerHTML;

  // Determine extension from the format badge text
  const extEl = card.querySelector('.format-ext');
  const ext   = extEl ? `.${extEl.textContent.trim().toLowerCase()}` : '.mp4';
  const title = sanitizeFilename(videoData.title);
  const suggestedName = `${title}${needsMerge ? '.mp4' : ext}`;

  const isAudio = ext === '.mp3' || ext === '.m4a' || ext === '.ogg' || ext === '.opus';
  const fileTypes = isAudio
    ? [{ description: 'Audio', accept: { 'audio/*': [ext] } }]
    : [{ description: 'Video', accept: { 'video/*': [needsMerge ? '.mp4' : ext] } }];

  const fetchUrl = needsMerge
    ? `/api/download-merge?url=${encodeURIComponent(currentUrl)}&formatId=${encodeURIComponent(formatId)}`
    : `/api/download?url=${encodeURIComponent(currentUrl)}&formatId=${encodeURIComponent(formatId)}`;

  try {
    const result = await streamDownload({
      fetchUrl,
      suggestedName,
      fileTypes,
      onProgress({ loaded, total, speed, percent }) {
        if (total > 0) {
          progFill.style.width = `${percent.toFixed(1)}%`;
          btnEl.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> ${percent.toFixed(0)}%`;
        }
        const parts = [];
        parts.push(total > 0 ? `${formatSize(loaded)} / ${formatSize(total)}` : formatSize(loaded));
        if (speed > 0) parts.push(formatSpeed(speed));
        progInfo.textContent = parts.join('  ·  ');
      },
      onPhase(phase) {
        if (phase === 'picking') {
          btnEl.innerHTML = 'Save as…';
        } else if (phase === 'preparing') {
          btnEl.disabled = true;
          btnEl.classList.add('merging');
          btnEl.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> ${needsMerge ? 'Merge' : '0%'}`;
          progInfo.classList.remove('hidden');
          progInfo.textContent = needsMerge ? 'Server is merging video + audio...' : 'Starting download...';
          progFill.classList.add('indeterminate');
          card.classList.add('downloading');
        } else if (phase === 'downloading') {
          progFill.classList.remove('indeterminate');
        }
      }
    });

    if (!result) {
      // User cancelled save dialog
      btnEl.innerHTML = origHTML;
      return;
    }

    // Success
    progFill.style.width = '100%';
    progFill.classList.add('complete');
    progInfo.textContent = `✓ Saved · ${formatSize(result.totalSize)}`;
    btnEl.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Done`;
    btnEl.classList.remove('merging');
    card.classList.remove('downloading');

    setTimeout(() => {
      btnEl.innerHTML = origHTML;
      btnEl.disabled = false;
      progInfo.classList.add('hidden');
      progFill.style.width = '0%';
      progFill.classList.remove('complete');
    }, 3500);
  } catch (err) {
    showError(err.message || 'Download failed.');
    btnEl.innerHTML = origHTML;
    btnEl.disabled = false;
    btnEl.classList.remove('merging');
    card.classList.remove('downloading');
    progInfo.classList.add('hidden');
    progFill.style.width = '0%';
    progFill.classList.remove('indeterminate');
  }
}


// ═════════════════════════════════════════════════════════════════════
// ── Format Helpers ──────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function getQualityLabel(f) {
  if (f.type === 'audio-only') return f.tbr ? `${Math.round(f.tbr)}k` : 'Audio';
  const h = f.height;
  if (h >= 2160) return '4K'; if (h >= 1440) return '2K'; if (h >= 1080) return '1080p';
  if (h >= 720) return '720p'; if (h >= 480) return '480p'; if (h >= 360) return '360p';
  if (h >= 240) return '240p'; if (h >= 144) return '144p';
  return f.quality || f.resolution || '—';
}

function getQualityClass(f) {
  if (f.type === 'audio-only') return 'q-audio';
  const h = f.height;
  if (h >= 2160) return 'q-4k'; if (h >= 1440) return 'q-2k'; if (h >= 1080) return 'q-1080';
  if (h >= 720) return 'q-720'; if (h >= 480) return 'q-480'; if (h >= 360) return 'q-360';
  return 'q-low';
}

function getCodecInfo(f) {
  const p = [];
  if (f.vcodec) p.push(simplifyCodec(f.vcodec));
  if (f.acodec) p.push(simplifyCodec(f.acodec));
  return p.join(' · ');
}

function simplifyCodec(c) {
  if (!c) return '';
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'VP9';
  if (c.startsWith('vp8')) return 'VP8';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'H.265';
  if (c.startsWith('mp4a') || c.startsWith('aac')) return 'AAC';
  if (c.startsWith('opus')) return 'Opus';
  if (c.startsWith('vorbis')) return 'Vorbis';
  if (c.startsWith('mp3')) return 'MP3';
  return c.split('.')[0];
}

function formatFileSize(b) {
  if (!b || b <= 0) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function formatDuration(s) {
  if (!s || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

function setLoading(on) {
  fetchBtn.disabled = on;
  fetchBtn.classList.toggle('loading', on);
  urlInput.disabled = on;
  pasteBtn.disabled = on;
}

function showError(msg) {
  errorText.textContent = msg;
  errorToast.classList.add('visible');
  setTimeout(hideError, 8000);
}

function hideError() { errorToast.classList.remove('visible'); }

function resetUI() {
  resultsSection.classList.add('hidden');
  urlInput.value = '';
  urlInput.setAttribute('value', '');
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  fetchBtn.disabled = true;
  videoData = null;
  currentUrl = '';
  currentTab = 'combined';
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addEventListener('load', () => {
  // Use setTimeout to ensure focus works after browser's initial layout
  setTimeout(() => urlInput.focus(), 100);
  generateBackgroundIcons();
});


// ═════════════════════════════════════════════════════════════════════
// ── 3D Floating Background Icons ────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════

function generateBackgroundIcons() {
  const container = document.getElementById('bgIcons');
  if (!container) return;

  // Icon definitions: SVG path + brand color
  const icons = [
    { // YouTube
      svg: '<svg viewBox="0 0 24 24" fill="#FF0033"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.55A3.02 3.02 0 0 0 .5 6.19 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14c1.87.55 9.38.55 9.38.55s7.5 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.81zM9.75 15.02V8.98L15.5 12l-5.75 3.02z"/></svg>',
      glow: 'rgba(255,0,51,0.15)', bg: 'rgba(255,0,51,0.08)', border: 'rgba(255,0,51,0.15)'
    },
    { // Instagram
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#E4405F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
      glow: 'rgba(228,64,95,0.15)', bg: 'rgba(228,64,95,0.08)', border: 'rgba(228,64,95,0.15)'
    },
    { // TikTok
      svg: '<svg viewBox="0 0 24 24" fill="#ff0050"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1 0-5.78c.29 0 .58.04.85.12V9.01a6.27 6.27 0 0 0-.85-.06 6.34 6.34 0 0 0 0 12.68 6.34 6.34 0 0 0 6.34-6.34V9.06a8.27 8.27 0 0 0 4.84 1.56V7.19a4.85 4.85 0 0 1-1.08-.5z"/></svg>',
      glow: 'rgba(255,0,80,0.15)', bg: 'rgba(255,0,80,0.08)', border: 'rgba(255,0,80,0.15)'
    },
    { // Facebook
      svg: '<svg viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
      glow: 'rgba(24,119,242,0.15)', bg: 'rgba(24,119,242,0.08)', border: 'rgba(24,119,242,0.15)'
    },
    { // Snapchat
      svg: '<svg viewBox="0 0 24 24" fill="#FFFC00"><path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12.922-.27.086-.05.171-.09.263-.12a.558.558 0 0 1 .206-.045c.24 0 .401.12.45.314.06.227-.042.48-.306.654-.39.254-.855.375-1.26.435-.046.78.105.132.12.198.015.1.02.19.025.271 0 .015.06.135.06.135-.24 5.103-5.983 5.583-6.295 5.607-.042 0-.12.015-.155.015h-.007c-.035 0-.113-.015-.155-.015-.313-.024-6.057-.504-6.297-5.607 0 0 .06-.12.06-.135.005-.081.01-.171.025-.271.015-.066.076-.12.12-.198-.405-.06-.87-.18-1.26-.435-.264-.174-.366-.427-.306-.654.049-.194.21-.314.45-.314a.558.558 0 0 1 .206.045c.092.03.177.07.263.12.263.15.622.284.922.27.198 0 .326-.045.401-.09a9.76 9.76 0 0 1-.033-.57c-.104-1.628-.23-3.654.3-4.847C5.66 1.069 9.016.793 10.006.793h1.2z"/></svg>',
      glow: 'rgba(255,252,0,0.12)', bg: 'rgba(255,252,0,0.06)', border: 'rgba(255,252,0,0.12)'
    },
    { // Twitter/X
      svg: '<svg viewBox="0 0 24 24" fill="#f0f0f5"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
      glow: 'rgba(240,240,245,0.1)', bg: 'rgba(240,240,245,0.04)', border: 'rgba(240,240,245,0.08)'
    },
    { // Twitch
      svg: '<svg viewBox="0 0 24 24" fill="#9146FF"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>',
      glow: 'rgba(145,70,255,0.15)', bg: 'rgba(145,70,255,0.08)', border: 'rgba(145,70,255,0.15)'
    },
    { // Vimeo
      svg: '<svg viewBox="0 0 24 24" fill="#1AB7EA"><path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.603 8.816 3.834 7.52 3.014 7.52c-.177 0-.794.372-1.85 1.114L0 7.197a313.1 313.1 0 0 0 3.501-3.128C5.08 2.701 6.266 1.984 7.055 1.91c1.867-.18 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.507.539 2.45 1.131 3.674 1.776 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.868 3.434-5.757 6.762-5.637 2.473.06 3.628 1.664 3.493 4.797z"/></svg>',
      glow: 'rgba(26,183,234,0.15)', bg: 'rgba(26,183,234,0.08)', border: 'rgba(26,183,234,0.15)'
    },
    { // Reddit
      svg: '<svg viewBox="0 0 24 24" fill="#FF4500"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 0-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>',
      glow: 'rgba(255,69,0,0.15)', bg: 'rgba(255,69,0,0.08)', border: 'rgba(255,69,0,0.15)'
    },
    { // Play button (generic)
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      glow: 'rgba(139,92,246,0.15)', bg: 'rgba(139,92,246,0.06)', border: 'rgba(139,92,246,0.12)'
    },
    { // Download arrow
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      glow: 'rgba(6,182,212,0.15)', bg: 'rgba(6,182,212,0.06)', border: 'rgba(6,182,212,0.12)'
    },
    { // Film strip
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>',
      glow: 'rgba(236,72,153,0.15)', bg: 'rgba(236,72,153,0.06)', border: 'rgba(236,72,153,0.12)'
    },
    { // Music note
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      glow: 'rgba(16,185,129,0.15)', bg: 'rgba(16,185,129,0.06)', border: 'rgba(16,185,129,0.12)'
    },
    { // Spotify
      svg: '<svg viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
      glow: 'rgba(29,185,84,0.15)', bg: 'rgba(29,185,84,0.08)', border: 'rgba(29,185,84,0.15)'
    },
    { // Pinterest
      svg: '<svg viewBox="0 0 24 24" fill="#E60023"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641 0 12.017 0z"/></svg>',
      glow: 'rgba(230,0,35,0.12)', bg: 'rgba(230,0,35,0.06)', border: 'rgba(230,0,35,0.12)'
    },
    { // Cloud
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
      glow: 'rgba(59,130,246,0.15)', bg: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.12)'
    }
  ];

  // Generate 22 icons scattered across the viewport
  const count = 22;
  const placed = []; // Track positions to avoid overlap

  for (let i = 0; i < count; i++) {
    const icon = icons[i % icons.length];

    // Random properties
    const size = 40 + Math.random() * 35;         // 40–75px
    const opacity = 0.25 + Math.random() * 0.3;   // 0.25–0.55
    const duration = 14 + Math.random() * 16;      // 14–30s
    const delay = -(Math.random() * 20);           // stagger start
    const rx = -20 + Math.random() * 40;           // -20 to +20 deg
    const ry = -25 + Math.random() * 50;           // -25 to +25 deg

    // Random position — avoid center column where content lives
    let left, top;
    let attempts = 0;
    do {
      left = 2 + Math.random() * 92;   // 2%–94%
      top  = 2 + Math.random() * 92;
      attempts++;
    } while (
      attempts < 30 &&
      (
        // Avoid center content area (roughly 25%–75% horizontal, 5%–90% vertical)
        (left > 22 && left < 78 && top > 5 && top < 85) ||
        // Check minimum distance from other icons
        placed.some(p => Math.hypot(p.x - left, p.y - top) < 8)
      )
    );
    placed.push({ x: left, y: top });

    const el = document.createElement('div');
    el.className = 'bg-icon';
    el.innerHTML = icon.svg;
    el.style.cssText = `
      left: ${left}%;
      top: ${top}%;
      --icon-size: ${size}px;
      --icon-opacity: ${opacity};
      --icon-bg: ${icon.bg};
      --icon-border: ${icon.border};
      --icon-glow: ${icon.glow};
      --float-duration: ${duration}s;
      --float-delay: ${delay}s;
      --rx: ${rx}deg;
      --ry: ${ry}deg;
    `;

    container.appendChild(el);
  }
}
