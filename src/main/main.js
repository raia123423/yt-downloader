const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('./store');
const { YtDlp, compareVersions, COOKIE_BROWSERS } = require('./ytdlp');
const { DownloadQueue } = require('./queue');

// Apenas uma instância do app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Necessário para as notificações do Windows mostrarem o nome do app.
if (process.platform === 'win32') app.setAppUserModelId('com.ryqr.ytdownloader');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLED_BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'bin');
const USER_DATA = app.getPath('userData');
const HISTORY_LIMIT = 1000;

const DEFAULT_SETTINGS = {
  outputDir: path.join(app.getPath('downloads'), 'YT Downloader'),
  quality: 'best',
  container: 'mp4',
  concurrency: 2,
  cookiesSource: 'none', // 'none' | 'file' | um navegador de COOKIE_BROWSERS
  cookiesFile: '',
  embedThumbnail: true,
  embedSubs: false,
  subLangs: 'pt.*,en.*',
  autoSubs: false,
  sponsorBlock: false,
  gpuEncode: true,
  notify: true,
  checkUpdates: true,
  watchClipboard: true,
};

// Reconhece links do YouTube copiados para a área de transferência.
const YT_LINK = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?|playlist\?|shorts\/|live\/)|youtu\.be\/)\S+$/i;

let win = null;
let settings;
let history;
let queueStore;
let ytdlp;
let queue;
let lastClipboard = '';

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'YT Downloader',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Links externos abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Soltar um link na janela não deve navegar para fora do app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('focus', checkClipboard);

  win.on('close', (e) => {
    if (queue && queue.activeCount > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Sair', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Downloads em andamento',
        message: `Há ${queue.activeCount} download(s) em andamento.`,
        detail: 'Eles serão interrompidos agora e retomados na próxima vez que você abrir o app.',
      });
      if (choice === 1) e.preventDefault();
    }
  });
}

async function checkClipboard() {
  if (!settings.data.watchClipboard) return;
  let text;
  try {
    // A partir do Electron 45, readText() devolve uma Promise.
    text = String((await clipboard.readText()) || '').trim();
  } catch {
    return;
  }
  if (!text || text === lastClipboard) return;
  lastClipboard = text;
  if (YT_LINK.test(text)) send('clipboard:link', text);
}

function notify(title, body) {
  if (!settings.data.notify || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
}

function addToHistory(job) {
  history.data.unshift({
    id: job.id,
    videoId: job.videoId,
    title: job.title,
    url: job.url,
    thumbnail: job.thumbnail,
    duration: job.duration,
    qualityLabel: job.qualityLabel,
    container: job.container,
    filePath: job.filePath,
    outputDir: job.outputDir,
    size: job.total,
    finishedAt: job.finishedAt,
  });
  if (history.data.length > HISTORY_LIMIT) history.data.length = HISTORY_LIMIT;
  history.save();
  send('history:changed', history.data);
  notify('Download concluído', job.title);
}

// Compara nomes ignorando acentos, emoji e símbolos que versões antigas gravaram corrompidos.
const looseName = (n) =>
  n.normalize('NFC').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Devolve o caminho real de um arquivo baixado. Downloads feitos antes da correção de
 * codificação têm caminhos com "�" no histórico; nesse caso procura na mesma pasta um
 * arquivo com o mesmo [id] do vídeo e corrige o histórico e a fila.
 */
function resolveFile(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return p;
  const id = /\[([\w-]{6,})\][^[\]]*$/.exec(path.basename(p));
  if (!id) return null;
  let names;
  try {
    names = fs.readdirSync(path.dirname(p));
  } catch {
    return null;
  }
  const candidates = names.filter((n) => n.includes(`[${id[1]}]`) && !/\.(part|ytdl)$|\.part-Frag/.test(n));
  const want = looseName(path.basename(p));
  const found = candidates.find((n) => looseName(n) === want) || (candidates.length === 1 ? candidates[0] : null);
  if (!found) return null;

  const real = path.join(path.dirname(p), found);
  let fixed = false;
  for (const h of history.data) {
    if (h.filePath === p) {
      h.filePath = real;
      fixed = true;
    }
  }
  if (fixed) history.save();
  for (const j of queue.jobs) if (j.filePath === p) j.filePath = real;
  return real;
}

async function checkLatestYtDlp() {
  if (!ytdlp.version) return null;
  try {
    const latest = await ytdlp.latestVersion();
    const newer = latest && compareVersions(latest, ytdlp.version) > 0;
    return { current: ytdlp.version, latest, newer: !!newer };
  } catch (err) {
    return { current: ytdlp.version, latest: null, newer: false, error: err.message };
  }
}

// Aceita só chaves conhecidas, com o mesmo tipo do padrão.
function sanitizeSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS) || typeof v !== typeof DEFAULT_SETTINGS[k]) continue;
    if (k === 'cookiesSource' && !['none', 'file', ...COOKIE_BROWSERS].includes(v)) continue;
    out[k] = v;
  }
  return out;
}

function registerIpc() {
  ipcMain.handle('app:init', async () => ({
    settings: settings.data,
    history: history.data,
    queue: queue.list(),
    ytdlp: ytdlp.status(),
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('info:get', async (_e, url) => {
    try {
      return { ok: true, info: await ytdlp.getInfo(url) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('queue:add', (_e, items) => queue.add(items));
  ipcMain.handle('queue:cancel', (_e, id) => queue.cancel(id));
  ipcMain.handle('queue:cancelAll', () => queue.cancelAll());
  ipcMain.handle('queue:retry', (_e, id) => queue.retry(id));
  ipcMain.handle('queue:remove', (_e, id) => queue.remove(id));
  ipcMain.handle('queue:clearFinished', () => queue.clearFinished());

  ipcMain.handle('history:remove', (_e, id) => {
    history.data = history.data.filter((h) => h.id !== id);
    history.save();
    return history.data;
  });
  ipcMain.handle('history:clear', () => {
    history.data = [];
    history.save();
    return history.data;
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const clean = sanitizeSettings(patch);
    Object.assign(settings.data, clean);
    settings.save();
    if (clean.concurrency) queue.setConcurrency(clean.concurrency);
    return settings.data;
  });

  ipcMain.handle('dialog:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Escolha a pasta de destino',
      defaultPath: settings.data.outputDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.data.outputDir = res.filePaths[0];
    settings.save();
    return settings.data.outputDir;
  });

  ipcMain.handle('dialog:chooseCookiesFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Escolha o arquivo cookies.txt',
      properties: ['openFile'],
      filters: [{ name: 'Cookies (Netscape)', extensions: ['txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    Object.assign(settings.data, { cookiesFile: res.filePaths[0], cookiesSource: 'file' });
    settings.save();
    return settings.data;
  });

  ipcMain.handle('shell:openPath', async (_e, p) => {
    const real = resolveFile(p);
    if (!real) return 'Arquivo ou pasta não encontrado. Ele pode ter sido movido ou apagado.';
    return shell.openPath(real);
  });
  ipcMain.handle('shell:showItem', (_e, p) => {
    const real = resolveFile(p);
    if (real) shell.showItemInFolder(real);
    else return 'Arquivo não encontrado. Ele pode ter sido movido ou apagado.';
  });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('ytdlp:update', async () => {
    if (queue.activeCount > 0) {
      return { ok: false, error: 'Aguarde os downloads em andamento terminarem antes de atualizar.' };
    }
    try {
      const res = await ytdlp.update((line) => send('ytdlp:updateLog', line));
      return { ok: true, ...res, status: ytdlp.status() };
    } catch (err) {
      return { ok: false, error: err.message, status: ytdlp.status() };
    }
  });

  ipcMain.handle('ytdlp:checkLatest', () => checkLatestYtDlp());
}

app.whenReady().then(async () => {
  settings = new JsonStore(path.join(USER_DATA, 'settings.json'), DEFAULT_SETTINGS);
  history = new JsonStore(path.join(USER_DATA, 'history.json'), []);
  queueStore = new JsonStore(path.join(USER_DATA, 'queue.json'), []);

  ytdlp = new YtDlp({
    bundledDir: BUNDLED_BIN,
    userBinDir: path.join(USER_DATA, 'bin'),
    getSettings: () => settings.data,
  });
  await ytdlp.init().catch((err) => console.error('Falha ao iniciar yt-dlp', err));

  queue = new DownloadQueue(ytdlp, { concurrency: settings.data.concurrency, getSettings: () => settings.data });
  queue.on('update', (job) => {
    send('queue:update', job);
    if (job.status === 'error') notify('Falha no download', job.title);
  });
  queue.on('removed', (id) => send('queue:removed', id));
  queue.on('done', addToHistory);
  queue.on('changed', () => {
    queueStore.data = queue.snapshot();
    queueStore.save();
  });

  registerIpc();
  createWindow();

  // Retoma o que ficou pendente da última vez.
  queue.restore(queueStore.data);

  if (settings.data.checkUpdates) {
    win.webContents.once('did-finish-load', async () => {
      const res = await checkLatestYtDlp();
      if (res && res.newer) send('ytdlp:latest', res);
    });
  }
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('before-quit', () => {
  if (queue) {
    queue.killAll();
    queueStore.data = queue.snapshot();
    queueStore.flush();
  }
  if (settings) settings.flush();
  if (history) history.flush();
});

app.on('window-all-closed', () => app.quit());
