// ═══════════════════════════════════════════════════════════════════
//  Copeiro — servidor de salas multiplayer (WebSocket, em memória)
// ═══════════════════════════════════════════════════════════════════
// Este servidor é a autoridade do torneio multiplayer:
//   1) Espera todo mundo terminar o draft antes de começar a Copa.
//   2) Monta o chaveamento de cada rodada (usando o mesmo pool de times
//      do modo solo) e resolve na hora as partidas bot-vs-bot.
//   3) Só avança de rodada quando TODAS as partidas da rodada atual têm
//      vencedor — ou seja, todo mundo fica sempre na mesma rodada.
//   4) Manda pra todo mundo o chaveamento completo, incluindo o elenco
//      dos times de outros jogadores humanos (pra dar pra "ver o time").
//
// As partidas em si (com pênaltis, ida/volta etc.) continuam sendo
// simuladas no navegador de quem é dono do time, exatamente como no
// modo solo — o servidor só recebe o resultado final de cada uma.

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const TEAMS = require('./teams.json'); // mesmo pool de 41 times do jogo solo

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 8;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // limpa salas abandonadas após 6h
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I

const PHASES = ['4a', '5a', 'oitavas', 'quartas', 'semi', 'final'];

/** @type {Map<string, any>} */
const rooms = new Map();

// ── utilidades ────────────────────────────────────────────────────────
function genCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function teamForca(team) {
  if (team._forca != null) return team._forca;
  const jj = team.jogadores || [];
  const avg = jj.length ? jj.reduce((s, p) => s + (p.overall || 60), 0) / jj.length : 60;
  team._forca = avg;
  return avg;
}

// time "bot" pronto pra entrar no chaveamento
function botTeam(t) {
  return { kind: 'bot', ownerId: null, nome: t.nome, formacao: t.formacao, jogadores: t.jogadores, pote: t.pote };
}

// time humano pronto pra entrar no chaveamento
function humanTeam(playerId, drafted) {
  return {
    kind: 'human', ownerId: playerId,
    nome: drafted.nome, formacao: drafted.formacao, jogadores: drafted.jogadores,
  };
}

function nameSet(list) { return new Set(list.map(t => t.nome)); }

/**
 * Resolve na hora uma partida bot-vs-bot (ninguém precisa "jogar" isso).
 * Fórmula simples: quanto maior a força média do elenco, maior a chance
 * de vencer, com uma margem boa de aleatoriedade pra não ficar previsível.
 */
function resolveBotMatch(home, away) {
  const fh = teamForca(home), fa = teamForca(away);
  const diff = fh - fa; // tipicamente entre -15 e +15
  let pHome = 0.5 + diff * 0.018 + 0.04; // leve peso pela força + leve mando de campo
  pHome = Math.max(0.12, Math.min(0.88, pHome));
  return Math.random() < pHome ? 'home' : 'away';
}

// placar "de mentirinha" só pra exibição (bot-vs-bot nunca é realmente jogado)
function fakeScoreFor(winnerSide) {
  const winnerGoals = 1 + Math.floor(Math.random() * 3); // 1 a 3
  const loserGoals = Math.max(0, winnerGoals - 1 - Math.floor(Math.random() * winnerGoals));
  return winnerSide === 'home'
    ? { home: winnerGoals, away: loserGoals, pen: null }
    : { home: loserGoals, away: winnerGoals, pen: null };
}

function mkMatch(id, home, away) {
  const m = { id, home, away, winnerSide: null, score: null };
  if (home.kind === 'bot' && away.kind === 'bot') {
    m.winnerSide = resolveBotMatch(home, away);
    m.score = fakeScoreFor(m.winnerSide);
  }
  return m;
}

function winnerTeam(m) {
  if (!m.winnerSide) return null;
  return m.winnerSide === 'home' ? m.home : m.away;
}

// ── construção de cada fase do chaveamento (espelha o modo solo) ──────
function buildPhase4a(room) {
  const humans = Array.from(room.teams.entries()).map(([pid, t]) => humanTeam(pid, t));
  const humanNames = nameSet(humans);
  const pote1 = shuffle(TEAMS.filter(t => t.pote === 1 && !humanNames.has(t.nome)));
  const slotsForBots = Math.max(0, 24 - humans.length);
  const bots = pote1.slice(0, slotsForBots).map(botTeam);
  room._pote1UsedNames = bots.map(b => b.nome);

  let all = shuffle([...humans, ...bots]);
  const seen = new Set(); // segurança extra: nunca duplicar o mesmo nome de time
  all = all.filter(t => { if (seen.has(t.nome)) return false; seen.add(t.nome); return true; });

  const bracket = [];
  for (let i = 0; i + 1 < all.length; i += 2) {
    bracket.push(mkMatch(`4a_${i / 2}`, all[i], all[i + 1]));
  }
  return bracket;
}

function buildPhase5a(room, prevBracket) {
  const winners = prevBracket.map(winnerTeam).filter(Boolean);
  const winnerNames = nameSet(winners);
  const usedPote1 = new Set(room._pote1UsedNames || []);

  const pote2 = shuffle(TEAMS.filter(t => t.pote === 2 && !winnerNames.has(t.nome))).map(botTeam);
  const p1Losers = shuffle(
    TEAMS.filter(t => t.pote === 1 && usedPote1.has(t.nome) && !winnerNames.has(t.nome))
  ).map(botTeam);
  const extras = p1Losers.slice(0, 2);

  const usedNames = new Set();
  let all = shuffle([...winners, ...pote2, ...extras]).filter(t => {
    if (usedNames.has(t.nome)) return false;
    usedNames.add(t.nome); return true;
  });
  if (all.length < 32) {
    const fillers = shuffle(TEAMS.filter(t => !usedNames.has(t.nome))).map(botTeam);
    let i = 0;
    while (all.length < 32 && i < fillers.length) {
      all.push(fillers[i]); usedNames.add(fillers[i].nome); i++;
    }
  }
  all = all.slice(0, 32);

  const bracket = [];
  for (let i = 0; i + 1 < all.length; i += 2) {
    bracket.push(mkMatch(`5a_${i / 2}`, all[i], all[i + 1]));
  }
  return bracket;
}

function buildPhaseKO(phaseName, prevBracket) {
  const usedNames = new Set();
  let w = shuffle(prevBracket.map(winnerTeam).filter(Boolean)).filter(t => {
    if (usedNames.has(t.nome)) return false;
    usedNames.add(t.nome); return true;
  });
  if (w.length % 2 !== 0 && w.length > 1) w = w.slice(0, w.length - 1);

  const bracket = [];
  for (let i = 0; i + 1 < w.length; i += 2) {
    bracket.push(mkMatch(`${phaseName}_${i / 2}`, w[i], w[i + 1]));
  }
  return bracket;
}

function buildPhase(room, phase) {
  if (phase === '4a') return buildPhase4a(room);
  if (phase === '5a') return buildPhase5a(room, room.bracket);
  return buildPhaseKO(phase, room.bracket);
}

// Avança fases automaticamente enquanto a fase resultante já sair
// 100% resolvida sem nenhum humano precisar jogar (raríssimo, mas seguro).
function advanceUntilActionable(room) {
  for (;;) {
    const allResolved = room.bracket.length > 0 && room.bracket.every(m => m.winnerSide);
    if (!allResolved) return; // alguém (humano) ainda precisa jogar — para aqui
    room.history.push({ phase: room.phase, bracket: publicBracket(room) });
    const idx = PHASES.indexOf(room.phase);
    if (room.phase === 'final' || idx === PHASES.length - 1) {
      room.stage = 'over';
      room.champion = winnerTeam(room.bracket[0]) || null;
      return;
    }
    room.phase = PHASES[idx + 1];
    room.bracket = buildPhase(room, room.phase);
  }
}

// ── mensageria ─────────────────────────────────────────────────────────
function publicPlayers(room) {
  return Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, host: p.host }));
}
function publicRoom(room) {
  return { id: room.id, stage: room.stage, players: publicPlayers(room) };
}
function publicBracket(room) {
  return room.bracket.map(m => ({
    id: m.id,
    home: { kind: m.home.kind, ownerId: m.home.ownerId, nome: m.home.nome, formacao: m.home.formacao, jogadores: m.home.jogadores },
    away: { kind: m.away.kind, ownerId: m.away.ownerId, nome: m.away.nome, formacao: m.away.formacao, jogadores: m.away.jogadores },
    winnerSide: m.winnerSide || null,
    score: m.score || null,
  }));
}
function send(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}
function broadcastTournamentState(room) {
  if (room.stage === 'over') {
    broadcast(room, { type: 'tournamentOver', champion: room.champion, bracket: publicBracket(room), history: room.history });
  } else {
    broadcast(room, { type: 'tournamentUpdate', phase: room.phase, bracket: publicBracket(room), history: room.history });
  }
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  if (!room) return;
  const wasHost = room.players.get(ws.id)?.host;
  room.players.delete(ws.id);
  room.draftDone.delete(ws.id);
  room.teams.delete(ws.id);
  if (room.players.size === 0) { rooms.delete(room.id); return; }
  if (wasHost) {
    const next = room.players.values().next().value;
    if (next) next.host = true;
  }
  broadcast(room, { type: 'update', room: publicRoom(room) });
}

// ── HTTP + WebSocket ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('copeiro-multiplayer: ok');
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(8).toString('hex');
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'create': {
        const name = String(msg.name || 'Anfitrião').slice(0, 24);
        const code = genCode();
        const room = {
          id: code,
          players: new Map([[ws.id, { id: ws.id, name, host: true, ws }]]),
          stage: 'lobby', // lobby -> draft -> tournament -> over
          phase: null,    // só passa a valer '4a'|'5a'|'oitavas'|... quando stage==='tournament'
          draftDone: new Set(),
          teams: new Map(),
          bracket: [],
          champion: null,
          history: [], // snapshot de cada rodada já concluída (fase + placares)
          createdAt: Date.now(),
        };
        rooms.set(code, room);
        ws.roomCode = code;
        send(ws, { type: 'created', room: publicRoom(room), playerId: ws.id });
        break;
      }
      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'error', message: 'Sala não encontrada' }); return; }
        if (room.stage !== 'lobby') { send(ws, { type: 'error', message: 'Partida já iniciada' }); return; }
        if (room.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'Sala cheia! (máx 8)' }); return; }
        const name = String(msg.name || 'Jogador').slice(0, 24);
        room.players.set(ws.id, { id: ws.id, name, host: false, ws });
        ws.roomCode = code;
        send(ws, { type: 'joined', room: publicRoom(room), playerId: ws.id });
        broadcast(room, { type: 'update', room: publicRoom(room) });
        break;
      }
      case 'rename': {
        const room = rooms.get(ws.roomCode);
        if (!room || !room.players.has(ws.id)) return;
        room.players.get(ws.id).name = String(msg.name || 'Jogador').slice(0, 24) || 'Jogador';
        broadcast(room, { type: 'update', room: publicRoom(room) });
        break;
      }
      case 'start': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const player = room.players.get(ws.id);
        if (!player || !player.host) { send(ws, { type: 'error', message: 'Só o anfitrião pode iniciar a partida' }); return; }
        if (room.stage !== 'lobby') return;
        room.stage = 'draft';
        room.draftDone = new Set();
        room.teams = new Map();
        console.log(`[${room.id}] draft iniciado por ${player.name} (${room.players.size} jogadores)`);
        broadcast(room, { type: 'draftPhase', room: publicRoom(room) });
        break;
      }
      // jogador terminou o draft e mandou o time montado
      case 'draftDone': {
        const room = rooms.get(ws.roomCode);
        if (!room || room.stage !== 'draft') return;
        const team = msg.team || {};
        if (!Array.isArray(team.jogadores) || team.jogadores.length < 1) return;
        room.teams.set(ws.id, {
          nome: String(team.nome || 'Meu Time').slice(0, 30),
          formacao: String(team.formacao || '4-4-2'),
          jogadores: team.jogadores,
        });
        room.draftDone.add(ws.id);
        const total = room.players.size;
        const done = room.draftDone.size;
        console.log(`[${room.id}] draft pronto: ${done}/${total} (time "${team.nome}")`);
        broadcast(room, { type: 'draftProgress', done, total, doneIds: Array.from(room.draftDone) });
        if (done >= total) {
          room.stage = 'tournament';
          room.phase = '4a';
          room.bracket = buildPhase4a(room);
          advanceUntilActionable(room);
          console.log(`[${room.id}] torneio iniciado — fase ${room.phase}, ${room.bracket.length} partidas`);
          broadcastTournamentState(room);
        }
        break;
      }
      // um jogador terminou de fato a própria partida (com pênaltis, ida/volta etc.)
      case 'matchResult': {
        const room = rooms.get(ws.roomCode);
        if (!room || room.stage !== 'tournament') {
          console.log(`[matchResult] ignorado: sala ${ws.roomCode} não está em fase de torneio (msg=${JSON.stringify(msg)})`);
          return;
        }
        const m = room.bracket.find(x => x.id === msg.matchId);
        if (!m) {
          console.log(`[${room.id}] matchResult ignorado: id "${msg.matchId}" não existe na fase atual (${room.phase}). Bracket atual: ${room.bracket.map(x=>x.id).join(', ')}`);
          return;
        }
        if (m.winnerSide) {
          console.log(`[${room.id}] matchResult ignorado (duplicata): "${m.id}" já tinha vencedor (${m.winnerSide})`);
          return;
        }
        const claimsHome = m.home.kind === 'human' && m.home.ownerId === ws.id;
        const claimsAway = m.away.kind === 'human' && m.away.ownerId === ws.id;
        if (!claimsHome && !claimsAway) {
          console.log(`[${room.id}] matchResult ignorado: jogador ${ws.id} não é dono de "${m.id}" (home=${m.home.ownerId}, away=${m.away.ownerId})`);
          return;
        }
        if (msg.winnerSide !== 'home' && msg.winnerSide !== 'away') return;
        m.winnerSide = msg.winnerSide;
        if (msg.score && typeof msg.score.home === 'number' && typeof msg.score.away === 'number') {
          m.score = { home: msg.score.home, away: msg.score.away, pen: msg.score.pen || null };
        } else {
          m.score = fakeScoreFor(m.winnerSide);
        }
        const vencedor = m.winnerSide === 'home' ? m.home.nome : m.away.nome;
        console.log(`[${room.id}] resultado: ${m.home.nome} ${m.score.home} x ${m.score.away} ${m.away.nome} — vencedor: ${vencedor}`);
        advanceUntilActionable(room);
        if (room.stage === 'over') {
          console.log(`[${room.id}] torneio encerrado — campeão: ${room.champion ? room.champion.nome : '???'}`);
        } else if (room.bracket.every(x => x.winnerSide) === false) {
          // ainda restam partidas pendentes nesta mesma fase — nada a logar
        } else {
          console.log(`[${room.id}] fase avançou para ${room.phase} (${room.bracket.length} partidas)`);
        }
        broadcastTournamentState(room);
        break;
      }
      // cliente pede o estado atual de novo (recuperação caso a tela trave)
      case 'resync': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        if (room.stage === 'tournament') {
          send(ws, { type: 'tournamentUpdate', phase: room.phase, bracket: publicBracket(room), history: room.history });
        } else if (room.stage === 'over') {
          send(ws, { type: 'tournamentOver', champion: room.champion, bracket: publicBracket(room), history: room.history });
        } else if (room.stage === 'draft') {
          send(ws, { type: 'draftPhase', room: publicRoom(room) });
          send(ws, { type: 'draftProgress', done: room.draftDone.size, total: room.players.size, doneIds: Array.from(room.draftDone) });
        } else {
          send(ws, { type: 'update', room: publicRoom(room) });
        }
        break;
      }
      case 'leave': {
        leaveRoom(ws);
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

// keep-alive: derruba conexões mortas
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// limpeza de salas abandonadas
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 30 * 60 * 1000);

wss.on('close', () => { clearInterval(pingInterval); clearInterval(cleanupInterval); });

server.listen(PORT, () => {
  console.log(`Copeiro multiplayer server ouvindo na porta ${PORT}`);
});
