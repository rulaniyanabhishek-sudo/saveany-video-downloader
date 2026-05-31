const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Binary paths ───────────────────────────────────────────────────────
// On Vercel serverless, filesystem is read-only except /tmp
const IS_VERCEL = !!process.env.VERCEL;
const BIN_DIR = IS_VERCEL ? '/tmp/bin' : path.join(__dirname, 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// ffmpeg-static provides a pre-built ffmpeg binary
let FFMPEG_PATH;
try {
  FFMPEG_PATH = require('ffmpeg-static');
  console.log('✓ ffmpeg-static found at:', FFMPEG_PATH);
} catch (e) {
  FFMPEG_PATH = null;
  console.warn('⚠ ffmpeg-static not found. Merging video+audio will fail.');
}

// ── yt-dlp download ────────────────────────────────────────────────────
function getYtDlpDownloadUrl() {
  const platform = process.platform;
  if (platform === 'win32') return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  if (platform === 'darwin') return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.dirname(dest))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : http).get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }
      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          process.stdout.write(`\r  Downloading yt-dlp: ${pct}% (${(downloadedBytes / 1048576).toFixed(1)} MB)`);
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\n  yt-dlp downloaded successfully!');
        if (process.platform !== 'win32') fs.chmodSync(dest, '755');
        resolve();
      });
    });
    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('✓ yt-dlp binary found');
    return;
  }
  console.log('⏳ Downloading yt-dlp binary...');
  await downloadFile(getYtDlpDownloadUrl(), YTDLP_PATH);
  console.log('✓ yt-dlp ready');
}

// ── Common yt-dlp args (always include ffmpeg location) ────────────────
function baseArgs() {
  const args = ['--no-warnings', '--no-check-certificates'];
  if (FFMPEG_PATH) {
    args.push('--ffmpeg-location', path.dirname(FFMPEG_PATH));
  }
  return args;
}

// ── Middleware ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Extract video info ────────────────────────────────────────────
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid URL' });
  }
  try {
    const info = await getVideoInfo(url.trim());
    res.json(info);
  } catch (err) {
    console.error('Info extraction error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to extract video info' });
  }
});

// ── API: Direct download (single stream, no merge needed) ──────────────
app.get('/api/download', async (req, res) => {
  const { url, formatId } = req.query;
  if (!url || !formatId) {
    return res.status(400).json({ error: 'Missing url or formatId' });
  }
  try {
    const filenameArgs = [...baseArgs(), '--print', 'filename', '-o', '%(title)s.%(ext)s', '-f', formatId, url];
    const filename = await runYtDlp(filenameArgs);
    const cleanFilename = filename.trim().replace(/[<>:"/\\|?*]/g, '_') || 'video.mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cleanFilename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const downloadArgs = [...baseArgs(), '-f', formatId, '-o', '-', url];
    const proc = spawn(YTDLP_PATH, downloadArgs);

    proc.stdout.pipe(res);
    proc.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));
    proc.on('error', (err) => {
      console.error('Spawn error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
    proc.on('close', (code) => {
      if (code !== 0 && !res.headersSent) res.status(500).json({ error: 'Download process exited with error' });
    });
    req.on('close', () => proc.kill());
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── API: Download with merge (video+audio) ─────────────────────────────
app.get('/api/download-merge', async (req, res) => {
  const { url, formatId } = req.query;
  if (!url || !formatId) {
    return res.status(400).json({ error: 'Missing url or formatId' });
  }
  if (!FFMPEG_PATH) {
    return res.status(500).json({ error: 'ffmpeg not available — cannot merge video+audio' });
  }

  try {
    const tmpDir = process.platform === 'win32' ? path.join(__dirname, 'tmp') : '/tmp';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = Date.now();
    const tmpFile = path.join(tmpDir, `dl_${stamp}`);

    // Get title
    let title = 'video';
    try {
      title = (await runYtDlp([...baseArgs(), '--print', '%(title)s', url])).trim().replace(/[<>:"/\\|?*]/g, '_') || 'video';
    } catch (e) { /* fallback */ }

    const downloadArgs = [
      ...baseArgs(),
      '-f', `${formatId}+bestaudio/best`,
      '--merge-output-format', 'mp4',
      '-o', tmpFile + '.%(ext)s',
      url
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, downloadArgs);
      let stderr = '';
      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      });
      setTimeout(() => { proc.kill(); reject(new Error('Download timed out (10 min)')); }, 600000);
    });

    // Find the actual output file (extension may vary)
    const prefix = `dl_${stamp}`;
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix));
    const outputFile = files.length > 0 ? path.join(tmpDir, files[0]) : tmpFile + '.mp4';

    if (!fs.existsSync(outputFile)) {
      return res.status(500).json({ error: 'Merged file not found' });
    }

    const stat = fs.statSync(outputFile);
    const ext = path.extname(outputFile) || '.mp4';
    const filename = `${title}${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ } });
    stream.on('error', () => { try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ } });
  } catch (err) {
    console.error('Merge download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── API: Quick quality download (preset quality with auto-merge) ───────
app.get('/api/download-quality', async (req, res) => {
  const { url, quality } = req.query;
  if (!url || !quality) {
    return res.status(400).json({ error: 'Missing url or quality' });
  }
  if (!FFMPEG_PATH) {
    return res.status(500).json({ error: 'ffmpeg not available — cannot merge video+audio' });
  }

  // Map quality presets to yt-dlp format strings
  const qualityFormats = {
    'best':   'bestvideo+bestaudio/best',
    '4k':     'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
    '1440p':  'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
    '1080p':  'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720p':   'bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480p':   'bestvideo[height<=480]+bestaudio/best[height<=480]',
    '360p':   'bestvideo[height<=360]+bestaudio/best[height<=360]',
    'audio':  'bestaudio/best'
  };

  const formatStr = qualityFormats[quality];
  if (!formatStr) {
    return res.status(400).json({ error: `Invalid quality preset: ${quality}` });
  }

  try {
    const tmpDir = process.platform === 'win32' ? path.join(__dirname, 'tmp') : '/tmp';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = Date.now();
    const tmpFile = path.join(tmpDir, `ql_${stamp}`);

    // Get title
    let title = 'video';
    try {
      title = (await runYtDlp([...baseArgs(), '--print', '%(title)s', url])).trim().replace(/[<>:"/\\|?*]/g, '_') || 'video';
    } catch (e) { /* fallback */ }

    const isAudioOnly = quality === 'audio';
    const downloadArgs = [
      ...baseArgs(),
      '-f', formatStr,
      ...(isAudioOnly
        ? ['--extract-audio', '--audio-format', 'mp3', '-o', tmpFile + '.%(ext)s']
        : ['--merge-output-format', 'mp4', '-o', tmpFile + '.%(ext)s']
      ),
      url
    ];

    console.log(`[Quality Download] ${quality} → yt-dlp -f "${formatStr}"`);

    await new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, downloadArgs);
      let stderr = '';
      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      });
      // 15 min timeout for large files
      setTimeout(() => { proc.kill(); reject(new Error('Download timed out')); }, 900000);
    });

    // Find output
    const prefix = `ql_${stamp}`;
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix));
    const outputFile = files.length > 0 ? path.join(tmpDir, files[0]) : tmpFile + (isAudioOnly ? '.mp3' : '.mp4');

    if (!fs.existsSync(outputFile)) {
      return res.status(500).json({ error: 'Output file not found' });
    }

    const stat = fs.statSync(outputFile);
    const ext = path.extname(outputFile) || (isAudioOnly ? '.mp3' : '.mp4');
    const filename = `${title}_${quality}${ext}`;
    const mimeType = isAudioOnly ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(outputFile); } catch (e) {} });
    stream.on('error', () => { try { fs.unlinkSync(outputFile); } catch (e) {} });
  } catch (err) {
    console.error('Quality download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
    setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timed out')); }, 30000);
  });
}

async function getVideoInfo(url) {
  const args = [...baseArgs(), '--dump-json', '--no-download', url];
  const raw = await runYtDlp(args);
  const data = JSON.parse(raw);

  const platform = detectPlatform(url, data.extractor || data.extractor_key || '');

  // Process formats
  const formats = (data.formats || [])
    .filter(f => f.url || f.manifest_url)
    .map(f => {
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      let type = 'unknown';
      if (hasVideo && hasAudio) type = 'video+audio';
      else if (hasVideo) type = 'video-only';
      else if (hasAudio) type = 'audio-only';

      return {
        formatId: f.format_id,
        ext: f.ext || 'mp4',
        quality: f.format_note || f.quality || '',
        resolution: f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : ''),
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        filesize: f.filesize || f.filesize_approx || 0,
        vcodec: hasVideo ? f.vcodec : null,
        acodec: hasAudio ? f.acodec : null,
        type,
        tbr: f.tbr || 0
      };
    })
    .filter(f => f.type !== 'unknown')
    .sort((a, b) => {
      const typeOrder = { 'video+audio': 0, 'video-only': 1, 'audio-only': 2 };
      const typeDiff = (typeOrder[a.type] || 3) - (typeOrder[b.type] || 3);
      if (typeDiff !== 0) return typeDiff;
      return (b.height || 0) - (a.height || 0);
    });

  // Determine which quality presets are available, with estimated sizes
  const allVideoFormats = formats.filter(f => f.type === 'video+audio' || f.type === 'video-only');
  const allAudioFormats = formats.filter(f => f.type === 'audio-only');
  const maxHeight = allVideoFormats.reduce((max, f) => Math.max(max, f.height || 0), 0);

  // Best audio filesize (for estimating merged totals)
  const bestAudioSize = allAudioFormats.reduce((max, f) => Math.max(max, f.filesize || 0), 0);

  function estimateSize(heightLimit) {
    // Find the best video format at or below this height
    const candidates = allVideoFormats.filter(f => f.height && f.height <= heightLimit);
    if (candidates.length === 0) return 0;
    // Pick the one closest to the height limit (highest quality), preferring the one with filesize
    candidates.sort((a, b) => (b.height - a.height) || ((b.filesize || 0) - (a.filesize || 0)));
    const best = candidates[0];
    const videoSize = best.filesize || 0;
    // If it's video-only, add audio
    if (best.type === 'video-only') return videoSize + bestAudioSize;
    return videoSize;
  }

  const availableQualities = [];
  if (maxHeight >= 2160) availableQualities.push({ key: '4k', label: '4K', subtitle: '2160p · Ultra HD', height: 2160, estimatedSize: estimateSize(2160) });
  if (maxHeight >= 1440) availableQualities.push({ key: '1440p', label: '2K', subtitle: '1440p · Quad HD', height: 1440, estimatedSize: estimateSize(1440) });
  if (maxHeight >= 1080) availableQualities.push({ key: '1080p', label: '1080p', subtitle: 'Full HD', height: 1080, estimatedSize: estimateSize(1080) });
  if (maxHeight >= 720)  availableQualities.push({ key: '720p', label: '720p', subtitle: 'HD', height: 720, estimatedSize: estimateSize(720) });
  if (maxHeight >= 480)  availableQualities.push({ key: '480p', label: '480p', subtitle: 'SD', height: 480, estimatedSize: estimateSize(480) });
  if (maxHeight >= 360)  availableQualities.push({ key: '360p', label: '360p', subtitle: 'Low', height: 360, estimatedSize: estimateSize(360) });

  const hasAudio = formats.some(f => f.type === 'audio-only');

  return {
    title: data.title || 'Untitled Video',
    thumbnail: data.thumbnail || data.thumbnails?.[data.thumbnails.length - 1]?.url || '',
    duration: data.duration || 0,
    uploader: data.uploader || data.channel || '',
    platform,
    formats,
    availableQualities,
    hasAudio,
    bestAudioSize,
    maxHeight
  };
}

function detectPlatform(url, extractor) {
  const u = url.toLowerCase();
  const e = extractor.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be') || e.includes('youtube')) return 'youtube';
  if (u.includes('instagram.com') || e.includes('instagram')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || e.includes('facebook')) return 'facebook';
  if (u.includes('snapchat.com') || e.includes('snapchat')) return 'snapchat';
  if (u.includes('tiktok.com') || e.includes('tiktok')) return 'tiktok';
  if (u.includes('twitter.com') || u.includes('x.com') || e.includes('twitter')) return 'twitter';
  if (u.includes('vimeo.com') || e.includes('vimeo')) return 'vimeo';
  if (u.includes('reddit.com') || e.includes('reddit')) return 'reddit';
  if (u.includes('twitch.tv') || e.includes('twitch')) return 'twitch';
  if (u.includes('dailymotion.com') || e.includes('dailymotion')) return 'dailymotion';
  return 'other';
}

// ── Start server ───────────────────────────────────────────────────────
if (IS_VERCEL) {
  // On Vercel, download the binary asynchronously and export the app
  ensureYtDlp().catch(err => console.error('Failed to download yt-dlp:', err));
  module.exports = app;
} else {
  (async () => {
    try {
      await ensureYtDlp();
      app.listen(PORT, () => {
        console.log(`\n🚀 Video Downloader running at http://localhost:${PORT}\n`);
      });
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  })();
}
