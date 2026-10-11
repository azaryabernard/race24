/** Shared exact 24 engine. Runs in browsers, Node, and Supabase Edge Functions. */
export const RULES_VERSION = 1;
export const TARGET = 24;
export const MAX_POWER_EXPONENT = 100;
export const MAX_BITS = 256; // Safety limit on intermediate rational sizes.
export const TEN_RANKS = new Set(['10', 'J', 'Q', 'K']);
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Expert'];

function abs(n) { return n < 0n ? -n : n; }
function gcd(a, b) { a = abs(a); b = abs(b); while (b !== 0n) [a, b] = [b, a % b]; return a || 1n; }
function bitLength(n) { return abs(n).toString(2).length; }
export function rational(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (!d) throw Error('Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); n /= g; d /= g;
  if (bitLength(n) > MAX_BITS || bitLength(d) > MAX_BITS) throw Error('Intermediate number too large');
  return { n, d };
}
export const R = {
  add: (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d),
  sub: (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d),
  mul: (a, b) => rational(a.n * b.n, a.d * b.d),
  div: (a, b) => rational(a.n * b.d, a.d * b.n),
};
export function formatR(x) { return x.d === 1n ? String(x.n) : `${x.n}/${x.d}`; }
export function equalR(a, b) { return a.n === b.n && a.d === b.d; }
export function power(a, b) {
  if (b.d !== 1n || abs(b.n) > BigInt(MAX_POWER_EXPONENT)) throw Error('Exponent must be integer and <= 100');
  if (!a.n && !b.n) throw Error('0^0 undefined');
  if (!a.n && b.n < 0n) throw Error('Zero to negative power');
  const n = abs(b.n);
  // Early check prevents very large temporary BigInts before exponentiation.
  if (n > 0n && (bitLength(a.n) - 1) * Number(n) > MAX_BITS + 1) throw Error('Power too large');
  if (n > 0n && (bitLength(a.d) - 1) * Number(n) > MAX_BITS + 1) throw Error('Power too large');
  return b.n >= 0n ? rational(a.n ** n, a.d ** n) : rational(a.d ** n, a.n ** n);
}
export function integerLog(x, base) {
  if (x.n <= 0n || base.n <= 0n || base.n === base.d) throw Error('Invalid logarithm');
  let sign = 1n;
  if (base.n < base.d) { base = rational(base.d, base.n); sign = -sign; }
  if (x.n < x.d) { x = rational(x.d, x.n); sign = -sign; }
  let numerator = x.n, exponent = 0n;
  while (numerator > 1n) {
    if (numerator % base.n) throw Error('Noninteger logarithm');
    numerator /= base.n;
    exponent++;
  }
  if (base.d ** exponent !== x.d) throw Error('Noninteger logarithm');
  return rational(sign * exponent);
}
export function integerRoot(x, degree) {
  if (degree.d !== 1n || !degree.n) throw Error('Root degree must be nonzero integer');
  let n = degree.n;
  if (n < 0n) {
    if (!x.n) throw Error('Zero with negative root degree');
    x = rational(x.d, x.n); n = -n;
  }
  if (x.d !== 1n) throw Error('Noninteger root');
  if (x.n < 0n && n % 2n === 0n) throw Error('Even root of a negative number');
  const magnitude = abs(x.n);
  if (magnitude <= 1n) return rational(x.n);
  if (n > BigInt(bitLength(magnitude) - 1)) throw Error('Noninteger root');
  let low = 1n, high = 1n << BigInt(Math.ceil(bitLength(magnitude) / Number(n)));
  while (low <= high) {
    const middle = (low + high) / 2n;
    const powered = middle ** n;
    if (powered === magnitude) return rational(x.n < 0n ? -middle : middle);
    if (powered < magnitude) low = middle + 1n;
    else high = middle - 1n;
  }
  throw Error('Noninteger root');
}

export const OPERATIONS = Object.freeze({
  '+': { evaluate: R.add, cost: 1, commutative: true, print: (a, b) => `(${a} + ${b})` },
  '-': { evaluate: R.sub, cost: 1, print: (a, b) => `(${a} - ${b})` },
  '*': { evaluate: R.mul, cost: 1, commutative: true, print: (a, b) => `(${a} × ${b})` },
  '/': { evaluate: R.div, cost: 2, print: (a, b) => `(${a} ÷ ${b})` },
  '^': { evaluate: power, cost: 4, print: (a, b) => `(${a} ^ ${b})` },
  'log': { evaluate: integerLog, cost: 5, print: (a, b) => `log_${b}(${a})` },
  'root': { evaluate: integerRoot, cost: 5, print: (a, b) => `root(${a}, ${b})` },
});

export function rankValue(rank) {
  rank = String(rank).trim().toUpperCase();
  if (rank === 'A' || rank === '1') return 1;
  if (TEN_RANKS.has(rank)) return 10;
  const value = Number(rank);
  if (!Number.isInteger(value) || value < 2 || value > 9) throw Error(`Invalid rank: ${rank}`);
  return value;
}
export function canonicalKey(cards) { return cards.map(c => rankValue(typeof c === 'string' ? c : c.rank)).sort((a, b) => a - b).join('-'); }
export function cardChoices(rank) { return String(rank).toUpperCase() === 'A' ? [1, 11] : [rankValue(rank)]; }
export function leaf(card, index, ace = 1) {
  const value = cardChoices(card.rank);
  const chosen = value.includes(ace) ? ace : value[0];
  return { id: index, value: rational(chosen), expr: { card: index, ...(String(card.rank).toUpperCase() === 'A' ? { ace: chosen } : {}) }, text: String(chosen), origin: card.rank };
}
export function combine(left, opName, right, id = 0) {
  const op = OPERATIONS[opName];
  if (!op) throw Error('Unknown operation');
  const value = op.evaluate(left.value, right.value);
  return { id, value, expr: { op: opName, left: left.expr, right: right.expr }, text: op.print(left.text, right.text) };
}

export function verifySolution(cards, expression) {
  if (!Array.isArray(cards) || cards.length !== 4) throw Error('Must have four cards');
  const seen = new Set();
  let count = 0;
  function visit(node, depth = 0) {
    if (depth > 6 || !node || typeof node !== 'object' || Array.isArray(node)) throw Error('Bad expression');
    count++;
    if (count > 7) throw Error('Too many expression nodes');
    if (Object.hasOwn(node, 'card')) {
      const idx = node.card;
      if (!Number.isInteger(idx) || idx < 0 || idx >= 4 || seen.has(idx)) throw Error('Card repeated or invalid');
      seen.add(idx);
      const choices = cardChoices(cards[idx].rank);
      const value = choices.length === 2 ? node.ace : choices[0];
      if (!choices.includes(value)) throw Error('Invalid Ace choice');
      return { value: rational(value), text: String(value) };
    }
    if (typeof node.op !== 'string' || !Object.hasOwn(OPERATIONS, node.op)) throw Error('Unknown operation');
    const a = visit(node.left, depth + 1), b = visit(node.right, depth + 1);
    return { value: OPERATIONS[node.op].evaluate(a.value, b.value), text: OPERATIONS[node.op].print(a.text, b.text) };
  }
  try {
    const answer = visit(expression);
    return { valid: seen.size === 4 && count === 7 && equalR(answer.value, rational(TARGET)), text: answer.text };
  } catch { return { valid: false, text: '' }; }
}

export function drawHand(random = Math.random) {
  const deck = [];
  for (const rank of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) {
    for (const suit of ['♠', '♥', '♦', '♣']) deck.push({ rank, suit });
  }
  const cards = [];
  for (let i = 0; i < 4; i++) {
    const tens = cards.filter(c => rankValue(c.rank) === 10).length;
    const possible = deck.filter(c => tens < 2 || rankValue(c.rank) !== 10);
    const weights = possible.map(c => rankValue(c.rank) === 10 ? 0.5 : 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let ticket = random() * total;
    let index = 0;
    for (; index < possible.length - 1; index++) { ticket -= weights[index]; if (ticket < 0) break; }
    const card = possible[index];
    cards.push(card);
    deck.splice(deck.findIndex(c => c.rank === card.rank && c.suit === card.suit), 1);
  }
  return cards;
}

/** Turn a winning expression into three readable, exact intermediate steps.
 *  The trace deliberately contains numerical values only, so a canonical hand
 *  can reuse it with the same values in a different card order or with J/Q/K.
 */
function traceSolution(expression, cards) {
  const steps = [], aceValues = [];
  function visit(node) {
    if (Object.hasOwn(node, 'card')) {
      const rank = String(cards[node.card].rank).toUpperCase();
      if (rank === 'A') aceValues.push(node.ace);
      return rational(rank === 'A' ? node.ace : rankValue(rank));
    }
    const left = visit(node.left), right = visit(node.right);
    const result = OPERATIONS[node.op].evaluate(left, right);
    const a = formatR(left), b = formatR(right), c = formatR(result);
    const text = node.op === 'log' ? `log base ${b} of ${a} = ${c}`
      : node.op === 'root' ? `root(${a}, ${b}) = ${c}`
      : `${a} ${{ '*': '×', '/': '÷' }[node.op] || node.op} ${b} = ${c}`;
    steps.push(text);
    return result;
  }
  const result = visit(expression);
  if (steps.length !== 3 || !equalR(result, rational(TARGET))) throw Error('Invalid solver trace');
  return { steps, aceValues };
}

/** Difficulty v2 scores the easiest human-style route, NOT the number of
 *  terminal branches encountered by memoization. All scores are nonnegative
 *  integers, so pruning more expensive paths to the same numeric state is safe.
 *
 *  Basic arithmetic is searched first and always wins over a solution using
 *  ^, log, or root. This avoids treating tricks such as 1^3 as the easiest
 *  solution when a normal arithmetic solution exists.
 */
export const DIFFICULTY_VERSION = 2;
const BASIC_OPERATIONS = Object.entries(OPERATIONS).filter(([name]) => ['+', '-', '*', '/'].includes(name));
const ALL_OPERATIONS = Object.entries(OPERATIONS);

function humanStepCost(symbol, op, value) {
  // Fractions and negative intermediate values require more mental work.
  // Use BigInt comparisons to avoid lossy floating-point conversion.
  let cost = op.cost + (symbol === '*' ? 1 : 0);
  if (value.d !== 1n) cost += 3;
  if (value.n < 0n) cost += 1;
  if (abs(value.n) >= 100n * value.d) cost += 1;
  if (abs(value.n) >= 1000n * value.d) cost += 2;
  return cost;
}

/** Count distinct useful first moves, rather than counting winning leaves from
 *  a pruned DFS. Two moves leading to the same three-number state count once.
 *  Every counted move has a basic-arithmetic completion with cost <= 8.
 *  This is independent of card order and search/pruning order.
 */
function countHelpfulOpenings(cards) {
  const remainingCostCache = new Map();
  function minimumRemainingCost(items) {
    if (items.length === 1) return equalR(items[0], rational(TARGET)) ? 0 : Infinity;
    const state = items.map(formatR).sort().join('|');
    if (remainingCostCache.has(state)) return remainingCostCache.get(state);
    let best = Infinity;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const remainder = items.filter((_, index) => index !== i && index !== j);
      for (const [symbol, op] of BASIC_OPERATIONS) {
        const pairs = op.commutative ? [[items[i], items[j]]] : [[items[i], items[j]], [items[j], items[i]]];
        for (const [a, b] of pairs) {
          try {
            const value = op.evaluate(a, b);
            best = Math.min(best, humanStepCost(symbol, op, value) + minimumRemainingCost([...remainder, value]));
          } catch { /* Invalid operation */ }
        }
      }
    }
    remainingCostCache.set(state, best);
    return best;
  }
  const useful = new Set();
  function tryOpenings(values) {
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      const remaining = values.filter((_, index) => index !== i && index !== j);
      for (const [symbol, op] of BASIC_OPERATIONS) {
        const pairs = op.commutative ? [[values[i], values[j]]] : [[values[i], values[j]], [values[j], values[i]]];
        for (const [a, b] of pairs) {
          try {
            const value = op.evaluate(a, b);
            if (humanStepCost(symbol, op, value) + minimumRemainingCost([...remaining, value]) > 8) continue;
            useful.add([...remaining, value].map(formatR).sort().join('|'));
          } catch { /* Invalid operation */ }
        }
      }
    }
  }
  function variants(i, values) {
    if (i === cards.length) { tryOpenings(values); return; }
    for (const ace of cardChoices(cards[i].rank)) variants(i + 1, [...values, rational(ace)]);
  }
  variants(0, []);
  return useful.size;
}

/** Analyze a four-card hand while preserving the exact solver and its proof. */
export function analyzeHand(cards) {
  cards = cards.map(c => typeof c === 'string' ? { rank: c, suit: '' } : c);
  if (cards.length !== 4) throw Error('Exactly 4 cards required');
  const key = canonicalKey(cards);
  const cached = analysisCache.get(key);
  if (cached) return cached;

  function findBest(operations) {
    let best = null, bestCost = Infinity, solutions = 0;
    const seen = new Map();
    function walk(items, score) {
      if (score > bestCost) return;
      if (items.length === 1) {
        if (equalR(items[0].value, rational(TARGET))) {
          solutions++;
          if (score < bestCost) { best = items[0]; bestCost = score; }
        }
        return;
      }
      const state = items.map(i => formatR(i.value)).sort().join('|');
      if (seen.has(state) && seen.get(state) <= score) return;
      seen.set(state, score);
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const remaining = items.filter((_, index) => index !== i && index !== j);
        for (const [symbol, op] of operations) {
          const pairs = op.commutative ? [[items[i], items[j]]] : [[items[i], items[j]], [items[j], items[i]]];
          for (const [a, b] of pairs) {
            try {
              const item = combine(a, symbol, b);
              walk([...remaining, item], score + humanStepCost(symbol, op, item.value));
            } catch { /* Invalid domain, oversized intermediate, etc. */ }
          }
        }
      }
    }
    function variants(i, initial) {
      if (i === cards.length) { walk(initial, 0); return; }
      for (const ace of cardChoices(cards[i].rank)) variants(i + 1, [...initial, leaf(cards[i], i, ace)]);
    }
    variants(0, []);
    return { best, bestCost, solutions, exploredStates: seen.size };
  }

  const basic = findBest(BASIC_OPERATIONS);
  const resultSearch = basic.best ? basic : findBest(ALL_OPERATIONS);
  const { best, bestCost } = resultSearch;
  // Exceptional arithmetic can still be Expert, but a division by a small
  // exact integer is never Expert solely because few routes were discovered.
  const helpfulOpenings = basic.best ? countHelpfulOpenings(cards) : 0;
  // Scarcity matters only for otherwise approachable hands. Expert is reserved
  // for advanced-only solutions or exceptional arithmetic/fraction work.
  const difficulty = !best ? 'Unsolvable'
    : !basic.best || bestCost >= 10 ? 'Expert'
      : bestCost <= 3 ? 'Easy'
        : bestCost >= 6 ? 'Hard'
          : bestCost === 4
            ? helpfulOpenings >= 9 ? 'Easy' : 'Medium'
            : helpfulOpenings >= 3 ? 'Medium' : 'Hard';
  const trace = best ? traceSolution(best.expr, cards) : null;
  const result = { key, solvable: !!best, difficulty, score: bestCost,
    difficultyVersion: DIFFICULTY_VERSION, helpfulOpenings, usesAdvanced: !basic.best && !!best,
    solution: best?.text || null, solutionSteps: trace?.steps || null,
    solutionAceValues: trace?.aceValues || [], exploredStates: resultSearch.exploredStates,
    solutionStates: resultSearch.solutions };
  analysisCache.set(key, result);
  return result;
}
const analysisCache = new Map();
