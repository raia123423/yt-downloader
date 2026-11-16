// Wrapper em torno dos binários yt-dlp / ffmpeg / deno.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

// Ambiente para forçar saída UTF-8 (títulos com acentos/emoji no Windows).
const CHILD_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

function runCapture(file, args, { onLine, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { env: CHILD_ENV, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('Tempo esgotado ao executar o yt-dlp.'));
      }, timeoutMs);
    }
    const lineSplitter = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (stream === 'out') stdout += text;
      else stderr += text;
      if (onLine) text.split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l, stream));
    };
    child.stdout.on('data', (c) => lineSplitter(c, 'out'));
    child.stderr.on('data', (c) => lineSplitter(c, 'err'));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function extractError(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => l.startsWith('ERROR:'));
  let msg = (err || lines[0] || 'Erro desconhecido').replace(/^ERROR:\s*/, '');
  if (/could not (copy|find).*cookie|failed to decrypt|cookies database/i.test(msg)) {
    msg += ' (Não foi possível ler os cookies do navegador. Feche o navegador e tente de novo, use o Firefox ou um arquivo cookies.txt.)';
  } else if (/sign in to confirm/i.test(msg)) {
    msg += ' (Tente ativar os cookies do navegador nas Configurações.)';
  }
  return msg;
}

// Compara versões no formato AAAA.MM.DD[.N]. Retorna > 0 se a > b.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const COOKIE_BROWSERS = ['firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'];

function cookieArgs(settings) {
  const src = settings.cookiesSource;
  if (src === 'file' && settings.cookiesFile) return ['--cookies', settings.cookiesFile];
  if (COOKIE_BROWSERS.includes(src)) return ['--cookies-from-browser', src];
  return [];
}

class YtDlp {
  /**
   * @param {object} opts
   * @param {string} opts.bundledDir pasta com os binários embutidos (resources/bin)
   * @param {string} opts.userBinDir pasta gravável onde fica a cópia atualizável do yt-dlp
   * @param {() => object} [opts.getSettings] configurações atuais (cookies etc.)
   */
  constructor({ bundledDir, userBinDir, getSettings }) {
    this.bundledDir = bundledDir;
    this.userBinDir = userBinDir;
    this.getSettings = getSettings || (() => ({}));
    this.ytdlpPath = path.join(userBinDir, exe('yt-dlp'));
    this.ffmpegPath = path.join(bundledDir, exe('ffmpeg'));
    this.ffprobePath = path.join(bundledDir, exe('ffprobe'));
    this.denoPath = path.join(bundledDir, exe('deno'));
    this.version = null;
  }

  get hasFfmpeg() {
    return fs.existsSync(this.ffmpegPath);
  }

  get canConvert() {
    return this.hasFfmpeg && fs.existsSync(this.ffprobePath);
  }

  /** Lê os streams de um arquivo de mídia com o ffprobe. */
  async probe(file) {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];
    const { code, stdout } = await runCapture(this.ffprobePath, args, { timeoutMs: 60000 });
    if (code !== 0) return null;
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  /**
   * Descobre qual codificador H.264 da placa de vídeo funciona nesta máquina
   * (NVIDIA, Intel ou AMD) com uma codificação de teste. O resultado fica em cache.
   * Retorna null se nenhum funcionar (usa o processador).
   */
  detectGpuEncoder() {
    if (!this._gpuEncoder) {
      this._gpuEncoder = (async () => {
        if (!this.hasFfmpeg) return null;
        for (const enc of GPU_ENCODERS) {
          const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '0.5',
            '-c:v', enc, '-pix_fmt', 'nv12', '-f', 'null', '-'];
          try {
            const { code } = await runCapture(this.ffmpegPath, args, { timeoutMs: 20000 });
            if (code === 0) return enc;
          } catch {
            /* tenta o próximo */
          }
        }
        return null;
      })();
    }
    return this._gpuEncoder;
  }

  spawnFfmpeg(args) {
    return spawn(this.ffmpegPath, args, { env: CHILD_ENV, windowsHide: true });
  }

  get hasDeno() {
    return fs.existsSync(this.denoPath);
  }

  /**
   * O instalador coloca o yt-dlp em "resources/bin" (que pode ser somente leitura,
   * ex.: Program Files). Copiamos para a pasta do usuário para permitir atualizar
   * pelo botão. Se o embutido for mais novo que a cópia, a cópia é substituída.
   */
  async init() {
    fs.mkdirSync(this.userBinDir, { recursive: true });
    const bundled = path.join(this.bundledDir, exe('yt-dlp'));
    const bundledExists = fs.existsSync(bundled);
    const userExists = fs.existsSync(this.ytdlpPath);

    if (bundledExists && !userExists) {
      fs.copyFileSync(bundled, this.ytdlpPath);
    } else if (bundledExists && userExists) {
      const [vb, vu] = await Promise.all([this._versionOf(bundled), this._versionOf(this.ytdlpPath)]);
      if (vb && (!vu || compareVersions(vb, vu) > 0)) fs.copyFileSync(bundled, this.ytdlpPath);
    }

    if (!fs.existsSync(this.ytdlpPath)) {
      // Fallback para desenvolvimento: yt-dlp instalado no PATH do sistema.
      this.ytdlpPath = exe('yt-dlp');
    } else if (!IS_WIN) {
      fs.chmodSync(this.ytdlpPath, 0o755);
    }

    this.version = await this._versionOf(this.ytdlpPath);
    return this.status();
  }

  status() {
    return {
      available: !!this.version,
      version: this.version,
      ffmpeg: this.hasFfmpeg,
      deno: this.hasDeno,
    };
  }

  async _versionOf(file) {
    try {
      const { code, stdout } = await runCapture(file, ['--version'], { timeoutMs: 30000 });
      return code === 0 ? stdout.trim() : null;
    } catch {
      return null;
    }
  }

  /** Argumentos comuns a todas as chamadas. */
  commonArgs() {
    const args = ['--ignore-config', '--no-color'];
    if (this.hasFfmpeg) args.push('--ffmpeg-location', this.bundledDir);
    // O YouTube exige um runtime JavaScript (Deno) para liberar todos os formatos.
    if (this.hasDeno) args.push('--js-runtimes', `deno:${this.denoPath}`);
    args.push(...cookieArgs(this.getSettings()));
    return args;
  }

  spawn(args) {
    return spawn(this.ytdlpPath, [...this.commonArgs(), ...args], { env: CHILD_ENV, windowsHide: true });
  }

  /** Busca metadados de um vídeo ou playlist. */
  async getInfo(url) {
    const args = [...this.commonArgs(), '-J', '--flat-playlist', '--no-warnings', url];
    const { code, stdout, stderr } = await runCapture(this.ytdlpPath, args, { timeoutMs: 120000 });
    if (code !== 0 || !stdout.trim()) throw new Error(extractError(stderr));
    const info = JSON.parse(stdout);
    return normalizeInfo(info);
  }

  /** Atualiza o yt-dlp (yt-dlp -U). */
  async update(onLine) {
    if (!path.isAbsolute(this.ytdlpPath)) {
      throw new Error('O yt-dlp em uso não é o do app; atualize-o pelo seu gerenciador de pacotes.');
    }
    const before = this.version;
    const { code, stderr, stdout } = await runCapture(this.ytdlpPath, ['-U'], { onLine, timeoutMs: 300000 });
    this.version = await this._versionOf(this.ytdlpPath);
    if (code !== 0) throw new Error(extractError(stderr || stdout));
    return { before, after: this.version, updated: before !== this.version };
  }

  /** Consulta a última versão publicada no GitHub, sem atualizar. */
  async latestVersion() {
    const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yt-downloader' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const data = await res.json();
    return String(data.tag_name || '').trim() || null;
  }
}

function bestThumb(info) {
  if (info.thumbnail) return info.thumbnail;
  const t = info.thumbnails;
  if (Array.isArray(t) && t.length) return t[t.length - 1].url;
  return null;
}

function normalizeInfo(info) {
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || [])
      .filter(Boolean)
      .map((e) => ({
        id: e.id,
        title: e.title || e.id,
        url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        duration: e.duration || null,
        thumbnail: bestThumb(e),
        uploader: e.uploader || e.channel || null,
        isLive: e.live_status === 'is_live' || e.live_status === 'is_upcoming',
      }));
    return {
      type: 'playlist',
      id: info.id,
      title: info.title || 'Playlist',
      uploader: info.uploader || info.channel || null,
      thumbnail: bestThumb(info) || (entries[0] && entries[0].thumbnail),
      entries,
    };
  }

  const formats = info.formats || [];
  const isAudioOnly = (f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none';
  const audio = formats.filter(isAudioOnly).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const audioSize = audio ? audio.filesize || audio.filesize_approx || 0 : 0;

  // Faixas de áudio em idiomas diferentes (vídeos dublados).
  const langs = new Map();
  for (const f of formats) {
    if (!isAudioOnly(f) || !f.language) continue;
    const original = (f.language_preference || 0) >= 10 || /original/i.test(f.format_note || '');
    const cur = langs.get(f.language);
    langs.set(f.language, { code: f.language, original: original || !!(cur && cur.original) });
  }
  const audioLangs = langs.size > 1 ? [...langs.values()].sort((a, b) => b.original - a.original) : [];

  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const size = f.filesize || f.filesize_approx || 0;
    const cur = byHeight.get(f.height) || { height: f.height, fps: 0, size: 0 };
    cur.fps = Math.max(cur.fps, f.fps || 0);
    if (/^(avc1|h264)/i.test(f.vcodec)) cur.h264 = true;
    cur.size = Math.max(cur.size, size);
    byHeight.set(f.height, cur);
  }
  const qualities = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((q) => ({ height: q.height, fps: q.fps, h264: !!q.h264, approxSize: q.size ? q.size + audioSize : null }));

  return {
    type: 'video',
    id: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || null,
    duration: info.duration || null,
    thumbnail: bestThumb(info),
    url: info.webpage_url || info.original_url,
    isLive: info.live_status ? info.live_status === 'is_live' : !!info.is_live,
    isUpcoming: info.live_status === 'is_upcoming',
    qualities,
    audioSize,
    audioLangs,
  };
}

/**
 * Converte a escolha da interface em argumentos do yt-dlp.
 * quality: 'best' | número (altura) | 'audio-m4a' | 'audio-mp3'
 * container: 'mp4' | 'mkv'
 * audioLang: código do idioma da faixa de áudio (opcional)
 */
function formatArgs(quality, container = 'mp4', audioLang = null) {
  const lang = audioLang && /^[\w-]+$/.test(audioLang) ? `[language=${audioLang}]` : '';
  // Com idioma escolhido, tenta primeiro a faixa nesse idioma e depois a padrão.
  const withLang = (build) => (lang ? `${build(lang)}/${build('')}` : build(''));

  if (quality === 'audio-mp3') {
    return ['-f', `${withLang((l) => `ba${l}`)}/b`, '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
  if (quality === 'audio-m4a') {
    return ['-f', `${withLang((l) => `ba[ext=m4a]${l}/ba${l}`)}/b`, '-x', '--audio-format', 'm4a'];
  }
  const h = quality === 'best' ? null : Number(quality);
  const lim = h ? `[height<=${h}]` : '';
  const fmt = `${withLang((l) => `bv*${lim}+ba${l}`)}/b${lim}/b`;
  if (container === 'mp4') {
    // Premiere não abre AV1/VP9/Opus: na mesma resolução, prefere H.264 + AAC.
    // Se a resolução escolhida só existir em AV1/VP9, o arquivo é convertido depois.
    const res = h ? `res:${h}` : 'res';
    return ['-f', fmt, '-S', `${res},fps,vcodec:h264,acodec:aac,ext:mp4:m4a`, '--merge-output-format', 'mp4'];
  }
  return ['-f', fmt, '--merge-output-format', container];
}

// Codificadores H.264 por hardware, na ordem de preferência.
const GPU_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

// Opções de qualidade de cada codificador (alta qualidade, boa para edição).
// "i" é o índice do stream de saída, para as opções valerem só para o vídeo.
const ENCODER_OPTS = {
  libx264: (i) => [`-preset:${i}`, 'faster', `-crf:${i}`, '18', `-pix_fmt:${i}`, 'yuv420p'],
  h264_nvenc: (i) => [`-preset:${i}`, 'p5', `-tune:${i}`, 'hq', `-rc:${i}`, 'vbr', `-cq:${i}`, '23', `-b:${i}`, '0',
    `-spatial-aq:${i}`, '1', `-pix_fmt:${i}`, 'nv12'],
  h264_qsv: (i) => [`-preset:${i}`, 'medium', `-global_quality:${i}`, '22', `-pix_fmt:${i}`, 'nv12'],
  h264_amf: (i) => [`-quality:${i}`, 'quality', `-rc:${i}`, 'cqp', `-qp_i:${i}`, '18', `-qp_p:${i}`, '20', `-qp_b:${i}`, '22',
    `-pix_fmt:${i}`, 'nv12'],
};

// Codecs que o Premiere Pro importa sem problemas em MP4.
const PREMIERE_VIDEO = ['h264'];
const PREMIERE_AUDIO = ['aac', 'mp3'];

/**
 * Decide se um MP4 precisa ser convertido para abrir no Premiere e monta os
 * argumentos do ffmpeg. Retorna null se o arquivo já é compatível.
 * Só o vídeo principal é recodificado (H.264); áudio AAC, capa e legendas são copiados.
 */
function premiereConvertArgs(probe, input, output, encoder = 'libx264') {
  const encOpts = ENCODER_OPTS[encoder] || ENCODER_OPTS.libx264;
  const streams = (probe && probe.streams) || [];
  const isCover = (s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic;
  const video = streams.filter((s) => s.codec_type === 'video' && !isCover(s));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const badVideo = video.some((s) => !PREMIERE_VIDEO.includes(s.codec_name));
  const badAudio = audio.some((s) => !PREMIERE_AUDIO.includes(s.codec_name));
  if (!video.length || (!badVideo && !badAudio)) return null;

  const args = ['-hide_banner', '-nostats', '-y', '-i', input, '-map_metadata', '0'];
  const codecs = [];
  let out = 0;
  for (const s of streams) {
    let c;
    if (s.codec_type === 'video' && !isCover(s)) {
      c = PREMIERE_VIDEO.includes(s.codec_name)
        ? ['copy']
        : [ENCODER_OPTS[encoder] ? encoder : 'libx264', ...encOpts(out)];
    } else if (s.codec_type === 'audio') {
      c = PREMIERE_AUDIO.includes(s.codec_name) ? ['copy'] : ['aac', '-b:' + out, '256k'];
    } else if (isCover(s) || s.codec_type === 'subtitle') {
      c = ['copy'];
    } else {
      continue; // streams de dados não cabem no MP4
    }
    args.push('-map', `0:${s.index}`);
    codecs.push(`-c:${out}`, ...c);
    out += 1;
  }
  args.push(...codecs, '-movflags', '+faststart', '-progress', 'pipe:1', output);
  return { args, encoder, video: badVideo, audio: badAudio, duration: Number(probe.format && probe.format.duration) || null };
}

const SPONSOR_CATEGORIES = 'sponsor,selfpromo,interaction';

/** Argumentos extras de um download conforme as opções do usuário e do item. */
function optionArgs(job, settings) {
  const args = [];
  const isAudio = String(job.quality).startsWith('audio');
  if (settings.embedThumbnail) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  if (settings.embedSubs && !isAudio) {
    args.push('--embed-subs', '--sub-langs', settings.subLangs || 'pt.*,en.*');
    if (settings.autoSubs) args.push('--write-auto-subs');
  }
  if (settings.sponsorBlock) args.push('--sponsorblock-remove', SPONSOR_CATEGORIES);
  if (job.section) args.push('--download-sections', `*${job.section.start}-${job.section.end}`);
  return args;
}

// 65 -> "1-05", para usar no nome do arquivo.
function fileTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}-${String(m).padStart(2, '0')}-${sec}` : `${m}-${sec}`;
}

function outputTemplate(job) {
  const cut = job.section ? ` (trecho ${fileTime(job.section.start)} a ${fileTime(job.section.end)})` : '';
  return `%(title)s [%(id)s]${cut}.%(ext)s`;
}

module.exports = {
  YtDlp,
  formatArgs,
  premiereConvertArgs,
  optionArgs,
  outputTemplate,
  compareVersions,
  extractError,
  IS_WIN,
  COOKIE_BROWSERS,
};
