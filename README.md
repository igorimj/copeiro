# Copeiro — Copa do Brasil

App front-end (HTML/CSS/JS puro). O jogo em si (times, elenco, torneio)
é 100% client-side, salvo no `localStorage` do navegador. A única parte
que precisa de servidor é a **sala multiplayer** (lobby com amigos),
que usa um pequeno backend WebSocket em Node — sem ele, cada navegador
só enxerga o próprio `localStorage` e a sala nunca é encontrada por
quem está em outro dispositivo.

## Estrutura do projeto

```
copeiro-app/
├── public/                 ← frontend (document root)
│   ├── index.html          ← o app inteiro (era o copeiro.html)
│   ├── _headers            ← headers customizados (Cloudflare Pages)
│   └── copeiro_media/      ← vídeos/selos referenciados pelo app (ver README dentro)
├── server/                  ← backend do multiplayer (Node + WebSocket)
│   ├── server.js
│   ├── package.json
│   └── README.md            ← deploy do servidor + configuração da URL
├── wrangler.toml             ← config do Cloudflare Pages (frontend)
├── render.yaml                ← config do Render (Blueprint: frontend + backend)
├── package.json                ← scripts opcionais (preview local / deploy CLI)
└── .gitignore
```

## Passo 0 — mídia

Os 11 selos de estádio (PNG) já estão em `public/copeiro_media/`. Ainda
faltam os 5 vídeos de final de campeonato — veja
`public/copeiro_media/README.md` para os nomes exatos esperados. Sem os
vídeos o app funciona normalmente, só não mostra essa animação.

## Passo 0.5 — multiplayer (opcional)

Se você quer que a sala multiplayer funcione entre dispositivos
diferentes, siga `server/README.md` pra subir o backend no Render e
apontar o frontend pra ele (`MP_WS_URL` em `public/index.html`). Sem
isso o resto do jogo funciona normalmente — só a sala multiplayer fica
indisponível.

## Subir no GitHub (necessário para os dois provedores)

```bash
cd copeiro-app
git init
git add .
git commit -m "Copeiro - app estático"
git branch -M main
git remote add origin <URL_DO_SEU_REPO>
git push -u origin main
```

---

## Deploy no Cloudflare Pages (frontend)

### Opção A — pelo dashboard (mais simples)
1. Acesse https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Selecione o repositório.
3. Configurações de build:
   - **Framework preset**: `None`
   - **Build command**: (deixe vazio)
   - **Build output directory**: `public`
4. Clique em **Save and Deploy**.

### Opção B — via CLI (Wrangler)
```bash
npm install -g wrangler
wrangler login
wrangler pages deploy public --project-name=copeiro
```
(o `wrangler.toml` já define `pages_build_output_dir = "public"`)

> Cloudflare Pages só publica o `public/` (frontend). O backend do
> multiplayer roda no Render — ver seção abaixo.

---

## Deploy no Render (frontend + backend do multiplayer)

### Opção A — via Blueprint (recomendado, sobe os dois de uma vez)
1. No dashboard do Render: **New** → **Blueprint**.
2. Selecione o repositório — o `render.yaml` já configura os dois
   serviços automaticamente:
   - `copeiro` (site estático, `public/`)
   - `copeiro-multiplayer` (backend Node/WebSocket, `server/`)
3. Confirme e crie os recursos.
4. Depois que `copeiro-multiplayer` estiver no ar, copie a URL dele e
   siga o passo final em `server/README.md` (configurar `MP_WS_URL`).

### Opção B — manualmente
- **Site**: New → Static Site → Publish directory `public`.
- **Backend**: New → Web Service → Root Directory `server`, Build
  Command `npm install`, Start Command `npm start`.

---

## Testar localmente antes de subir

```bash
npm run dev
# abre em http://localhost:5173
```

Ou simplesmente abra `public/index.html` direto no navegador. Tudo
funciona sem servidor, exceto a sala multiplayer (veja `server/README.md`
pra rodar o backend localmente também, se quiser testar isso).

