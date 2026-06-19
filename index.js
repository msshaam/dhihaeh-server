const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { dealCards, sortHand } = require('./gameLogic');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function rankValue(rank) { return RANK_ORDER.indexOf(rank); }

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomPublicState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id, name: p.name, team: p.team,
    seatIndex: p.seatIndex, isOwner: p.id === room.ownerId, connected: !!p.socketId
  }));
  const team1 = players.filter(p => p.team === 1);
  const team2 = players.filter(p => p.team === 2);
  return {
    code: room.code, ownerId: room.ownerId, status: room.status,
    players, team1, team2, teamNames: room.teamNames,
    canStart: team1.length === 2 && team2.length === 2
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', getRoomPublicState(room));
}

function buildSeatOrder(room) {
  const allPlayers = Object.values(room.players);
  const owner = allPlayers.find(p => p.id === room.ownerId);
  const ownerTeam = owner.team;
  const oppTeam = ownerTeam === 1 ? 2 : 1;
  const teammate = allPlayers.find(p => p.team === ownerTeam && p.id !== room.ownerId);
  const opponents = allPlayers.filter(p => p.team === oppTeam);
  // Anticlockwise: P1(owner/dealer), P2(next anticlockwise), P3, P4
  return [owner.id, opponents[0].id, teammate.id, opponents[1].id];
}

// ── Game logic helpers ────────────────────────────────────────

function getTeamOfPlayer(room, playerId) {
  return room.players[playerId]?.team;
}

function resolveRound(roundCards, leadSuit, hukunSuit) {
  // roundCards: [{ playerId, card }] in play order
  let winner = null;
  let winnerVal = -1;

  // Check if any hukun suit cards played
  const hukunPlays = hukunSuit ? roundCards.filter(rc => rc.card.suit === hukunSuit) : [];

  if (hukunPlays.length > 0) {
    // Highest hukun suit wins
    for (const rc of hukunPlays) {
      const v = rankValue(rc.card.rank);
      if (v > winnerVal) { winnerVal = v; winner = rc; }
    }
  } else {
    // Highest lead suit wins
    const leadPlays = roundCards.filter(rc => rc.card.suit === leadSuit);
    for (const rc of leadPlays) {
      const v = rankValue(rc.card.rank);
      if (v > winnerVal) { winnerVal = v; winner = rc; }
    }
  }
  return winner;
}

function checkGameEnd(game, room) {
  const t1 = game.score[1];
  const t2 = game.score[2];

  // HAAS BUG: one team all 4 tens + other team 0 piles
  if (t1.tens === 4 && t2.piles === 0) return { ended: true, winner: 1, bug: 'haas' };
  if (t2.tens === 4 && t1.piles === 0) return { ended: true, winner: 2, bug: 'haas' };

  // BUG: one team all 4 tens + other team has piles
  if (t1.tens === 4) return { ended: true, winner: 1, bug: 'bug' };
  if (t2.tens === 4) return { ended: true, winner: 2, bug: 'bug' };

  // One team gets 3 tens → only end if the other team has the 4th ten (all 4 tens distributed)
  if (t1.tens === 3 && t2.tens === 1) return { ended: true, winner: 1, bug: false };
  if (t2.tens === 3 && t1.tens === 1) return { ended: true, winner: 2, bug: false };
  // If other team has 0 tens, 4th ten is still in play → continue (BUG/HAAS BUG still possible) (4th 10 still in play)

  // 2-2 tens + one team has >= 7 piles
  if (t1.tens === 2 && t2.tens === 2) {
    if (t1.piles >= 7) return { ended: true, winner: 1, bug: false };
    if (t2.piles >= 7) return { ended: true, winner: 2, bug: false };
  }

  // All 13 rounds played
  if (game.roundsPlayed === 13) {
    if (t1.tens !== t2.tens) {
      return { ended: true, winner: t1.tens > t2.tens ? 1 : 2, bug: false };
    }
    // Tied on tens — most piles wins
    return { ended: true, winner: t1.piles >= t2.piles ? 1 : 2, bug: false };
  }

  return { ended: false };
}

function broadcastGameState(room) {
  for (const [pid, player] of Object.entries(room.players)) {
    const sock = getSock(io, player.socketId);
    if (sock) sock.emit('gameState', buildGameStateForPlayer(room, pid));
  }
}

// ── Socket handlers ───────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('createRoom', ({ playerName }, cb) => {
    const playerId = uuidv4();
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode, ownerId: playerId, status: 'waiting',
      players: { [playerId]: { id: playerId, name: playerName, socketId: socket.id, team: null, seatIndex: null } },
      teamNames: { 1: 'Team Blue', 2: 'Team Red' },
      roundHistory: [], // [{ roundNum, winner, bug, score: {1:{tens,piles}, 2:{tens,piles}} }]
      totalScore: { 1: 0, 2: 0 }, // points won per team across all rounds
      game: null
    };
    socket.join(roomCode);
    socket.data.playerId = playerId;
    socket.data.roomCode = roomCode;
    cb({ success: true, playerId, roomCode });
    broadcastRoom(rooms[roomCode]);
  });

  socket.on('joinRoom', ({ playerName, roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.status !== 'waiting') return cb({ success: false, error: 'Game already started' });
    if (Object.keys(room.players).length >= 4) return cb({ success: false, error: 'Room is full' });
    const playerId = uuidv4();
    room.players[playerId] = { id: playerId, name: playerName, socketId: socket.id, team: null, seatIndex: null };
    socket.join(roomCode);
    socket.data.playerId = playerId;
    socket.data.roomCode = roomCode;
    cb({ success: true, playerId, roomCode });
    broadcastRoom(room);
  });

  socket.on('rejoinRoom', ({ playerId, roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room || !room.players[playerId]) return cb({ success: false });
    room.players[playerId].socketId = socket.id;
    socket.join(roomCode);
    socket.data.playerId = playerId;
    socket.data.roomCode = roomCode;
    cb({ success: true });
    broadcastRoom(room);
    if (room.status === 'hukun' || room.status === 'playing') {
      socket.emit('gameState', buildGameStateForPlayer(room, playerId));
    }
  });

  socket.on('setTeamName', ({ team, name }) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'waiting') return;
    const teamPlayers = Object.values(room.players).filter(p => p.team === team);
    if (teamPlayers.length === 0 || teamPlayers[0].id !== playerId) return;
    const trimmed = (name || '').trim().slice(0, 18) || (team === 1 ? 'Team Blue' : 'Team Red');
    room.teamNames[team] = trimmed;
    broadcastRoom(room);
  });

  socket.on('pickTeam', ({ team }) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || !room.players[playerId] || room.status !== 'waiting') return;
    const player = room.players[playerId];
    player.team = team;
    const teamMembers = Object.values(room.players).filter(p => p.team === team);
    player.seatIndex = teamMembers.length - 1;
    broadcastRoom(room);
  });

  socket.on('leaveTeam', () => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || !room.players[playerId] || room.status !== 'waiting') return;
    room.players[playerId].team = null;
    room.players[playerId].seatIndex = null;
    broadcastRoom(room);
  });

  socket.on('startGame', (cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room) return cb?.({ success: false, error: 'Room not found' });
    if (room.ownerId !== playerId) return cb?.({ success: false, error: 'Only the room owner can start' });
    const team1 = Object.values(room.players).filter(p => p.team === 1);
    const team2 = Object.values(room.players).filter(p => p.team === 2);
    if (team1.length !== 2 || team2.length !== 2) return cb?.({ success: false, error: 'Need 2 players on each team' });

    const seatOrder = buildSeatOrder(room);
    const { hands, hukun5 } = dealCards(seatOrder);

    room.status = 'hukun';
    room.game = {
      seatOrder,
      hands,
      hukun5,
      hukun: null,
      hukunRevealed: false,
      hukunSuit: null,
      // Turn/round tracking
      currentTurnSeat: 1,   // P2 (index 1) starts first round
      roundCards: [],        // [{ playerId, card, seatIndex }]
      leadSuit: null,
      roundsPlayed: 0,
      // Scoring
      score: {
        1: { tens: 0, piles: 0, pilelist: [] },
        2: { tens: 0, piles: 0, pilelist: [] }
      },
      dealerSeat: 0,         // P1 is dealer (seat index 0)
      hukunSelectorSeat: 1,  // P2 selects hukun
      roundLeaderSeat: 1,    // P2 starts first round
      gameResult: null
    };

    io.to(roomCode).emit('gameStarted', { seatOrder });
    broadcastGameState(room);
    cb?.({ success: true });
  });

  socket.on('selectHukun', ({ cardId }, cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'hukun') return cb?.({ success: false });
    const p2Id = room.game.seatOrder[1];
    if (playerId !== p2Id) return cb?.({ success: false, error: 'Only P2 selects hukun' });
    const card = room.game.hukun5.find(c => c.id === cardId);
    if (!card) return cb?.({ success: false, error: 'Invalid card' });

    room.game.hukun = card;
    const remaining4 = room.game.hukun5.filter(c => c.id !== cardId);
    room.game.hands[p2Id] = sortHand([
      ...remaining4,
      ...room.game.hands[p2Id].filter(c => !room.game.hukun5.find(h => h.id === c.id))
    ]);

    room.status = 'playing';
    broadcastGameState(room);
    cb?.({ success: true });
  });

  // Player plays a card
  socket.on('playCard', ({ cardId }, cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'Game not in progress' });

    const game = room.game;
    const seatIndex = game.seatOrder.indexOf(playerId);
    if (seatIndex !== game.currentTurnSeat) return cb?.({ success: false, error: 'Not your turn' });

    const hand = game.hands[playerId];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return cb?.({ success: false, error: 'Card not in hand' });

    const card = hand[cardIdx];

    // Validate: must follow lead suit if possible
    if (game.leadSuit && card.suit !== game.leadSuit) {
      const hasLead = hand.some(c => c.suit === game.leadSuit);
      if (hasLead) return cb?.({ success: false, error: `Must follow suit: ${game.leadSuit}` });

      // Can't follow suit — if hukun revealed and has hukun suit, must play hukun suit
      if (game.hukunRevealed && game.hukunSuit) {
        const hasHukun = hand.some(c => c.suit === game.hukunSuit);
        if (hasHukun && card.suit !== game.hukunSuit) {
          // Check if this player is the one who triggered the reveal THIS round
          if (game.hukunRevealedByThisRound === playerId) {
            return cb?.({ success: false, error: `Must play hukun suit: ${game.hukunSuit}` });
          }
        }
      }
    }

    // Remove card from hand
    game.hands[playerId] = hand.filter(c => c.id !== cardId);

    // Set lead suit if first card of round
    if (game.roundCards.length === 0) game.leadSuit = card.suit;

    game.roundCards.push({ playerId, card, seatIndex });

    // Advance turn (anticlockwise = next seat index, wrapping)
    // Anticlockwise from current: next seat = (current + 3) % 4... wait
    // Seat order IS anticlockwise already: 0,1,2,3 = P1,P2,P3,P4 anticlockwise
    // So next player in play order is (currentTurnSeat + 1) % 4
    // BUT play order starts at P2 (seat 1): 1→2→3→0
    game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;

    // Check if round complete (4 cards played)
    if (game.roundCards.length === 4) {
      const winner = resolveRound(game.roundCards, game.leadSuit, game.hukunRevealed ? game.hukunSuit : null);
      const winnerTeam = getTeamOfPlayer(room, winner.playerId);
      const hasTen = game.roundCards.some(rc => rc.card.rank === '10');

      // Add pile to winner's score
      game.score[winnerTeam].piles++;
      if (hasTen) {
        const tensCount = game.roundCards.filter(rc => rc.card.rank === '10').length;
        game.score[winnerTeam].tens += tensCount;
        game.score[winnerTeam].pilelist.push({ cards: game.roundCards.map(rc => rc.card), hasTen: true });
      } else {
        game.score[winnerTeam].pilelist.push({ cards: game.roundCards.map(rc => rc.card), hasTen: false });
      }

      game.roundsPlayed++;
      const roundResult = {
        winnerPlayerId: winner.playerId,
        winnerTeam,
        cards: game.roundCards,
        hasTen,
        score: game.score
      };

      // Reset for next round
      game.roundCards = [];
      game.leadSuit = null;
      game.hukunRevealedByThisRound = null;
      game.currentTurnSeat = winner.seatIndex;
      game.roundLeaderSeat = winner.seatIndex;

      // Check game end
      const endCheck = checkGameEnd(game, room);
      if (endCheck.ended) {
        game.gameResult = endCheck;
        room.status = 'ended';

        // Record this round in history
        room.roundHistory.push({
          roundNum: room.roundHistory.length + 1,
          winner: endCheck.winner,
          bug: endCheck.bug,
          score: {
            1: { tens: game.score[1].tens, piles: game.score[1].piles },
            2: { tens: game.score[2].tens, piles: game.score[2].piles }
          }
        });
        room.totalScore[endCheck.winner] = (room.totalScore[endCheck.winner] || 0) + 1;

        // Determine next dealer
        const dealerTeam = getTeamOfPlayer(room, game.seatOrder[game.dealerSeat]);
        let nextDealerSeat = game.dealerSeat;
        if (dealerTeam === endCheck.winner) {
          const losingTeam = endCheck.winner === 1 ? 2 : 1;
          for (let i = 1; i <= 4; i++) {
            const s = (game.dealerSeat + i) % 4;
            if (getTeamOfPlayer(room, game.seatOrder[s]) === losingTeam) {
              nextDealerSeat = s; break;
            }
          }
        }
        game.nextDealerSeat = nextDealerSeat;
      }

      io.to(roomCode).emit('roundComplete', roundResult);
      broadcastGameState(room);
    } else {
      broadcastGameState(room);
    }

    cb?.({ success: true });
  });

  // Player can't follow suit — request hukun reveal
  socket.on('requestHukunReveal', (cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return cb?.({ success: false });

    const game = room.game;
    if (game.hukunRevealed) return cb?.({ success: false, error: 'Hukun already revealed' });

    const seatIndex = game.seatOrder.indexOf(playerId);
    if (seatIndex !== game.currentTurnSeat) return cb?.({ success: false, error: 'Not your turn' });

    // Validate: player must not have lead suit
    const hand = game.hands[playerId];
    if (game.leadSuit && hand.some(c => c.suit === game.leadSuit)) {
      return cb?.({ success: false, error: 'You have the lead suit' });
    }

    game.hukunRevealed = true;
    game.hukunSuit = game.hukun.suit;
    game.hukunRevealedByThisRound = playerId;

    const p2Id = game.seatOrder[1];
    const isP2 = playerId === p2Id;

    if (isP2) {
      // Scenario A: P2 reveals — auto-play the hukun card to the centre
      // Remove hukun card from P2's hand (it was never there after selection, so just play it directly)
      game.hands[p2Id] = game.hands[p2Id].filter(c => c.id !== game.hukun.id);
      if (game.roundCards.length === 0) game.leadSuit = game.hukun.suit;
      game.roundCards.push({ playerId, card: game.hukun, seatIndex });
      game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;
    } else {
      // Scenario B: someone other than P2 reveals — hukun card goes into P2's hand
      game.hands[p2Id] = sortHand([game.hukun, ...game.hands[p2Id]]);
    }

    io.to(roomCode).emit('hukunRevealed', {
      hukun: game.hukun,
      hukunSuit: game.hukunSuit,
      revealedBy: playerId,
      revealedByName: room.players[playerId]?.name,
      isP2
    });

    // Check if round is now complete after auto-play (shouldn't happen on first card but be safe)
    if (game.roundCards.length === 4) {
      const winner = resolveRound(game.roundCards, game.leadSuit, game.hukunSuit);
      const winnerTeam = getTeamOfPlayer(room, winner.playerId);
      const hasTen = game.roundCards.some(rc => rc.card.rank === '10');
      const tensCount = game.roundCards.filter(rc => rc.card.rank === '10').length;
      game.score[winnerTeam].piles++;
      if (hasTen) game.score[winnerTeam].tens += tensCount;
      game.score[winnerTeam].pilelist.push({ cards: game.roundCards.map(rc => rc.card), hasTen });
      game.roundsPlayed++;
      const roundResult = { winnerPlayerId: winner.playerId, winnerTeam, cards: game.roundCards, hasTen, score: game.score };
      game.roundCards = [];
      game.leadSuit = null;
      game.hukunRevealedByThisRound = null;
      game.currentTurnSeat = winner.seatIndex;
      game.roundLeaderSeat = winner.seatIndex;
      const endCheck = checkGameEnd(game, room);
      if (endCheck.ended) {
        game.gameResult = endCheck;
        room.status = 'ended';
        room.roundHistory.push({ roundNum: room.roundHistory.length + 1, winner: endCheck.winner, bug: endCheck.bug, score: { 1: { tens: game.score[1].tens, piles: game.score[1].piles }, 2: { tens: game.score[2].tens, piles: game.score[2].piles } } });
        room.totalScore[endCheck.winner] = (room.totalScore[endCheck.winner] || 0) + 1;
        const dealerTeam = getTeamOfPlayer(room, game.seatOrder[game.dealerSeat]);
        let nextDealerSeat = game.dealerSeat;
        if (dealerTeam === endCheck.winner) {
          const losingTeam = endCheck.winner === 1 ? 2 : 1;
          for (let i = 1; i <= 4; i++) { const s = (game.dealerSeat + i) % 4; if (getTeamOfPlayer(room, game.seatOrder[s]) === losingTeam) { nextDealerSeat = s; break; } }
        }
        game.nextDealerSeat = nextDealerSeat;
      }
      io.to(roomCode).emit('roundComplete', roundResult);
    }

    broadcastGameState(room);
    cb?.({ success: true, hukunSuit: game.hukunSuit, isP2 });
  });

  // Next dealer starts a new game
  socket.on('restartGame', (cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'ended') return cb?.({ success: false });

    const game = room.game;
    const nextDealerSeat = game.nextDealerSeat ?? game.dealerSeat;
    if (game.seatOrder[nextDealerSeat] !== playerId) {
      return cb?.({ success: false, error: 'Only the next dealer can start the next game' });
    }

    // Rotate seat order so new dealer is at index 0
    const oldOrder = game.seatOrder;
    const newOrder = [
      oldOrder[nextDealerSeat],
      oldOrder[(nextDealerSeat + 1) % 4],
      oldOrder[(nextDealerSeat + 2) % 4],
      oldOrder[(nextDealerSeat + 3) % 4],
    ];

    const { hands, hukun5 } = dealCards(newOrder);
    room.status = 'hukun';
    room.game = {
      seatOrder: newOrder,
      hands,
      hukun5,
      hukun: null,
      hukunRevealed: false,
      hukunSuit: null,
      currentTurnSeat: 1,
      roundCards: [],
      leadSuit: null,
      roundsPlayed: 0,
      score: {
        1: { tens: 0, piles: 0, pilelist: [] },
        2: { tens: 0, piles: 0, pilelist: [] }
      },
      dealerSeat: 0,
      hukunSelectorSeat: 1,
      roundLeaderSeat: 1,
      gameResult: null
    };

    broadcastGameState(room);
    cb?.({ success: true });
  });

  // ── DEBUG ONLY: start a game with forced hands/hukun instead of random deal ──
  // payload: { hands: [seat0Cards[13], seat1Cards[13], seat2Cards[13], seat3Cards[13]],
  //            hukunCard: {rank, suit} (optional, must be one of seat1's cards),
  //            autoReveal: bool (optional, skip straight to hukun revealed),
  //            score: {1:{tens,piles}, 2:{tens,piles}} (optional starting score),
  //            roundsPlayed: number (optional) }
  // Seats are in seat order: 0=P1(dealer), 1=P2(hukun selector), 2=P3, 3=P4 — anticlockwise.
  socket.on('debugDeal', (payload, cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room) return cb?.({ success: false, error: 'Room not found' });
    if (room.ownerId !== playerId) return cb?.({ success: false, error: 'Only the room owner can start' });
    const team1 = Object.values(room.players).filter(p => p.team === 1);
    const team2 = Object.values(room.players).filter(p => p.team === 2);
    if (team1.length !== 2 || team2.length !== 2) return cb?.({ success: false, error: 'Need 2 players on each team' });

    const seatOrder = buildSeatOrder(room);
    let hands, hukun5, hukun = null, hukunRevealed = false, hukunSuit = null;

    if (Array.isArray(payload?.hands) && payload.hands.length === 4) {
      hands = {};
      seatOrder.forEach((pid, i) => {
        hands[pid] = sortHand((payload.hands[i] || []).map(c => ({ ...c, id: c.id || `${c.rank}${c.suit}` })));
      });
      const p2Id = seatOrder[1];
      if (payload.hukunCard) {
        hukun = { ...payload.hukunCard, id: payload.hukunCard.id || `${payload.hukunCard.rank}${payload.hukunCard.suit}` };
        hands[p2Id] = hands[p2Id].filter(c => c.id !== hukun.id);
        hukun5 = [hukun, ...hands[p2Id].slice(0, 4)];
        if (payload.autoReveal) { hukunRevealed = true; hukunSuit = hukun.suit; }
      } else {
        hukun5 = hands[p2Id].slice(0, 5);
      }
    } else {
      ({ hands, hukun5 } = dealCards(seatOrder));
    }

    room.status = hukunRevealed ? 'playing' : 'hukun';
    room.game = {
      seatOrder, hands, hukun5,
      hukun: hukunRevealed ? hukun : null,
      hukunRevealed, hukunSuit,
      currentTurnSeat: payload?.currentTurnSeat ?? 1,
      roundCards: [],
      leadSuit: null,
      roundsPlayed: payload?.roundsPlayed || 0,
      score: payload?.score
        ? {
            1: { tens: payload.score[1]?.tens || 0, piles: payload.score[1]?.piles || 0, pilelist: [] },
            2: { tens: payload.score[2]?.tens || 0, piles: payload.score[2]?.piles || 0, pilelist: [] }
          }
        : { 1: { tens: 0, piles: 0, pilelist: [] }, 2: { tens: 0, piles: 0, pilelist: [] } },
      dealerSeat: 0,
      hukunSelectorSeat: 1,
      roundLeaderSeat: 1,
      gameResult: null
    };

    io.to(roomCode).emit('gameStarted', { seatOrder });
    broadcastGameState(room);
    cb?.({ success: true });
  });

  // ── DEBUG ONLY: live-patch score/rounds mid-game to jump straight to a scenario ──
  // overrides: { score: {1:{tens,piles}, 2:{tens,piles}}, roundsPlayed: number, currentTurnSeat: number }
  socket.on('debugPatch', (overrides, cb) => {
    const { playerId, roomCode } = socket.data;
    const room = rooms[roomCode];
    if (!room || !room.game) return cb?.({ success: false, error: 'No active game' });
    if (room.ownerId !== playerId) return cb?.({ success: false, error: 'Only the room owner can use debug' });

    const game = room.game;
    if (overrides.score) {
      if (overrides.score[1]) Object.assign(game.score[1], overrides.score[1]);
      if (overrides.score[2]) Object.assign(game.score[2], overrides.score[2]);
    }
    if (overrides.roundsPlayed != null) game.roundsPlayed = overrides.roundsPlayed;
    if (overrides.currentTurnSeat != null) game.currentTurnSeat = overrides.currentTurnSeat;

    const endCheck = checkGameEnd(game, room);
    if (endCheck.ended && room.status !== 'ended') {
      game.gameResult = endCheck;
      room.status = 'ended';
      room.roundHistory.push({
        roundNum: room.roundHistory.length + 1,
        winner: endCheck.winner,
        bug: endCheck.bug,
        score: { 1: { tens: game.score[1].tens, piles: game.score[1].piles }, 2: { tens: game.score[2].tens, piles: game.score[2].piles } }
      });
      room.totalScore[endCheck.winner] = (room.totalScore[endCheck.winner] || 0) + 1;
      const dealerTeam = getTeamOfPlayer(room, game.seatOrder[game.dealerSeat]);
      let nextDealerSeat = game.dealerSeat;
      if (dealerTeam === endCheck.winner) {
        const losingTeam = endCheck.winner === 1 ? 2 : 1;
        for (let i = 1; i <= 4; i++) {
          const s = (game.dealerSeat + i) % 4;
          if (getTeamOfPlayer(room, game.seatOrder[s]) === losingTeam) { nextDealerSeat = s; break; }
        }
      }
      game.nextDealerSeat = nextDealerSeat;
    }

    broadcastGameState(room);
    cb?.({ success: true, ended: endCheck.ended });
  });

  socket.on('disconnect', () => {
    const { playerId, roomCode } = socket.data;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (room.players[playerId]) room.players[playerId].socketId = null;
    broadcastRoom(room);
  });
});

function getSock(io, socketId) {
  return socketId ? io.sockets.sockets.get(socketId) : null;
}

function buildGameStateForPlayer(room, playerId) {
  const game = room.game;
  const seatOrder = game.seatOrder;
  const seatIndex = seatOrder.indexOf(playerId);
  const p2Id = seatOrder[1];
  const isP2 = playerId === p2Id;

  const players = seatOrder.map((pid, idx) => ({
    id: pid,
    name: room.players[pid]?.name,
    seat: idx + 1,
    team: room.players[pid]?.team,
    isOwner: pid === room.ownerId,
    cardCount: game.hands[pid]?.length ?? 0,
    connected: !!room.players[pid]?.socketId,
    isCurrentTurn: idx === game.currentTurnSeat
  }));

  return {
    status: room.status,
    seatIndex,
    myHand: game.hands[playerId] ?? [],
    players,
    hukun: game.hukun,
    hukunRevealed: game.hukunRevealed,
    hukunSuit: game.hukunSuit,
    leadSuit: game.leadSuit,
    roundCards: game.roundCards,
    currentTurnSeat: game.currentTurnSeat,
    score: {
      1: { tens: game.score[1].tens, piles: game.score[1].piles, pilelist: game.score[1].pilelist },
      2: { tens: game.score[2].tens, piles: game.score[2].piles, pilelist: game.score[2].pilelist }
    },
    teamNames: room.teamNames,
    roundsPlayed: game.roundsPlayed,
    gameResult: game.gameResult || null,
    nextDealerSeat: game.nextDealerSeat ?? null,
    nextDealerId: game.nextDealerSeat != null ? game.seatOrder[game.nextDealerSeat] : null,
    dealerSeat: game.dealerSeat,
    roundHistory: room.roundHistory,
    totalScore: room.totalScore,
    hukun5: room.status === 'hukun'
      ? (isP2 ? game.hukun5 : game.hukun5.map(() => ({ id: 'hidden', rank: '?', suit: '?' })))
      : null
  };
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Dhihaeh server running on port ${PORT}`));
