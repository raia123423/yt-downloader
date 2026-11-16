// Fila de downloads com concorrência configurável.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { formatArgs, premiereConvertArgs, optionArgs, outputTemplate, extractError, IS_WIN } = require('./ytdlp');

const P = '__P__';
const F = '__F__';
const PROGRESS_TEMPLATE =
  `download:${P}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

const MAX_CONCURRENCY = 4;
const ACTIVE = ['downloading', 'processing'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Eventos:
 *  - update(job)   mudança de estado/progresso de um item
 *  - removed(id)   item saiu da lista
 *  - done(job)     download concluído
 *  - changed()     a lista mudou de um jeito que vale salvar em disco
 */
class DownloadQueue extends EventEmitter {
  constructor(ytdlp, { concurrency = 2, getSettings } = {}) {
    super();
    this.ytdlp = ytdlp;
    this.getSettings = getSettings || (() => ({}));
    this.concurrency = clampConcurrency(concurrency);
    this.jobs = []; // ordem de exibição
    this.procs = new Map(); // id -> processo filho
    this._emitTimers = new Map();
    this._shuttingDown = false;
  }

  setConcurrency(n) {
    this.concurrency = clampConcurrency(n);
    this._pump();
  }

  list() {
    return this.jobs.map((j) => this._public(j));
  }

  get activeCount() {
    return this.jobs.filter((j) => ACTIVE.includes(j.status)).length;
  }

  /** Itens a salvar em disco. Os que estavam em andamento voltam para a fila. */
  snapshot() {
    return this.jobs.map((j) => {
      const pub = this._public(j);
      if (ACTIVE.includes(pub.status)) {
        Object.assign(pub, { status: 'queued', part: 0, phase: null, speed: null, eta: null });
      }
      return pub;
    });
  }

  /** Restaura itens salvos em uma execução anterior e retoma os pendentes. */
  restore(saved) {
    if (!Array.isArray(saved) || !saved.length) return;
    for (const j of saved) {
      if (!j || !j.id || !j.url || !j.outputDir) continue;
      if (ACTIVE.includes(j.status)) Object.assign(j, { status: 'queued', part: 0, phase: null, speed: null, eta: null });
      this.jobs.push(j);
    }
    this._pump();
  }

  add(items) {
    const added = items.map((it) => ({
      id: newId(),
      videoId: it.videoId || null,
      url: it.url,
      title: it.title || it.url,
      thumbnail: it.thumbnail || null,
      duration: it.duration || null,
      quality: it.quality,
      qualityLabel: it.qualityLabel || String(it.quality),
      container: it.container || 'mp4',
      audioLang: it.audioLang || null,
      section: validSection(it.section),
      outputDir: it.outputDir,
      status: 'queued',
      percent: 0,
      part: 0,
      downloaded: 0,
      total: null,
      speed: null,
      eta: null,
      filePath: null,
      error: null,
      addedAt: Date.now(),
      finishedAt: null,
    }));
    this.jobs.push(...added);
    added.forEach((j) => this._emit(j, true));
    this._pump();
    return added.map((j) => j.id);
  }

  cancel(id) {
    const job = this._get(id);
    if (!job) return;
    if (job.status === 'queued') {
      job.status = 'canceled';
      this._emit(job, true);
    } else if (ACTIVE.includes(job.status)) {
      job._canceled = true;
      this._kill(id);
    }
  }

  cancelAll() {
    this.jobs.forEach((j) => this.cancel(j.id));
  }

  retry(id) {
    const job = this._get(id);
    if (!job || !['error', 'canceled'].includes(job.status)) return;
    Object.assign(job, { status: 'queued', percent: 0, part: 0, phase: null, error: null, speed: null, eta: null, _canceled: false, _afterFinish: false });
    this._emit(job, true);
    this._pump();
  }

  remove(id) {
    const job = this._get(id);
    if (!job) return;
    if (this.procs.has(id)) {
      job._removeAfter = true;
      this.cancel(id);
      return;
    }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emit('removed', id);
    this.emit('changed');
  }

  clearFinished() {
    const keep = (j) => !['done', 'canceled', 'error'].includes(j.status);
    const removed = this.jobs.filter((j) => !keep(j)).map((j) => j.id);
    this.jobs = this.jobs.filter(keep);
    removed.forEach((id) => this.emit('removed', id));
    this.emit('changed');
  }

  /** Encerra os processos ao fechar o app. Os itens ficam salvos como pendentes. */
  killAll() {
    this._shuttingDown = true;
    for (const id of this.procs.keys()) this._kill(id);
  }

  // ---------------------------------------------------------------------------

  _get(id) {
    return this.jobs.find((j) => j.id === id);
  }

  _public(j) {
    const { _canceled, _removeAfter, _stderr, _afterFinish, ...rest } = j;
    return rest;
  }

  // Envia atualizações no máximo a cada 200 ms por item (progresso é bem verboso).
  // Atualizações imediatas são mudanças de estado, que também valem salvar.
  _emit(job, immediate = false) {
    if (immediate) {
      clearTimeout(this._emitTimers.get(job.id));
      this._emitTimers.delete(job.id);
      this.emit('update', this._public(job));
      this.emit('changed');
      return;
    }
    if (this._emitTimers.has(job.id)) return;
    this._emitTimers.set(
      job.id,
      setTimeout(() => {
        this._emitTimers.delete(job.id);
        this.emit('update', this._public(job));
      }, 200)
    );
  }

  _pump() {
    if (this._shuttingDown) return;
    while (this.procs.size < this.concurrency) {
      const next = this.jobs.find((j) => j.status === 'queued');
      if (!next) break;
      this._start(next);
    }
  }

  _start(job) {
    try {
      fs.mkdirSync(job.outputDir, { recursive: true });
    } catch (err) {
      // Sem a pasta não dá para baixar. Marca como erro para a fila seguir em frente.
      job.status = 'error';
      job.error = `Não foi possível criar a pasta de destino "${job.outputDir}": ${err.code || err.message}`;
      this._emit(job, true);
      return;
    }

    const settings = this.getSettings();
    const args = [
      ...formatArgs(job.quality, job.container, job.audioLang),
      ...optionArgs(job, settings),
      '--no-playlist',
      '--newline',
      '--progress',
      '--no-simulate',
      '--progress-template', PROGRESS_TEMPLATE,
      // Em JSON (só ASCII) para o caminho não ser corrompido pela codificação do console do Windows.
      '--print', `after_move:${F}%(filepath)j`,
      '--embed-metadata',
      '--windows-filenames',
      '--no-mtime',
      '-P', job.outputDir,
      '-o', outputTemplate(job),
      job.url,
    ];

    job.status = 'downloading';
    job.phase = null;
    job._stderr = '';
    job.error = null;
    this._emit(job, true);

    let child;
    try {
      child = this.ytdlp.spawn(args);
    } catch (err) {
      return this._finish(job, 1, err.message);
    }
    this.procs.set(job.id, child);

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach((l) => this._onLine(job, l));
    });
    child.stderr.on('data', (chunk) => {
      job._stderr = (job._stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (err) => this._finish(job, 1, err.message));
    child.on('close', (code) => {
      if (buf) this._onLine(job, buf);
      if (code === 0 && !job._canceled && !this._shuttingDown) this._afterDownload(job, child);
      else this._finish(job, code);
    });
  }

  /** MP4 de vídeo: garante H.264 + AAC (Premiere não importa AV1/VP9/Opus). */
  async _afterDownload(job, child) {
    const isVideo = !String(job.quality).startsWith('audio');
    if (job.container !== 'mp4' || !isVideo || !job.filePath || !this.ytdlp.canConvert) {
      return this._finish(job, 0);
    }
    let plan = null;
    try {
      const tmp = job.filePath.replace(/\.mp4$/i, '') + '.h264.tmp.mp4';
      const probe = await this.ytdlp.probe(job.filePath);
      const gpu = this.getSettings().gpuEncode !== false ? await this.ytdlp.detectGpuEncoder() : null;
      plan = premiereConvertArgs(probe, job.filePath, tmp, gpu || 'libx264');
      if (plan) Object.assign(plan, { tmp, probe });
    } catch {
      plan = null; // sem conseguir analisar, entrega o arquivo como veio
    }
    if (!plan || job._canceled || this._shuttingDown || this.procs.get(job.id) !== child) {
      return this._finish(job, job._canceled ? 1 : 0);
    }
    this._convert(job, plan);
  }

  _convert(job, plan) {
    job.status = 'processing';
    job.phase = 'convert';
    job.encoder = plan.encoder;
    job.percent = 0;
    job._stderr = '';
    this._emit(job, true);

    let ff;
    try {
      ff = this.ytdlp.spawnFfmpeg(plan.args);
    } catch (err) {
      return this._finish(job, 1, `Falha ao converter para H.264: ${err.message}`);
    }
    this.procs.set(job.id, ff);

    let buf = '';
    ff.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
        if (m && plan.duration) {
          job.percent = Math.min(100, (Number(m[1]) / 1e6 / plan.duration) * 100);
          this._emit(job);
        }
      }
    });
    ff.stderr.on('data', (chunk) => {
      job._stderr = (job._stderr + chunk.toString('utf8')).slice(-8000);
    });
    const rmTmp = () => fs.rmSync(plan.tmp, { force: true });
    ff.on('error', (err) => {
      try { rmTmp(); } catch { /* ignora */ }
      this._finish(job, 1, `Falha ao converter para H.264: ${err.message}`);
    });
    ff.on('close', (code) => {
      if (code === 0 && !job._canceled) {
        try {
          fs.renameSync(plan.tmp, job.filePath);
          return this._finish(job, 0);
        } catch (err) {
          try { rmTmp(); } catch { /* ignora */ }
          return this._finish(job, 1, `Não foi possível substituir o arquivo convertido: ${err.code || err.message}`);
        }
      }
      // Cancelado ou fechando o app: o temporário é descartado; ao retomar, o yt-dlp
      // reaproveita o arquivo já baixado e a conversão recomeça.
      if (code !== 0 && !job._canceled && !this._shuttingDown && plan.encoder !== 'libx264') {
        // A placa de vídeo falhou (driver, resolução não suportada...): refaz no processador.
        try { rmTmp(); } catch { /* ignora */ }
        return this._convert(job, { ...premiereConvertArgs(plan.probe, job.filePath, plan.tmp, 'libx264'), tmp: plan.tmp, probe: plan.probe });
      }
      setTimeout(() => { try { rmTmp(); } catch { /* ignora */ } }, 1000);
      const lines = (job._stderr || '').trim().split(/\r?\n/);
      this._finish(job, code || 1, `Falha ao converter para H.264: ${lines[lines.length - 1] || 'erro do ffmpeg'}`);
    });
  }

  _onLine(job, line) {
    line = line.trim();
    if (line.startsWith(P)) {
      const [status, done, total, estimate, speed, eta] = line.slice(P.length).split('|');
      if (status === 'downloading') {
        // Vídeo e áudio são baixados separadamente: cada um é uma "parte".
        if (job.part === 0 || job._afterFinish) {
          job.part += 1;
          job._afterFinish = false;
        }
        job.status = 'downloading';
        job.downloaded = num(done) || 0;
        job.total = num(total) || num(estimate);
        job.speed = num(speed);
        job.eta = num(eta);
        job.percent = job.total ? Math.min(100, (job.downloaded / job.total) * 100) : 0;
      } else if (status === 'finished') {
        job.percent = 100;
        job._afterFinish = true;
        job.status = 'processing';
        job.speed = null;
        job.eta = null;
      }
      this._emit(job);
    } else if (line.startsWith(F)) {
      const raw = line.slice(F.length);
      try {
        job.filePath = JSON.parse(raw);
      } catch {
        job.filePath = raw;
      }
    }
  }

  _finish(job, code, errMsg) {
    if (!this.procs.has(job.id) && !ACTIVE.includes(job.status)) return;
    this.procs.delete(job.id);
    // Fechando o app: o item continua salvo como pendente para ser retomado.
    if (this._shuttingDown && !job._canceled) return;
    job.speed = null;
    job.eta = null;
    job.phase = null;
    job.encoder = null;

    if (job._canceled) {
      job.status = 'canceled';
      this._cleanupPartials(job);
    } else if (code === 0) {
      job.status = 'done';
      job.percent = 100;
      try {
        if (job.filePath) job.total = fs.statSync(job.filePath).size;
      } catch {
        /* mantém o tamanho informado pelo yt-dlp */
      }
      job.finishedAt = Date.now();
      this.emit('done', this._public(job));
    } else {
      job.status = 'error';
      job.error = errMsg || extractError(job._stderr || '');
    }
    this._emit(job, true);

    if (job._removeAfter) {
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
      this.emit('removed', job.id);
      this.emit('changed');
    }
    this._pump();
  }

  _kill(id) {
    const child = this.procs.get(id);
    if (!child) return;
    if (IS_WIN) {
      // Mata também o ffmpeg filho.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }

  // Remove arquivos temporários (.part/.ytdl) deixados por um download cancelado.
  _cleanupPartials(job) {
    if (!job.videoId) return;
    setTimeout(() => {
      try {
        for (const name of fs.readdirSync(job.outputDir)) {
          if (name.includes(`[${job.videoId}]`) && /\.(part|ytdl)$|\.part-Frag\d+/.test(name)) {
            fs.rmSync(path.join(job.outputDir, name), { force: true });
          }
        }
      } catch {
        /* ignora */
      }
    }, 1000);
  }
}

function clampConcurrency(n) {
  return Math.max(1, Math.min(MAX_CONCURRENCY, Number(n) || 1));
}

function validSection(s) {
  if (!s) return null;
  const start = Number(s.start);
  const end = Number(s.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { start, end };
}

module.exports = { DownloadQueue };
