# Copeiro — servidor multiplayer

Backend Node + WebSocket que faz o multiplayer funcionar de verdade entre
dispositivos diferentes, com **torneio sincronizado**:

- O servidor só monta a Copa depois que **todos** os jogadores da sala
  terminam o próprio draft (escolha de time).
- Todo mundo joga o **mesmo chaveamento**, na **mesma rodada**, ao mesmo
  tempo — o servidor só libera a próxima fase quando todas as partidas da
  fase atual (incluindo bot-vs-bot, resolvidas na hora) tiverem vencedor.
- Dá pra ver o time (elenco) de qualquer outro jogador humano direto no
  chaveamento (botão 👁 ao lado do nome do time dele).
- Cada jogador continua jogando a própria partida (com ida/volta e
  pênaltis) do jeito de sempre — o servidor só recebe o resultado final.

## Limitações conhecidas (por enquanto)

- **Mercado de transferências e "Garimpar"** ficam disponíveis só no modo
  solo — em multiplayer essas fases são puladas, pra não complicar a
  sincronização entre vários jogadores ao mesmo tempo.
- O vídeo de comemoração da final (modo solo) não roda em multiplayer —
  quem for campeão vê um anúncio simples de "campeão da Copa".
- Enquanto uma partida de outro jogador ainda não foi resolvida, sua tela
  pode mostrar rapidinho um placar "de mentirinha" pra ela (só visual, se
  autocorrige assim que o servidor manda a rodada oficial) — não afeta o
  resultado real, que só vem de quem realmente jogou aquela partida.

## Deploy no Render

Esse serviço já está descrito no `render.yaml` da raiz do projeto
(serviço `copeiro-multiplayer`), então se você usar o **Blueprint** do
Render (New → Blueprint, apontando pro repositório), ele sobe sozinho
junto com o site.

Se preferir criar manualmente:
1. Render → **New** → **Web Service**.
2. Conecte o repositório.
3. **Root Directory**: `server`
4. **Runtime**: Node
5. **Build Command**: `npm install`
6. **Start Command**: `npm start`
7. Plano **Free** já é suficiente pra uma sala de amigos.

Depois do deploy, o Render te dá uma URL tipo:
```
https://copeiro-multiplayer.onrender.com
```

## ⚠️ Passo obrigatório: conectar o frontend a essa URL

Abra `public/index.html`, procure por `MP_WS_URL` (perto do início do
bloco `MULTIPLAYER ROOM`) e troque pela URL acima, **trocando `https://`
por `wss://`**:

```js
var MP_WS_URL = "wss://copeiro-multiplayer.onrender.com";
```

Depois é só fazer commit + push — o Cloudflare Pages / Render do
frontend atualiza sozinho. Sem esse passo o multiplayer mostra o erro
"Multiplayer ainda não configurado".

## Sobre o plano gratuito do Render

Serviços web gratuitos do Render "dormem" depois de ~15 min sem uso e
levam alguns segundos pra acordar na primeira conexão depois disso. Isso
é normal — é só uma questão de você e seus amigos abrirem a sala,
esperarem alguns segundos na primeira vez e seguir o jogo normalmente.
Se isso incomodar, dá pra migrar pro plano pago do Render (fica sempre
ativo) sem precisar mudar nada no código.

## Testando localmente

```bash
cd server
npm install
npm start
# ouvindo em http://localhost:10000
```

E aponte `MP_WS_URL` para `ws://localhost:10000` durante o teste.

## Atualizando o `teams.json`

Esse arquivo é uma cópia (só nome/formação/elenco) da lista de times do
`public/index.html`, usada pelo servidor pra preencher os times "bot" do
chaveamento e simular as partidas bot-vs-bot. Se você mudar a lista de
times no jogo (`var TIMES=[...]`), regenere esse arquivo também, senão
o servidor fica com um pool de times desatualizado.

