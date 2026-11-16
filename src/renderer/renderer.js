/* global api */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  settings: {},
  jobs: new Map(), // id -> job
  history: [],
  info: null,
  tab: 'queue',
};

// ----------------------------------------------------------------- utilitários
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtBytes(b) {
  if (!b && b !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDuration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const fmtEta = (s) => (s == null ? '' : fmtDuration(s) || '0:00');
const fmtDate = (ts) => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function sanitizeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'Playlist';
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

const thumbImg = (src) =>
  src ? `<img class="thumb" src="${esc(src)}" loading="lazy" alt="" />` : '<div class="thumb"></div>';

// "1:02:03", "2:30", "90" -> segundos. Retorna null se inválido.
function parseTime(text) {
  const t = String(text || '').trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

const langNames = (() => {
  try {
    return new Intl.DisplayNames(['pt-BR'], { type: 'language' });
  } catch {
    return null;
  }
})();
function langName(code) {
  try {
    const name = langNames && langNames.of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

// ----------------------------------------------------------------- duplicados
const ACTIVE_STATUS = ['queued', 'downloading', 'processing'];

function videoIdOf(item) {
  if (item.videoId) return item.videoId;
  const m = /[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})|\/shorts\/([\w-]{6,})/.exec(item.url || '');
  return m ? m[1] || m[2] || m[3] : null;
}

/** 'queue' se está na fila, 'history' se já foi baixado, null caso contrário. */
function duplicateOf(videoId) {
  if (!videoId) return null;
  for (const j of state.jobs.values()) {
    if (ACTIVE_STATUS.includes(j.status) && j.videoId === videoId) return 'queue';
  }
  if (state.history.some((h) => videoIdOf(h) === videoId)) return 'history';
  return null;
}

// ----------------------------------------------------------------- qualidade
const PRESET_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_OPTS = [
  { value: 'audio-m4a', label: 'Somente áudio (M4A)' },
  { value: 'audio-mp3', label: 'Somente áudio (MP3)' },
];

function qualityOptions(info) {
  const opts = [{ value: 'best', label: 'Melhor qualidade disponível' }];
  if (info && info.type === 'video' && info.qualities.length) {
    for (const q of info.qualities) {
      const fps = q.fps > 30 ? Math.round(q.fps) : '';
      const size = q.approxSize ? ` · ~${fmtBytes(q.approxSize)}` : '';
      // Sem H.264 nessa resolução: em MP4 o arquivo é convertido (mais demorado).
      const conv = q.h264 === false ? ' · converte p/ H.264' : '';
      opts.push({ value: String(q.height), label: `${q.height}p${fps}${size}${conv}` });
    }
  } else {
    PRESET_HEIGHTS.forEach((h) => opts.push({ value: String(h), label: `Até ${h}p` }));
  }
  return opts.concat(AUDIO_OPTS);
}

function pickDefaultQuality(opts) {
  const saved = String(state.settings.quality || 'best');
  if (opts.some((o) => o.value === saved)) return saved;
  const h = Number(saved);
  if (h) {
    const lower = opts.filter((o) => Number(o.value) && Number(o.value) <= h).map((o) => o.value);
    if (lower.length) return lower[0];
  }
  return 'best';
}

function qualityLabel(quality, container) {
  if (quality === 'audio-m4a') return 'Áudio M4A';
  if (quality === 'audio-mp3') return 'Áudio MP3';
  const c = container.toUpperCase();
  return quality === 'best' ? `Melhor · ${c}` : `${quality}p · ${c}`;
}

function optionsHtml(info) {
  const opts = qualityOptions(info);
  const sel = pickDefaultQuality(opts);
  const container = state.settings.container || 'mp4';
  return `
    <select class="q-select">
      ${opts.map((o) => `<option value="${o.value}" ${o.value === sel ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
    <select class="c-select" ${sel.startsWith('audio') ? 'hidden' : ''}>
      <option value="mp4" ${container === 'mp4' ? 'selected' : ''} title="H.264 + AAC, abre no Premiere Pro">MP4 (Premiere)</option>
      <option value="mkv" ${container === 'mkv' ? 'selected' : ''}>MKV</option>
    </select>`;
}

function wireOptions(root) {
  const q = $('.q-select', root);
  const c = $('.c-select', root);
  q.addEventListener('change', () => {
    c.hidden = q.value.startsWith('audio');
    api.setSettings({ quality: q.value }).then((s) => (state.settings = s));
  });
  c.addEventListener('change', () => api.setSettings({ container: c.value }).then((s) => (state.settings = s)));
  return () => ({ quality: q.value, container: c.value, label: qualityLabel(q.value, c.value) });
}

// ----------------------------------------------------------------- análise
async function analyze() {
  const url = $('#url').value.trim();
  const preview = $('#preview');
  if (!url) return $('#url').focus();
  if (!/^https?:\/\//i.test(url)) {
    preview.hidden = false;
    preview.innerHTML = '<div class="error-box">Isso não parece um link válido.</div>';
    return;
  }

  $('#btnAnalyze').disabled = true;
  preview.hidden = false;
  preview.innerHTML = '<div class="loading"><div class="spinner"></div>Buscando informações…</div>';

  const res = await api.getInfo(url);
  $('#btnAnalyze').disabled = false;

  if (!res.ok) {
    state.info = null;
    preview.innerHTML = `<div class="error-box">${esc(res.error)}</div>`;
    return;
  }
  state.info = res.info;
  if (res.info.type === 'playlist') renderPlaylist(res.info);
  else renderVideo(res.info);
}

function renderVideo(info) {
  const preview = $('#preview');
  const sub = [info.uploader, fmtDuration(info.duration)].filter(Boolean).join(' · ');

  // Transmissões ao vivo nunca "terminam" de baixar: só dá para baixar depois que acabam.
  if (info.isLive || info.isUpcoming) {
    preview.innerHTML = `
      <div class="video">
        ${thumbImg(info.thumbnail)}
        <div class="meta">
          <div class="title">${esc(info.title)}</div>
          <div class="sub">${esc(info.uploader || '')} · <b>${info.isLive ? 'AO VIVO' : 'AGENDADA'}</b></div>
          <div class="error-box">
            ${info.isLive
              ? 'Esta transmissão está ao vivo. O download só terminaria quando a live acabasse, então ele não é feito por aqui.'
              : 'Esta transmissão ainda não começou.'}
            Volte depois que ela terminar e o YouTube disponibilizar a gravação.
          </div>
        </div>
      </div>`;
    return;
  }

  const dup = duplicateOf(info.id);
  const langs = info.audioLangs || [];
  preview.innerHTML = `
    <div class="video">
      ${thumbImg(info.thumbnail)}
      <div class="meta">
        <div class="title">${esc(info.title)}</div>
        <div class="sub">${esc(sub)}</div>
        ${dup ? `<div class="dup-note">${dup === 'queue' ? 'Este vídeo já está na fila.' : 'Você já baixou este vídeo.'}</div>` : ''}
        <div class="options">
          ${optionsHtml(info)}
          ${langs.length ? `
            <select class="lang-select" title="Idioma do áudio">
              ${langs.map((l) => `<option value="${esc(l.code)}">${esc(langName(l.code))}${l.original ? ' (original)' : ''}</option>`).join('')}
            </select>` : ''}
          <button class="btn primary" id="btnDownload">Baixar</button>
        </div>
        ${info.duration ? `
          <div class="trim">
            <label class="trim-toggle"><input type="checkbox" id="trimOn" /> Baixar só um trecho</label>
            <span class="trim-fields" hidden>
              de <input type="text" id="trimStart" value="0:00" spellcheck="false" />
              até <input type="text" id="trimEnd" value="${fmtDuration(info.duration)}" spellcheck="false" />
            </span>
          </div>` : ''}
      </div>
    </div>`;
  const getOpts = wireOptions(preview);
  const trimOn = $('#trimOn');
  if (trimOn) trimOn.addEventListener('change', () => ($('.trim-fields').hidden = !trimOn.checked));

  $('#btnDownload').addEventListener('click', async () => {
    const o = getOpts();
    let section = null;
    if (trimOn && trimOn.checked) {
      const start = parseTime($('#trimStart').value);
      const end = parseTime($('#trimEnd').value);
      if (start == null || end == null) return toast('Use o formato m:ss ou h:mm:ss no trecho.', 'err');
      if (end <= start) return toast('O fim do trecho precisa ser depois do início.', 'err');
      if (start >= info.duration) return toast('O início do trecho passa da duração do vídeo.', 'err');
      section = { start, end: Math.min(end, Math.ceil(info.duration)) };
    }
    if (dup && !section) {
      const msg = dup === 'queue' ? 'Este vídeo já está na fila. Adicionar de novo?' : 'Você já baixou este vídeo. Baixar de novo?';
      if (!confirm(msg)) return;
    }
    const langSel = $('.lang-select', preview);
    const audioLang = langSel ? langSel.value : null;
    const langLabel = langSel && langSel.selectedIndex > 0 ? ` · ${langName(audioLang)}` : '';
    const cutLabel = section ? ` · ${fmtDuration(section.start) || '0:00'}–${fmtDuration(section.end)}` : '';
    await api.addToQueue([{
      videoId: info.id,
      url: info.url,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      quality: o.quality,
      qualityLabel: o.label + langLabel + cutLabel,
      container: o.container,
      audioLang: langSel && langSel.selectedIndex > 0 ? audioLang : null,
      section,
      outputDir: state.settings.outputDir,
    }]);
    toast('Adicionado à fila.', 'ok');
    resetSearch();
  });
}

function renderPlaylist(info) {
  const preview = $('#preview');
  const total = info.entries.length;
  const dups = info.entries.map((e) => duplicateOf(e.id));
  const nDup = dups.filter(Boolean).length;
  const nLive = info.entries.filter((e) => e.isLive).length;
  const notes = [];
  if (nDup) notes.push(`${nDup} vídeo(s) já baixados ou na fila foram desmarcados.`);
  if (nLive) notes.push(`${nLive} transmissão(ões) ao vivo ou agendadas não podem ser baixadas agora.`);
  preview.innerHTML = `
    <div class="pl-head">
      ${thumbImg(info.thumbnail)}
      <div class="meta">
        <div class="title">${esc(info.title)}</div>
        <div class="sub">${esc([info.uploader, `${total} vídeo(s)`].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
    <div class="pl-tools">
      <label><input type="checkbox" id="plAll" checked /> Selecionar todos</label>
      <label><input type="checkbox" id="plSubfolder" checked /> Criar subpasta com o nome da playlist</label>
      <span style="flex:1"></span>
      ${optionsHtml(null)}
      <button class="btn primary" id="btnAddPl">Adicionar ${total} à fila</button>
    </div>
    ${notes.length ? `<div class="dup-note">${esc(notes.join(' '))}</div>` : ''}
    <div class="pl-list">
      ${info.entries.map((e, i) => `
        <label class="pl-item${e.isLive ? ' disabled' : ''}">
          <input type="checkbox" data-i="${i}" ${dups[i] || e.isLive ? '' : 'checked'} ${e.isLive ? 'disabled' : ''} />
          <span class="idx">${i + 1}</span>
          <span class="t" title="${esc(e.title)}">${esc(e.title)}</span>
          ${e.isLive ? '<span class="tag">ao vivo</span>' : ''}
          ${dups[i] === 'history' ? '<span class="tag">já baixado</span>' : ''}
          ${dups[i] === 'queue' ? '<span class="tag">na fila</span>' : ''}
          <span class="d">${fmtDuration(e.duration)}</span>
        </label>`).join('')}
    </div>`;

  const getOpts = wireOptions(preview);
  const boxes = [...preview.querySelectorAll('.pl-list input[type=checkbox]:not(:disabled)')];
  const btn = $('#btnAddPl');
  const refresh = () => {
    const n = boxes.filter((b) => b.checked).length;
    btn.textContent = `Adicionar ${n} à fila`;
    btn.disabled = n === 0;
    $('#plAll').checked = n === boxes.length;
    $('#plAll').indeterminate = n > 0 && n < boxes.length;
  };
  boxes.forEach((b) => b.addEventListener('change', refresh));
  $('#plAll').addEventListener('change', (e) => {
    boxes.forEach((b) => (b.checked = e.target.checked));
    refresh();
  });
  refresh();

  btn.addEventListener('click', async () => {
    const o = getOpts();
    const dir = $('#plSubfolder').checked
      ? joinPath(state.settings.outputDir, sanitizeName(info.title))
      : state.settings.outputDir;
    const items = boxes.filter((b) => b.checked).map((b) => {
      const e = info.entries[Number(b.dataset.i)];
      return {
        videoId: e.id,
        url: e.url,
        title: e.title,
        thumbnail: e.thumbnail || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        duration: e.duration,
        quality: o.quality,
        qualityLabel: o.label,
        container: o.container,
        outputDir: dir,
      };
    });
    await api.addToQueue(items);
    toast(`${items.length} vídeo(s) adicionados à fila.`, 'ok');
    resetSearch();
  });
}

function resetSearch() {
  $('#url').value = '';
  $('#preview').hidden = true;
  $('#preview').innerHTML = '';
  state.info = null;
  switchTab('queue');
}

// ----------------------------------------------------------------- fila
const STATUS_TEXT = {
  queued: 'Na fila',
  downloading: 'Baixando',
  processing: 'Processando',
  done: 'Concluído',
  error: 'Erro',
  canceled: 'Cancelado',
};

function jobRowHtml(j) {
  const parts = [];
  if (j.status === 'downloading') {
    parts.push(`${j.percent.toFixed(1)}%`);
    if (j.part > 1) parts.push(`parte ${j.part}`);
    if (j.total) parts.push(`${fmtBytes(j.downloaded)} / ${fmtBytes(j.total)}`);
    else if (j.downloaded) parts.push(fmtBytes(j.downloaded));
    if (j.speed) parts.push(`${fmtBytes(j.speed)}/s`);
    if (j.eta != null) parts.push(`restam ${fmtEta(j.eta)}`);
  } else if (j.status === 'processing') {
    if (j.phase === 'convert') {
      const how = j.encoder && j.encoder !== 'libx264' ? 'placa de vídeo' : 'processador';
      parts.push(`Convertendo para H.264 (Premiere, ${how})… ${j.percent.toFixed(0)}%`);
    }
    else parts.push('Juntando/convertendo com ffmpeg…');
  } else if (j.status === 'done' && j.total) {
    parts.push(fmtBytes(j.total));
  }
  return `<span class="status ${j.status}">${STATUS_TEXT[j.status]}</span>
    <span>${esc(j.qualityLabel)}</span>
    ${parts.map((p) => `<span>${esc(p)}</span>`).join('')}`;
}

function jobActionsHtml(j) {
  const a = [];
  if (j.status === 'done') {
    a.push('<button class="btn ghost small" data-act="open">Abrir</button>');
    a.push('<button class="btn ghost small" data-act="show">Mostrar na pasta</button>');
  }
  if (j.status === 'error' || j.status === 'canceled') a.push('<button class="btn ghost small" data-act="retry">Tentar de novo</button>');
  if (['queued', 'downloading', 'processing'].includes(j.status)) {
    a.push('<button class="btn ghost small danger" data-act="cancel">Cancelar</button>');
  } else {
    a.push('<button class="btn ghost small" data-act="remove" title="Remover da lista">✕</button>');
  }
  return a.join('');
}

function renderJob(j) {
  const list = $('#queueList');
  let el = list.querySelector(`[data-id="${j.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = j.id;
    el.innerHTML = `${thumbImg(j.thumbnail)}
      <div class="body">
        <div class="title" title="${esc(j.title)}">${esc(j.title)}</div>
        <div class="bar"><i></i></div>
        <div class="row"></div>
        <div class="err" hidden></div>
      </div>
      <div class="actions"></div>`;
    list.appendChild(el);
  }
  el.className = `item ${j.status}`;
  $('.bar > i', el).style.width = `${j.status === 'queued' ? 0 : j.percent}%`;
  $('.row', el).innerHTML = jobRowHtml(j);
  const err = $('.err', el);
  err.hidden = !j.error;
  err.textContent = j.error || '';
  err.title = j.error || '';
  const actionsKey = j.status;
  if (el.dataset.actions !== actionsKey) {
    $('.actions', el).innerHTML = jobActionsHtml(j);
    el.dataset.actions = actionsKey;
  }
}

function renderQueue() {
  const list = $('#queueList');
  list.innerHTML = '';
  if (!state.jobs.size) {
    list.innerHTML = '<div class="empty">Nenhum download na fila. Cole um link acima para começar.</div>';
  } else {
    state.jobs.forEach(renderJob);
  }
  updateCounts();
}

function updateCounts() {
  const active = [...state.jobs.values()].filter((j) => ['queued', 'downloading', 'processing'].includes(j.status)).length;
  $('#queueCount').textContent = active;
  $('#historyCount').textContent = state.history.length;
}

$('#queueList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const job = state.jobs.get(id);
  switch (btn.dataset.act) {
    case 'cancel': return api.cancel(id);
    case 'retry': return api.retry(id);
    case 'remove': return api.remove(id);
    case 'open': return reportShellError(await api.openPath(job.filePath));
    case 'show': return reportShellError(await api.showItem(job.filePath));
  }
});

function reportShellError(msg) {
  if (msg) toast(msg, 'err');
}

// ----------------------------------------------------------------- histórico
function renderHistory() {
  const list = $('#historyList');
  const q = $('#historySearch').value.trim().toLowerCase();
  const items = q ? state.history.filter((h) => (h.title || '').toLowerCase().includes(q)) : state.history;
  if (!items.length) {
    list.innerHTML = `<div class="empty">${q ? 'Nada encontrado.' : 'O histórico está vazio.'}</div>`;
  } else {
    list.innerHTML = items.map((h) => `
      <div class="item" data-id="${esc(h.id)}">
        ${thumbImg(h.thumbnail)}
        <div class="body">
          <div class="title" title="${esc(h.title)}">${esc(h.title)}</div>
          <div class="row">
            <span>${esc(fmtDate(h.finishedAt))}</span>
            <span>${esc(h.qualityLabel || '')}</span>
            ${h.size ? `<span>${fmtBytes(h.size)}</span>` : ''}
            ${h.duration ? `<span>${fmtDuration(h.duration)}</span>` : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost small" data-act="open">Abrir</button>
          <button class="btn ghost small" data-act="show">Mostrar na pasta</button>
          <button class="btn ghost small" data-act="link" title="Abrir no YouTube">Link</button>
          <button class="btn ghost small" data-act="again" title="Analisar de novo">Baixar de novo</button>
          <button class="btn ghost small" data-act="remove" title="Remover do histórico">✕</button>
        </div>
      </div>`).join('');
  }
  updateCounts();
}

$('#historyList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const h = state.history.find((x) => x.id === id);
  if (!h) return;
  switch (btn.dataset.act) {
    case 'open': return reportShellError(await api.openPath(h.filePath));
    case 'show': return reportShellError(await api.showItem(h.filePath));
    case 'link': return api.openExternal(h.url);
    case 'again':
      $('#url').value = h.url;
      window.scrollTo(0, 0);
      return analyze();
    case 'remove':
      state.history = await api.removeHistory(id);
      return renderHistory();
  }
});

$('#historySearch').addEventListener('input', renderHistory);
$('#btnClearHistory').addEventListener('click', async () => {
  if (!state.history.length) return;
  if (!confirm('Apagar todo o histórico? Os arquivos baixados não serão excluídos.')) return;
  state.history = await api.clearHistory();
  renderHistory();
});

// ----------------------------------------------------------------- abas
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-actions').forEach((t) => (t.hidden = t.dataset.for !== tab));
  $('#queueList').hidden = tab !== 'queue';
  $('#historyList').hidden = tab !== 'history';
  if (tab === 'history') renderHistory();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ----------------------------------------------------------------- yt-dlp
function renderYtdlpStatus(s) {
  const chip = $('#ytdlpVersion');
  chip.textContent = s.available ? `yt-dlp ${s.version}` : 'yt-dlp não encontrado';
  chip.classList.toggle('bad', !s.available);
  const warn = [];
  if (!s.available) warn.push('O yt-dlp não foi encontrado. Rode "npm run fetch-bin" antes de iniciar o app.');
  if (!s.ffmpeg) warn.push('ffmpeg não encontrado: vídeos acima de 720p e conversão para MP3 podem falhar.');
  if (!s.deno) warn.push('Deno não encontrado: o YouTube pode oferecer menos formatos.');
  $('#binWarning').hidden = !warn.length;
  $('#binWarning').textContent = warn.join(' ');
}

$('#btnUpdate').addEventListener('click', async () => {
  const modal = $('#updateModal');
  const log = $('#updateLog');
  const close = $('#btnCloseModal');
  log.textContent = 'Verificando atualizações…\n';
  close.disabled = true;
  modal.hidden = false;
  $('#btnUpdate').disabled = true;

  const off = api.onUpdateLog((line) => {
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });
  const res = await api.updateYtDlp();
  off();

  if (res.ok) {
    $('#updateBanner').hidden = true;
    log.textContent += res.updated
      ? `\n✔ Atualizado de ${res.before} para ${res.after}.`
      : `\n✔ Você já está na versão mais recente (${res.after}).`;
  } else {
    log.textContent += `\n✖ ${res.error}`;
  }
  if (res.status) renderYtdlpStatus(res.status);
  close.disabled = false;
  $('#btnUpdate').disabled = false;
});
$('#btnCloseModal').addEventListener('click', () => ($('#updateModal').hidden = true));

// ----------------------------------------------------------------- destino / config
function renderOutputDir() {
  $('#outputDir').textContent = state.settings.outputDir;
  $('#outputDir').title = state.settings.outputDir;
}

$('#btnChooseDir').addEventListener('click', async () => {
  const dir = await api.chooseFolder();
  if (dir) {
    state.settings.outputDir = dir;
    renderOutputDir();
  }
});
$('#btnOpenDir').addEventListener('click', async () => reportShellError(await api.openPath(state.settings.outputDir)));
$('#concurrency').addEventListener('change', async (e) => {
  state.settings = await api.setSettings({ concurrency: Number(e.target.value) });
});

$('#btnClearFinished').addEventListener('click', () => api.clearFinished());
$('#btnCancelAll').addEventListener('click', () => {
  const active = [...state.jobs.values()].some((j) => ['queued', 'downloading', 'processing'].includes(j.status));
  if (active && confirm('Cancelar todos os downloads?')) api.cancelAll();
});

// ----------------------------------------------------------------- busca
$('#btnAnalyze').addEventListener('click', analyze);
$('#url').addEventListener('keydown', (e) => e.key === 'Enter' && analyze());
$('#btnPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $('#url').value = text.trim();
      analyze();
    }
  } catch {
    $('#url').focus();
    toast('Use Ctrl+V para colar o link.');
  }
});

// ----------------------------------------------------------------- configurações
async function saveSetting(patch) {
  state.settings = await api.setSettings(patch);
  renderSettings();
}

function renderSettings() {
  const s = state.settings;
  $('#setCookies').value = s.cookiesSource || 'none';
  $('#btnCookiesFile').hidden = s.cookiesSource !== 'file';
  const note = $('#cookiesNote');
  if (s.cookiesSource === 'file') {
    note.textContent = s.cookiesFile ? `Arquivo: ${s.cookiesFile}` : 'Nenhum arquivo escolhido ainda.';
  } else if (['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'].includes(s.cookiesSource)) {
    note.textContent =
      'Navegadores baseados no Chromium costumam bloquear a leitura dos cookies no Windows. ' +
      'Se der erro, feche o navegador antes de baixar, ou use o Firefox ou um arquivo cookies.txt.';
  } else {
    note.textContent = '';
  }
  $('#setThumb').checked = !!s.embedThumbnail;
  $('#setSubs').checked = !!s.embedSubs;
  $('#subsOptions').hidden = !s.embedSubs;
  $('#setSubLangs').value = s.subLangs || '';
  $('#setAutoSubs').checked = !!s.autoSubs;
  $('#setSponsor').checked = !!s.sponsorBlock;
  $('#setGpu').checked = s.gpuEncode !== false;
  $('#setNotify').checked = !!s.notify;
  $('#setCheckUpdates').checked = !!s.checkUpdates;
  $('#setClipboard').checked = !!s.watchClipboard;
}

$('#btnSettings').addEventListener('click', () => {
  renderSettings();
  $('#settingsModal').hidden = false;
});
$('#btnCloseSettings').addEventListener('click', () => ($('#settingsModal').hidden = true));
$('#settingsModal').addEventListener('click', (e) => {
  if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true;
});

$('#setCookies').addEventListener('change', async (e) => {
  if (e.target.value === 'file' && !state.settings.cookiesFile) {
    const s = await api.chooseCookiesFile();
    if (!s) return renderSettings(); // cancelou: volta para a opção anterior
    state.settings = s;
    return renderSettings();
  }
  saveSetting({ cookiesSource: e.target.value });
});
$('#btnCookiesFile').addEventListener('click', async () => {
  const s = await api.chooseCookiesFile();
  if (s) {
    state.settings = s;
    renderSettings();
  }
});

const CHECKS = {
  setThumb: 'embedThumbnail',
  setSubs: 'embedSubs',
  setAutoSubs: 'autoSubs',
  setSponsor: 'sponsorBlock',
  setGpu: 'gpuEncode',
  setNotify: 'notify',
  setCheckUpdates: 'checkUpdates',
  setClipboard: 'watchClipboard',
};
for (const [id, key] of Object.entries(CHECKS)) {
  $(`#${id}`).addEventListener('change', (e) => saveSetting({ [key]: e.target.checked }));
}
$('#setSubLangs').addEventListener('change', (e) => {
  const v = e.target.value.replace(/\s+/g, '');
  saveSetting({ subLangs: v || 'pt.*,en.*' });
});

// ----------------------------------------------------------------- aviso de nova versão do yt-dlp
api.onYtdlpLatest((res) => {
  $('#updateBannerText').textContent = `Nova versão do yt-dlp disponível: ${res.latest} (você tem ${res.current}).`;
  $('#updateBanner').hidden = false;
});
$('#btnBannerUpdate').addEventListener('click', () => $('#btnUpdate').click());
$('#btnBannerClose').addEventListener('click', () => ($('#updateBanner').hidden = true));

// ----------------------------------------------------------------- receber links
function useLink(text) {
  const url = String(text || '').trim().split(/\r?\n/)[0];
  if (!/^https?:\/\//i.test(url)) return false;
  $('#url').value = url;
  $('#clipSuggest').hidden = true;
  analyze();
  return true;
}

// Link do YouTube copiado em outro programa.
api.onClipboardLink((url) => {
  if ($('#url').value.trim() === url) return;
  $('#clipUrl').textContent = url;
  $('#clipUrl').title = url;
  $('#clipSuggest').hidden = false;
});
$('#btnClipUse').addEventListener('click', () => useLink($('#clipUrl').textContent));
$('#btnClipDismiss').addEventListener('click', () => ($('#clipSuggest').hidden = true));

// Ctrl+V em qualquer lugar da janela (fora de campos de texto).
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (useLink(text)) e.preventDefault();
});

// Arrastar um link do navegador para a janela.
let dragDepth = 0;
const isLinkDrag = (e) => [...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain');
document.addEventListener('dragenter', (e) => {
  if (!isLinkDrag(e)) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropOverlay').hidden = true;
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  const dt = e.dataTransfer;
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!useLink(uri || dt.getData('text/plain'))) toast('Solte um link de vídeo ou playlist.', 'err');
});

// ----------------------------------------------------------------- eventos do main
api.onQueueUpdate((job) => {
  const isNew = !state.jobs.has(job.id);
  state.jobs.set(job.id, job);
  if (isNew && state.jobs.size === 1) renderQueue();
  else renderJob(job);
  updateCounts();
  if (job.status === 'error') toast(`Falha: ${job.title}`, 'err');
});

api.onQueueRemoved((id) => {
  state.jobs.delete(id);
  const el = $(`#queueList [data-id="${id}"]`);
  if (el) el.remove();
  if (!state.jobs.size) renderQueue();
  updateCounts();
});

api.onHistoryChanged((history) => {
  state.history = history;
  if (state.tab === 'history') renderHistory();
  else updateCounts();
  const last = history[0];
  if (last) toast(`Concluído: ${last.title}`, 'ok');
});

// ----------------------------------------------------------------- início
(async function start() {
  const data = await api.init();
  state.settings = data.settings;
  state.history = data.history;
  data.queue.forEach((j) => state.jobs.set(j.id, j));
  $('#concurrency').value = String(data.settings.concurrency);
  renderOutputDir();
  renderSettings();
  renderYtdlpStatus(data.ytdlp);
  renderQueue();
  $('#url').focus();
})();
