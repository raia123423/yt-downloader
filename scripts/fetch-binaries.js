#!/usr/bin/env node
// Baixa os binários do Windows que serão embutidos no instalador:
//   bin/yt-dlp.exe   – https://github.com/yt-dlp/yt-dlp
//   bin/ffmpeg.exe   – https://github.com/yt-dlp/FFmpeg-Builds (build recomendado pelo yt-dlp)
//   bin/ffprobe.exe
//   bin/deno.exe     – runtime JavaScript exigido pelo yt-dlp para o YouTube
//
// Uso: node scripts/fetch-binaries.js [--force]
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const BIN = path.join(__dirname, '..', 'bin');
const FORCE = process.argv.includes('--force');

const SOURCES = [
  {
    files: ['yt-dlp.exe'],
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  },
  {
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    zip: true,
  },
  {
    files: ['deno.exe'],
    url: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
    zip: true,
  },
];

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let done = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    done += chunk.length;
    out.write(chunk);
    if (total) {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`  ${pct}%`);
        lastPct = pct;
      }
    }
  }
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
  process.stdout.write('\n');
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });

  for (const src of SOURCES) {
    const missing = src.files.filter((f) => FORCE || !fs.existsSync(path.join(BIN, f)));
    if (!missing.length) {
      console.log(`✔ ${src.files.join(', ')} já existe(m) (use --force para baixar de novo)`);
      continue;
    }
    console.log(`↓ ${src.url}`);

    if (!src.zip) {
      await download(src.url, path.join(BIN, src.files[0]));
    } else {
      const tmp = path.join(os.tmpdir(), `ytdl-${Date.now()}.zip`);
      await download(src.url, tmp);
      const zip = new AdmZip(tmp);
      for (const name of src.files) {
        const entry = zip.getEntries().find((e) => !e.isDirectory && path.posix.basename(e.entryName) === name);
        if (!entry) throw new Error(`${name} não encontrado dentro de ${src.url}`);
        fs.writeFileSync(path.join(BIN, name), entry.getData());
      }
      fs.rmSync(tmp, { force: true });
    }
    console.log(`✔ ${src.files.join(', ')}`);
  }
  console.log(`\nBinários prontos em ${BIN}`);
}

main().catch((err) => {
  console.error('\n✖', err.message);
  process.exit(1);
});
