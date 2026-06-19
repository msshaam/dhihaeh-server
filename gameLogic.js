const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_ORDER = ['♠', '♥', '♦', '♣'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, id: `${rank}${suit}` });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Sort hand: group by suit, within suit low→high
function sortHand(cards) {
  return [...cards].sort((a, b) => {
    const si = SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit);
    if (si !== 0) return si;
    return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  });
}

function dealCards(playerIds) {
  const [p1, p2, p3, p4] = playerIds;
  const dealOrder = [p4, p3, p2, p1];
  const deck = createDeck();
  const hands = {};
  playerIds.forEach(id => { hands[id] = []; });
  for (let round = 0; round < 13; round++) {
    for (const pid of dealOrder) {
      hands[pid].push(deck.pop());
    }
  }
  // Sort all hands
  playerIds.forEach(id => { hands[id] = sortHand(hands[id]); });
  const hukun5 = hands[p2].slice(0, 5);
  return { hands, hukun5 };
}

module.exports = { createDeck, dealCards, sortHand };
