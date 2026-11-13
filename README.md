# YT Downloader

App desktop (Electron) para baixar vídeos e playlists do YouTube usando o **yt-dlp**.

## Baixar

Pegue a versão mais recente na página de [Releases](https://github.com/raia123423/yt-downloader/releases/latest):

- `YT-Downloader-Portable-x.y.z.exe`: não precisa instalar, é só abrir
- `YT Downloader Setup x.y.z.exe`: instalador com atalho na área de trabalho

Só para Windows 10/11 64 bits.

## Recursos

- Analisa o link e lista as qualidades disponíveis (com tamanho aproximado), MP4 ou MKV
- Somente áudio em M4A ou MP3
- Escolha do idioma do áudio em vídeos dublados
- Baixar só um trecho do vídeo (início e fim)
- Playlists: escolha quais vídeos baixar, com subpasta automática
- Avisa quando o vídeo já foi baixado ou já está na fila
- Fila com downloads simultâneos (1 a 4), cancelar e tentar de novo
- A fila é salva: o que ficou pendente ao fechar o app é retomado ao abrir
- Progresso com %, tamanho, velocidade e tempo restante
- Histórico com busca, abrir arquivo, mostrar na pasta e baixar de novo
- Cole com Ctrl+V em qualquer lugar da janela, arraste o link do navegador, ou use a sugestão de link copiado
- Notificação do Windows quando um download termina com o app em segundo plano
- Configurações: cookies do navegador ou arquivo cookies.txt, capa embutida, legendas embutidas, SponsorBlock
- Avisa quando há versão nova do yt-dlp; botão **Atualizar yt-dlp** (roda `yt-dlp -U`)
- Transmissões ao vivo ou agendadas são bloqueadas (só dá para baixar depois que terminam)
- yt-dlp, ffmpeg e Deno embutidos no instalador

## Requisitos (para compilar)

- Windows 10/11 x64
- [Node.js 20 ou superior](https://nodejs.org)

## Como rodar e gerar o instalador

Abra o terminal (PowerShell) na pasta do projeto:

```powershell
npm install          # instala Electron e electron-builder
npm run fetch-bin    # baixa yt-dlp.exe, ffmpeg.exe, ffprobe.exe e deno.exe para a pasta bin/
npm start            # abre o app em modo de desenvolvimento

npm run dist         # gera o instalador e a versão portátil em dist/
```

Em `dist/` você vai encontrar:

- `YT Downloader Setup 1.0.0.exe`: instalador
- `YT-Downloader-Portable-1.0.0.exe`: executável portátil, não precisa instalar

Para baixar versões novas dos binários antes de um build: `npm run fetch-bin:force`.

## Como funciona

| Item | Onde fica |
|---|---|
| Binários embutidos | `resources/bin` dentro da pasta de instalação |
| yt-dlp em uso (atualizável) | `%APPDATA%\YT Downloader\bin\yt-dlp.exe` |
| Configurações, histórico e fila | `%APPDATA%\YT Downloader\settings.json`, `history.json` e `queue.json` |
| Pasta padrão dos downloads | `Downloads\YT Downloader` |

Na primeira execução o app copia o `yt-dlp.exe` embutido para a pasta do usuário. Assim o botão
**Atualizar yt-dlp** funciona mesmo com o app instalado em *Arquivos de Programas*, sem pedir
permissão de administrador. Se uma versão nova do app trouxer um yt-dlp mais novo que a cópia, a cópia é substituída.

O **Deno** é o runtime JavaScript que o yt-dlp usa para resolver os desafios do YouTube. Sem ele,
o YouTube pode oferecer menos formatos. O **ffmpeg** junta vídeo e áudio (qualidades acima de 720p) e converte para MP3.

## Estrutura

```
src/
  main/main.js      processo principal: janela, IPC, configurações e histórico
  main/ytdlp.js     chamadas ao yt-dlp: info, formatos, atualização
  main/queue.js     fila de downloads, progresso, cancelamento
  preload.js        ponte segura (contextBridge) entre a interface e o main
  renderer/         interface: index.html, styles.css, renderer.js
scripts/fetch-binaries.js
build/icon.ico
```

## Problemas comuns

- **"Sign in to confirm you're not a bot"**: em *Configurações*, ative os cookies de um navegador em que você está logado no YouTube. O Firefox é o mais confiável. Chrome, Edge e outros baseados no Chromium costumam bloquear a leitura dos cookies no Windows. Nesse caso, feche o navegador antes de baixar ou exporte um `cookies.txt` com uma extensão e escolha a opção *Arquivo cookies.txt*.
- **Erros de formato**: clique em *Atualizar yt-dlp*. O YouTube muda com frequência e o yt-dlp acompanha.
- **Trecho começa alguns segundos antes ou depois**: o corte acontece no quadro-chave mais próximo, para não precisar recodificar o vídeo.
- **O Windows SmartScreen avisa ao abrir o instalador**: o executável não é assinado digitalmente. Clique em *Mais informações* e depois em *Executar assim mesmo*.

Use o app apenas para baixar conteúdo que você tem direito de baixar, respeitando os termos do YouTube e os direitos autorais.
