import {
  OPERATIONS, DIFFICULTIES, DIFFICULTY_VERSION, TARGET, drawHand, analyzeHand, canonicalKey,
  cardChoices, leaf, combine, equalR, rational, formatR, verifySolution,
} from './engine.js';
import { config } from './config.js';

const $ = id => document.getElementById(id);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = ms => (ms / 1000).toFixed(2) + 's';
// Show tenths while playing, hundredths for a stopped/final time.
// Formatting precision never affects the measured or stored milliseconds.
const timerText = (ms, decimals = 2) => {
  const elapsed = Math.max(0, Math.floor(ms));
  const secs = Math.floor(elapsed / 1000);
  const fraction = decimals === 1
    ? String(Math.floor((elapsed % 1000) / 100))
    : String(Math.floor((elapsed % 1000) / 10)).padStart(2, '0');
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}.${fraction}`;
};
const storageKey = '24race-v1-records';
// Upgrade old local records in place; preserve every original best time and
// attempt count. The underlying math rules / storage key have not changed.
const safeLoad = () => {
  try {
    const loaded = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return {};
    let changed = false;
    for (const [key, entry] of Object.entries(loaded)) {
      if (!entry || typeof entry !== 'object' || entry.difficultyVersion === DIFFICULTY_VERSION) continue;
      const values = key.split('-');
      if (values.length !== 4 || !values.every(v => /^(10|[1-9])$/.test(v))) continue;
      try {
        const report = analyzeHand(values.map(v => v === '1' ? 'A' : v));
        if (!report.solvable) continue;
        entry.difficulty = report.difficulty;
        entry.difficultyVersion = DIFFICULTY_VERSION;
        changed = true;
      } catch { /* Keep older records untouched if their hand key is invalid. */ }
    }
    if (changed) localStorage.setItem(storageKey, JSON.stringify(loaded));
    return loaded;
  } catch { return {}; }
};
const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(records)); } catch { notify('Local storage is unavailable.', 'error'); } };
let records = safeLoad();
let supabase = null, user = null, familyMember = false, familyName = null;
let memberships = [], selectedFamilyId = null, cloudChallengeFamilyId = null;
const familyStorageKey = 'race24-selected-family';
let cloudBest = [];
let cloudChallengeId = null;
let cloudEligible = false;
let cards = [], tiles = [], history = [], selected = { a: null, b: null }, operation = null;
let round = 0, nextId = 4, analysis = null, clockStart = 0, stoppedMs = 0, running = false, finished = false;
let selectedDifficulty = 'Easy', busy = false;
let clockInterval = null;
let gameMode = 'solo';
let mpRoomId = null, mpSnapshot = null, mpPollInterval = null, mpTickInterval = null;
let mpOffsetMs = 0, mpRoundId = null, mpHandLoaded = false;
let mpSubmitting = false, mpPendingExpression = null, mpFetching = false, mpActionBusy = false;
let mpLastCountdown = null;

function notify(message, kind = '') { $('banner').textContent = message; $('banner').className = `banner ${kind}`; }
function drawClock() {
  if (!running) return;
  stoppedMs = Math.max(0, performance.now() - clockStart);
  const visible = timerText(stoppedMs, 1);
  // Only change the text when the displayed tenth changes.
  if ($('timer').textContent !== visible) $('timer').textContent = visible;
}
function stopClock() {
  if (running) stoppedMs = Math.max(0, performance.now() - clockStart);
  running = false;
  clearInterval(clockInterval);
  clockInterval = null;
  $('timer').textContent = timerText(stoppedMs, 2);
  return Math.round(stoppedMs);
}
function beginClock() {
  clearInterval(clockInterval);
  stoppedMs = 0;
  clockStart = performance.now();
  running = true;
  drawClock();
  // Poll every 50ms for responsive tenths; text changes at most 10 times/sec.
  clockInterval = setInterval(drawClock, 50);
}
function setSelection(a = null, b = null) { selected = { a, b }; updateSelection(); }
function updateSelection() {
  if (selected.a === null || selected.b === null) closeQuickOperations();
  for (const tile of document.querySelectorAll('.number-tile')) tile.classList.toggle('selected', tile.dataset.tileId === String(selected.a) || tile.dataset.tileId === String(selected.b));
  for (const slot of ['a', 'b']) {
    const tile = tiles.find(t => t.id === selected[slot]);
    $(slot === 'a' ? 'slotA' : 'slotB').textContent = tile ? formatR(tile.value) : 'Tap or drop';
    document.querySelector(`[data-slot="${slot}"]`)?.classList.toggle('filled', !!tile);
  }
  $('opDisplay').textContent = operation === '*' ? '×' : operation === '/' ? '÷' : operation === 'root' ? '√' : operation || '?';
  document.querySelectorAll('.op-button').forEach(btn => btn.classList.toggle('selected', btn.dataset.op === operation));
}
function renderTiles() {
  const area = $('tiles'); area.replaceChildren();
  if (!tiles.length) {
    // Quiet card backs make the deck visible before the first timed hand.
    for (let i = 0; i < 4; i++) {
      const back = document.createElement('div');
      back.className = 'card-back'; back.setAttribute('aria-hidden', 'true');
      back.innerHTML = '<span class="card-back-pattern">✦</span>';
      area.append(back);
    }
  }
  for (const tile of tiles) {
    const el = document.createElement('button'); el.type = 'button';
    el.className = 'number-tile'; el.dataset.tileId = String(tile.id); el.title = tile.text;
    const original = tile.id < 4 ? cards[tile.id] : null;
    const isUncombinedAce = original?.rank === 'A';
    if (original) {
      // Card faces always show the printed rank, not the value used in arithmetic.
      // J/Q/K all calculate as 10; A can calculate as 1 or 11.
      el.classList.add('playing-card');
      if (['♥', '♦'].includes(original.suit)) el.classList.add('red');
      const corner = (position) => {
        const span = document.createElement('span');
        span.className = `card-corner ${position}`;
        const rank = document.createElement('span'); rank.className = 'card-rank'; rank.textContent = original.rank;
        const suit = document.createElement('span'); suit.className = 'corner-suit'; suit.textContent = original.suit;
        span.append(rank, suit);
        return span;
      };
      const pip = document.createElement('span'); pip.className = 'card-pip';
      pip.textContent = original.suit; pip.setAttribute('aria-hidden', 'true');
      el.append(corner('top'), pip, corner('bottom'));
      const suitName = ({'♠':'spades','♥':'hearts','♦':'diamonds','♣':'clubs'})[original.suit] || original.suit;
      el.setAttribute('aria-label', `${original.rank} of ${suitName}, worth ${formatR(tile.value)}`);
    } else {
      // Only intermediate results show a numerical face, centered where the suit was.
      el.classList.add('result-card');
      const number = document.createElement('span');
      number.className = 'result-value'; number.textContent = formatR(tile.value);
      el.append(number);
      el.setAttribute('aria-label', `Combined result: ${formatR(tile.value)}`);
    }
    const wrap = document.createElement('div'); wrap.className = 'tile-wrap'; wrap.append(el);
    if (isUncombinedAce) {
      el.addEventListener('contextmenu', e => { e.preventDefault(); toggleAce(tile.id); });
      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.className = 'ace-switch';
      toggle.textContent = `A = ${formatR(tile.value)} · switch`;
      toggle.setAttribute('aria-label', `Ace currently counts as ${formatR(tile.value)}. Switch to ${tile.value.n === 1n ? '11' : '1'}`);
      toggle.addEventListener('click', () => toggleAce(tile.id));
      wrap.append(toggle);
    }
    el.addEventListener('click', () => pickTile(tile.id));
    attachDrag(el, tile.id);
    area.append(wrap);
  }
  updateSelection();
  $('undoBtn').disabled = !history.length || finished;
  $('clearBtn').disabled = !tiles.length || finished;
  $('revealSolutionBtn').disabled = !running || finished;
}
const operationSymbol = op => op === '*' ? '×' : op === '/' ? '÷' : op === 'root' ? '√ₙ' : op;

function closeQuickOperations() {
  $('quickOperations').classList.add('hidden');
}
function clearInteraction() {
  operation = null;
  closeQuickOperations();
  setSelection();
}
function openQuickOperations(anchor = null) {
  const first = tiles.find(t => t.id === selected.a);
  const second = tiles.find(t => t.id === selected.b);
  if (!first || !second || finished || !running) return;
  const menu = $('quickOperations');
  $('quickEquation').textContent = `${formatR(first.value)}  ?  ${formatR(second.value)}`;
  menu.classList.remove('hidden');
  // Place the picker close to the second card/drop point, within the viewport.
  const secondCard = document.querySelector(`[data-tile-id="${second.id}"]`);
  const bounds = secondCard?.getBoundingClientRect();
  const x = anchor?.x ?? (bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2);
  const y = anchor?.y ?? (bounds ? bounds.bottom : window.innerHeight / 2);
  const size = menu.getBoundingClientRect();
  const margin = 10;
  const left = Math.max(margin, Math.min(x - size.width / 2, window.innerWidth - size.width - margin));
  let top = y + 12;
  if (top + size.height > window.innerHeight - margin) {
    const above = (bounds?.top ?? y) - size.height - 12;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - size.height - margin);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
function chooseOperation(op) {
  if (!running || finished) return;
  // After a pair is selected, any operation executes it immediately.
  if (selected.a !== null && selected.b !== null) operation = op;
  else operation = operation === op ? null : op; // Tap again to deselect.
  closeQuickOperations();
  updateSelection();
  maybeCombine();
}
function renderOperations() {
  const container = $('operations'); container.replaceChildren();
  const quick = $('quickOperationButtons'); quick.replaceChildren();
  for (const op of Object.keys(OPERATIONS)) {
    const label = operationSymbol(op);
    const title = op === 'log' ? 'Log of first, base second' : op === 'root' ? 'Root of first, degree second' : op;
    const el = document.createElement('button'); el.type = 'button';
    el.className = 'op-button'; el.dataset.op = op; el.textContent = label; el.title = title;
    el.addEventListener('click', () => chooseOperation(op));
    container.append(el);
    const small = document.createElement('button'); small.type = 'button';
    small.className = 'quick-op'; small.dataset.op = op; small.textContent = label; small.title = title;
    small.setAttribute('aria-label', `Apply ${title}`);
    let handledTouch = false;
    small.addEventListener('pointerdown', () => { handledTouch = false; });
    small.addEventListener('pointerup', e => {
      if (e.pointerType !== 'touch') return;
      // Act on touch release rather than waiting for Safari's synthesized
      // click; ensure sliding a finger off a button does not activate it.
      if (document.elementFromPoint(e.clientX, e.clientY)?.closest('.quick-op') !== small) return;
      handledTouch = true;
      // We already performed the touch action; ignore its later compat click
      // even if Safari retargets it after the menu disappears.
      ignoreDragClick = true;
      chooseOperation(op);
    });
    small.addEventListener('click', e => {
      if (handledTouch) { handledTouch = false; e.preventDefault(); return; }
      chooseOperation(op); // Mouse, keyboard and assistive technologies.
    });
    quick.append(small);
  }
}
function pickTile(id) {
  if (!running || finished) return;
  if (selected.a === id) setSelection(null, selected.b);
  else if (selected.b === id) setSelection(selected.a, null);
  else if (selected.a === null) setSelection(id, selected.b);
  else if (selected.b === null) setSelection(selected.a, id);
  else setSelection(id, null);
  maybeCombine();
}
function chooseSlot(slot, id) {
  if (!running || finished || !tiles.some(t => t.id === id)) return;
  const other = slot === 'a' ? 'b' : 'a';
  selected[slot] = id;
  if (selected[other] === id) selected[other] = null;
  updateSelection(); maybeCombine();
}
function maybeCombine(anchor = null) {
  if (!running || selected.a === null || selected.b === null || selected.a === selected.b) return;
  const a = tiles.find(t => t.id === selected.a), b = tiles.find(t => t.id === selected.b);
  if (!a || !b) return;
  if (operation === null) {
    openQuickOperations(anchor);
    return;
  }
  const applied = operation;
  try {
    const result = combine(a, applied, b, nextId);
    nextId++;
    history.push(tiles.map(t => ({ ...t })));
    tiles = tiles.filter(t => t.id !== a.id && t.id !== b.id).concat(result);
    clearInteraction(); // Always start the next calculation with no operation selected.
    renderTiles();
    notify(`${a.text} ${applied} ${b.text} = ${formatR(result.value)} · ${tiles.length} tile${tiles.length === 1 ? '' : 's'} remaining`);
    if (tiles.length === 1) {
      if (equalR(tiles[0].value, rational(TARGET))) void completed();
      else notify(`You got ${formatR(tiles[0].value)}, not 24. Tap Undo and try another route.`, 'error');
    }
  } catch (error) {
    operation = null;
    updateSelection();
    openQuickOperations(anchor); // Keep the pair, so an invalid operation is easy to retry.
    notify(error.message || 'Invalid operation. Try a different one.', 'error');
  }
}
function toggleAce(id) {
  if (!running || finished || id >= 4 || cards[id]?.rank !== 'A') return;
  const index = tiles.findIndex(t => t.id === id);
  if (index < 0) return;
  history.push(tiles.map(t => ({ ...t })));
  const next = tiles[index].value.n === 1n ? 11 : 1;
  tiles[index] = leaf(cards[id], id, next);
  renderTiles();
  notify(`Ace is now ${next}.`);
}
// Safari can dispatch a compatibility click after a drag, or after a popup
// touch action already handled on pointerup. Ignore only that trailing click,
// never the user's following tap.
let ignoreDragClick = false;
document.addEventListener('pointerdown', () => { ignoreDragClick = false; }, true);
document.addEventListener('click', e => {
  if (!ignoreDragClick || e.detail === 0) return;
  ignoreDragClick = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

function attachDrag(element, id) {
  let drag = null;
  element.addEventListener('pointerdown', e => {
    if (!running || finished || e.button !== 0 || !e.isPrimary) return;
    drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moving: false, ghost: null };
    element.setPointerCapture(e.pointerId);
  });
  element.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moving && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) {
      drag.moving = true;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'drag-ghost';
      drag.ghost.textContent = formatR(tiles.find(t => t.id === id)?.value || rational(0));
      document.body.append(drag.ghost);
    }
    if (drag.moving) {
      drag.ghost.style.left = `${e.clientX}px`;
      drag.ghost.style.top = `${e.clientY}px`;
    }
  });
  element.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const didDrag = drag.moving;
    drag.ghost?.remove();
    drag = null;
    // Safari sometimes keeps capture until a later event. Release before
    // introducing the popup so its next touch hits the operation button.
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    if (!didDrag) return;
    ignoreDragClick = true;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const slot = target?.closest('[data-slot]')?.dataset.slot;
    const other = target?.closest('[data-tile-id]')?.dataset.tileId;
    if (slot) chooseSlot(slot, id);
    else if (other && Number(other) !== id) {
      const secondId = Number(other);
      setSelection(id, secondId);
      if (e.pointerType === 'touch') {
        // Do not insert an interactive popup during iOS's pointerup/click
        // synthesis. Show it on the next paint, after drag cleanup.
        const position = { x: e.clientX, y: e.clientY };
        requestAnimationFrame(() => {
          if (running && !finished && selected.a === id && selected.b === secondId)
            maybeCombine(position);
        });
      } else {
        maybeCombine({ x: e.clientX, y: e.clientY });
      }
    }
  });
  element.addEventListener('pointercancel', e => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.ghost?.remove();
    drag = null;
  });
}
for (const zone of document.querySelectorAll('[data-slot]')) {
  zone.addEventListener('click', () => {
    if (!running) return;
    if (zone.dataset.slot === 'a' && selected.b !== null) setSelection(selected.b, null);
    else if (zone.dataset.slot === 'b' && selected.a !== null) setSelection(null, selected.a);
  });
}
function updateRecords(key, difficulty, ms) {
  const old = records[key] || { bestMs: Infinity, attempts: 0 };
  records[key] = { bestMs: Math.min(old.bestMs, ms), attempts: (old.attempts || 0) + 1, difficulty, difficultyVersion: DIFFICULTY_VERSION, updatedAt: Date.now() };
  save(); renderStats();
  return ms < old.bestMs;
}
function renderStats() {
  const rows = Object.entries(records).filter(([, r]) => Number.isFinite(r.bestMs));
  const cloudRows = (cloudBest || []).map(r => ({ key: r.hand_key, bestMs: r.best_time_ms, difficulty: r.difficulty, updatedAt: r.updatedAt }));
  // When signed in, family records show only verified runs for the selected
  // family. Local guest scores are never treated as another family's best.
  const merged = new Map(familyMember ? [] : rows.map(([key, r]) => [key, { ...r, key }]));
  for (const r of cloudRows) { const prev = merged.get(r.key); if (!prev || r.bestMs < prev.bestMs) merged.set(r.key, r); }
  $('bestGrid').innerHTML = DIFFICULTIES.map(d => {
    const min = [...merged.values()].filter(r => r.difficulty === d).reduce((m, r) => Math.min(m, r.bestMs), Infinity);
    return `<div class="best-box"><div class="best-name"><span class="tier-dot ${d}"></span>${d}</div><div class="best-time">${Number.isFinite(min) ? escapeHtml((min / 1000).toFixed(2)) : '—'} <span>${Number.isFinite(min) ? 'sec' : ''}</span></div></div>`;
  }).join('');
  $('solvedCount').textContent = `${rows.reduce((n, [, r]) => n + (r.attempts || 0), 0)} hands solved locally`;
  $('recordCount').textContent = `${merged.size} unique combinations ${familyMember ? 'in this family' : 'locally'}`;
  const historyRows = [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
  $('history').innerHTML = historyRows.length ? historyRows.map(r => `<div class="history-row"><span class="history-key">${escapeHtml(r.key)}</span><span class="history-tier">${escapeHtml(r.difficulty)}</span><span class="history-time">${fmt(r.bestMs)}</span></div>`).join('') : '<p class="empty-note">Your fastest results will appear here after your first solved hand.</p>';
}
function showResult(message, ms, status = '') {
  $('result').innerHTML = `<h3>✦ ${escapeHtml(message)}</h3><div class="result-time">${fmt(ms)}</div><p>Hand: <b>${escapeHtml(analysis.key)}</b> · Difficulty: <b>${analysis.difficulty}</b><br>${escapeHtml(tiles[0]?.text || '')}<br>${escapeHtml(status)}</p>`;
  $('result').classList.remove('hidden');
  $('difficultyChip').textContent = analysis.difficulty; $('difficultyChip').classList.remove('hidden'); $('difficultyChip').classList.add('difficulty');
}
async function completed() {
  if (gameMode === 'multi') { await mpCompleted(); return; }
  if (finished || !analysis || !tiles.length) return;
  const check = verifySolution(cards, tiles[0].expr);
  if (!check.valid) { notify('The solution could not be verified. Please undo.', 'error'); return; }
  const ms = stopClock(); finished = true;
  const personalBest = updateRecords(analysis.key, analysis.difficulty, ms);
  notify('24! You solved it. ✨', 'success');
  renderTiles();
  showResult(personalBest ? 'New personal best!' : 'Nicely solved!', ms, cloudEligible ? 'Verifying global submission…' : 'Saved on this device.');
  if (cloudEligible && supabase && cloudChallengeId) {
    try {
      const { data, error } = await supabase.functions.invoke('solo', { body: {
        action: 'submit', familyId: cloudChallengeFamilyId, challengeId: cloudChallengeId, expression: tiles[0].expr,
      } });
      if (error || !data?.ok) throw Error(data?.error || error?.message || 'Submission failed');
      showResult(personalBest ? 'New personal best!' : 'Nicely solved!', ms, `Verified global time: ${fmt(data.timeMs)}${data.newBest ? ' · Global personal best!' : ''}`);
      await Promise.all([loadCloudBests(), loadLeaderboard()]);
    } catch (error) {
      showResult('Solved locally', ms, `Global record not submitted: ${error.message}`);
    }
  }
}
/** Solo-only forfeit: ending a run never writes local or server records. */
function revealSolution() {
  if (gameMode !== 'solo') return;
  if (!running || finished || busy || !analysis || cards.length !== 4) return;
  // The backend returns only a hand classification. Find the exact solution on
  // demand for verified online hands, never by reading the user's partial tiles.
  let proof;
  try {
    proof = analysis.solutionSteps?.length === 3 ? analysis : analyzeHand(cards);
    if (!proof.solvable || proof.solutionSteps?.length !== 3) throw Error('No verified solution for this hand');
  } catch (error) {
    notify(`Could not show a solution: ${error.message}`, 'error');
    return;
  }
  stopClock();
  finished = true;
  // Deliberately discard the client-side challenge: forfeits cannot submit a
  // result, including when the hand came from the online family leaderboard.
  cloudChallengeId = null;
  cloudChallengeFamilyId = null;
  cloudEligible = false;
  history = [];
  clearInteraction();
  tiles = cards.map((card, index) => leaf(card, index));
  renderTiles();
  $('solutionSteps').replaceChildren();
  for (const step of proof.solutionSteps) {
    const item = document.createElement('li');
    item.textContent = step;
    $('solutionSteps').append(item);
  }
  const notes = [];
  if (proof.solutionAceValues.length) {
    notes.push(`Ace ${proof.solutionAceValues.length > 1 ? 'values' : 'value'} in this solution: ${proof.solutionAceValues.join(', ')}.`);
  }
  if (cards.some(card => ['J', 'Q', 'K'].includes(card.rank))) notes.push('J, Q and K each count as 10.');
  $('solutionNotes').textContent = notes.join(' ');
  $('solutionNotes').classList.toggle('hidden', !notes.length);
  $('solutionReveal').classList.remove('hidden');
  $('difficultyChip').textContent = analysis.difficulty;
  $('difficultyChip').classList.remove('hidden');
  $('difficultyChip').classList.add('difficulty');
  notify('You gave up this round. No time or record was saved.', '');
}

async function newHand() {
  if (gameMode !== 'solo' || busy) return;
  busy = true; $('newHandBtn').disabled = true;
  $('revealSolutionBtn').disabled = true;
  stopClock();
  $('result').classList.add('hidden'); $('solutionReveal').classList.add('hidden'); $('difficultyChip').classList.add('hidden');
  $('expertNotice').classList.add('hidden');
  notify('Preparing a solvable hand…');
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    cloudChallengeId = null; cloudChallengeFamilyId = null; cloudEligible = false;
    let newCards = null, report = null;
    if (user && supabase && familyMember && selectedFamilyId) {
      try {
        const challengeFamily = selectedFamilyId;
        const { data, error } = await supabase.functions.invoke('solo', { body: { action: 'start', familyId: challengeFamily } });
        if (error || !data?.cards || !data?.challengeId) throw Error(error?.message || 'Could not begin verified run');
        // Reject an out-of-date Edge Function rather than mixing old labels
        // with v2 personal bests and leaderboard categories.
        const checkedReport = analyzeHand(data.cards);
        if (!checkedReport.solvable || checkedReport.key !== data.handKey || checkedReport.difficulty !== data.difficulty)
          throw Error('Server difficulty version differs; deploy the updated solo function');
        newCards = data.cards; report = checkedReport;
        cloudChallengeId = data.challengeId;
        cloudChallengeFamilyId = challengeFamily; cloudEligible = true;
      } catch (error) {
        newCards = null; cloudChallengeId = null; cloudChallengeFamilyId = null; cloudEligible = false;
        notify(`Online run unavailable (${error.message}). Playing locally instead.`, 'error');
      }
    }
    if (!newCards) {
      for (let i = 0; i < 60; i++) {
        newCards = drawHand(); report = analyzeHand(newCards);
        if (report.solvable) break;
      }
      if (!report?.solvable) { newCards = [{ rank: 'A', suit: '♠' }, { rank: '3', suit: '♥' }, { rank: '8', suit: '♦' }, { rank: '2', suit: '♣' }]; report = analyzeHand(newCards); }
    }
    cards = newCards; analysis = report; nextId = 4;
    $('expertNotice').classList.toggle('hidden', report.difficulty !== 'Expert');
    tiles = cards.map((card, index) => leaf(card, index)); history = [];
    clearInteraction();
    round++;
    $('roundText').textContent = `Round ${String(round).padStart(2, '0')}`;
    $('handKeyChip').textContent = canonicalKey(cards);
    finished = false;
    renderTiles();
    notify(cloudEligible ? 'Verified time trial: solve the hand as fast as you can!' : 'Clock is running! Combine all four cards into 24.');
    beginClock();
    $('revealSolutionBtn').disabled = false;
  } catch (error) { notify(`Could not start a hand: ${error.message}`, 'error'); }
  finally { busy = false; $('newHandBtn').disabled = false; }
}
function undo() {
  if (!running || !history.length || finished) return;
  tiles = history.pop(); clearInteraction(); renderTiles(); notify('Last step undone.');
}
function changeDifficulty(d) { selectedDifficulty = d; renderLeaderTabs(); void loadLeaderboard(); }
function renderLeaderTabs() {
  $('leaderTabs').innerHTML = DIFFICULTIES.map(d => `<button type="button" class="leader-tab ${selectedDifficulty === d ? 'selected' : ''}" data-difficulty="${d}">${d}</button>`).join('');
  $('leaderTabs').querySelectorAll('button').forEach(button => button.addEventListener('click', () => changeDifficulty(button.dataset.difficulty)));
}
async function invoke(name, payload) {
  if (!supabase) throw new Error('Online play isn’t available yet.');
  const { data, error } = await supabase.functions.invoke(name, { body: payload });
  if (error) {
    let reason = error.message || 'Request failed';
    try { reason = (await error.context?.json())?.error || reason; } catch { /* no JSON */ }
    throw new Error(reason);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function loadLeaderboard() {
  if (!supabase || !user || !familyMember || !selectedFamilyId) {
    $('leaderboard').innerHTML = '<div class="empty-note">Join your family to see its private rankings. Solo guest play works without an account.</div>';
    return;
  }
  const category = selectedDifficulty;
  const familyId = selectedFamilyId;
  $('leaderboard').innerHTML = '<div class="empty-note">Loading leaderboard…</div>';
  try {
    const { rows = [] } = await invoke('solo', { action: 'leaderboard', difficulty: category, familyId });
    if (selectedDifficulty !== category || selectedFamilyId !== familyId) return;
    $('leaderboard').innerHTML = rows.length
      ? rows.map((r, i) => `<div class="leader-row"><span class="leader-rank">${String(i + 1).padStart(2, '0')}</span><span class="leader-name">${escapeHtml(r.display_name)}</span><span class="leader-ms">${fmt(r.best_time_ms)}</span></div>`).join('')
      : '<div class="empty-note">No verified records yet. Claim the first spot!</div>';
  } catch (error) {
    $('leaderboard').innerHTML = `<div class="empty-note">Unable to fetch rankings: ${escapeHtml(error.message)}</div>`;
  }
}
async function loadCloudBests() {
  if (!supabase || !user || !familyMember || !selectedFamilyId) { cloudBest = []; renderStats(); return; }
  try {
    const familyId = selectedFamilyId;
    const { records: list = [] } = await invoke('solo', { action: 'bests', familyId });
    if (selectedFamilyId !== familyId) return;
    cloudBest = list.map(r => ({ hand_key: r.hand_key, difficulty: r.difficulty, best_time_ms: r.best_time_ms, updatedAt: Date.parse(r.updated_at || '') || 0 }));
  } catch (error) { cloudBest = []; console.warn('Could not read cloud records:', error.message); }
  renderStats();
}
async function connectCloud() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    $('onlinePill').textContent = 'Guest mode';
    return;
  }
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabase = createClient(config.supabaseUrl, config.supabaseKey);
    const { data: { session } } = await supabase.auth.getSession();
    await setUser(session?.user || null);
    supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => void setUser(session?.user || null), 0); });
    await loadLeaderboard();
  } catch (error) { notify('Online rankings are unavailable right now.', 'error'); }
}
async function setUser(nextUser, preferredFamilyId = null) {
  user = nextUser;
  let current = [];
  if (user && supabase) {
    try {
      const status = await invoke('family', { action: 'status' });
      current = status.memberships || [];
    } catch (error) { $('authMessage').textContent = error.message; }
  }
  memberships = current;
  const validIds = new Set(memberships.map(m => m.familyId));
  let stored = null;
  try { stored = localStorage.getItem(familyStorageKey); } catch { /* optional */ }
  selectedFamilyId = [preferredFamilyId, selectedFamilyId, stored, memberships[0]?.familyId]
    .find(id => validIds.has(id)) || null;
  familyMember = !!selectedFamilyId;
  if (selectedFamilyId) {
    try { localStorage.setItem(familyStorageKey, selectedFamilyId); } catch { /* optional */ }
  }
  const currentFamily = memberships.find(m => m.familyId === selectedFamilyId);
  familyName = currentFamily?.familyName || null;
  const nickname = currentFamily?.nickname || null;

  $('accountBtn').textContent = familyMember ? nickname : 'Join family';
  $('onlinePill').classList.toggle('connected', familyMember);
  $('onlinePill').innerHTML = `<span class="status-dot"></span>${familyMember ? 'Family connected' : 'Guest mode'}`;
  $('familyPicker').classList.toggle('hidden', !familyMember);
  $('familySelect').replaceChildren();
  for (const membership of memberships) {
    const option = document.createElement('option');
    option.value = membership.familyId;
    option.textContent = membership.familyName;
    $('familySelect').append(option);
  }
  if (selectedFamilyId) $('familySelect').value = selectedFamilyId;
  $('joinHeading').textContent = familyMember ? 'Join another family' : 'Join a family';
  // Joining another group does not require creating a second player identity.
  $('accountFields').classList.remove('hidden');
  $('recoverFields').classList.toggle('hidden', familyMember);
  $('signedInFields').classList.toggle('hidden', !familyMember);
  $('nameInput').value = nickname || '';
  $('recordSource').textContent = familyMember ? 'Verified in this family' : 'Saved on this device';
  $('accountStatus').textContent = familyMember
    ? `Playing as ${nickname} in ${familyName}. You belong to ${memberships.length} ${memberships.length === 1 ? 'family' : 'families'}.`
    : '';
  cloudBest = [];
  renderStats();
  await Promise.all([loadCloudBests(), loadLeaderboard()]);
}
function selectFamily(familyId) {
  if (!memberships.some(m => m.familyId === familyId) || familyId === selectedFamilyId) return;
  selectedFamilyId = familyId;
  try { localStorage.setItem(familyStorageKey, familyId); } catch { /* optional */ }
  // A previously started hand remains linked to its original family. Do not
  // silently submit it to the newly selected family's leaderboard.
  void setUser(user, familyId);
  notify('Family switched. Deal new cards to start a time trial for this family.');
}
async function ensureAnonymousSession() {
  if (!supabase) throw new Error('Online play isn’t available yet.');
  const { data: { session } } = await supabase.auth.getSession();
  if (session) { user = session.user; return; }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data?.user) throw new Error(error?.message || 'Could not create anonymous session');
  user = data.user;
}
function showKey(label, description, key) {
  $('keyTitle').textContent = label;
  $('keyDescription').textContent = description;
  $('keyValue').textContent = key;
  $('keyResult').classList.remove('hidden');
}
async function familyAction(action, payload, buttonId, successText) {
  const button = $(buttonId);
  button.disabled = true;
  $('authMessage').textContent = '';
  try {
    await ensureAnonymousSession();
    const result = await invoke('family', { action, ...payload });
    if (result.inviteCode && result.adminKey) showKey('SAVE BOTH FAMILY KEYS',
      `Keys for ${result.familyName || 'your new family'}. Share FAM with members; keep ADM private. Both are shown only now.`,
      `Family invitation: ${result.inviteCode}\nFamily admin key: ${result.adminKey}`);
    else if (result.recoveryKey) showKey('SAVE YOUR PERSONAL RECOVERY KEY',
      'Copy this somewhere private. It restores your nickname and records if you lose browser data. It is shown only now.', result.recoveryKey);
    else if (result.inviteCode) showKey('NEW FAMILY INVITATION CODE',
      `New invitation for ${result.familyName || 'this family'}. Old codes stop working; existing records are unchanged.`, result.inviteCode);
    else if (result.adminKey) showKey('SAVE THE FAMILY ADMIN RECOVERY KEY',
      `New admin key for ${result.familyName || 'this family'}. Save it privately; the previous admin key is invalid.`, result.adminKey);
    $('authMessage').textContent = successText;
    if (['join','recover','rename'].includes(action)) await setUser(user, result.familyId || selectedFamilyId);
    if (action === 'bootstrap') { $('setupSecretInput').value = ''; $('familyNameInput').value = ''; }
    if (action === 'rotate-invite') $('adminKeyInput').value = '';
    if (action === 'rotate-admin') $('adminKeyInput').value = '';
  } catch (error) {
    $('authMessage').textContent = error.message;
  } finally { button.disabled = false; }
}
function applyTheme(theme) {
  const active = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = active;
  $('themeBtn').textContent = active === 'light' ? '☾ Dark' : '☀ Light';
  $('themeBtn').setAttribute('aria-label', `Switch to ${active === 'light' ? 'dark' : 'light'} mode`);
  $('themeMeta').content = active === 'light' ? '#f6f4ea' : '#1a2422';
  try { localStorage.setItem('24race-theme', active); } catch { /* storage optional */ }
}
function initialTheme() {
  let stored;
  try { stored = localStorage.getItem('24race-theme'); } catch { /* storage unavailable */ }
  applyTheme(stored === 'dark' ? 'dark' : 'light');
}

/* Multiplayer is a separate server-controlled match lifecycle. It reuses the
   same exact card/drag engine but NEVER updates Solo records or enables Reveal. */
const mpStorageKey = () => `race24-mp-room-${selectedFamilyId || 'none'}`;
const mpLiveNow = () => Date.now() + mpOffsetMs;
function mpSay(message, error = false) {
  $('mpMessage').textContent = message;
  $('mpMessage').classList.toggle('error', error);
}
function mpUseRoom(id) {
  mpRoomId = id;
  try {
    if (id) localStorage.setItem(mpStorageKey(), id);
    else localStorage.removeItem(mpStorageKey());
  } catch { /* private browsing may disable storage */ }
}
function mpHideRound() {
  mpRoundId = null; mpHandLoaded = false; mpSubmitting = false; mpPendingExpression = null;
  running = false; finished = true; cards = []; tiles = []; history = []; analysis = null;
  clearInteraction(); renderTiles();
  $('expertNotice').classList.add('hidden');
  $('difficultyChip').classList.add('hidden');
  $('result').classList.add('hidden');
  $('solutionReveal').classList.add('hidden');
  $('handKeyChip').textContent = 'Waiting for a round';
  $('timer').textContent = '01:30';
}
function mpSwitchMode(mode) {
  if (mode === 'solo' && gameMode === 'multi' && mpSnapshot?.room.status === 'playing') {
    mpSay('Stay in the multiplayer room until this round ends.', true); return;
  }
  if (gameMode === mode) return;
  if (mode === 'multi') {
    // If a Solo clock was running, leave that run without a record.
    stopClock(); finished = true; running = false;
    gameMode = 'multi';
    document.body.classList.add('mp-active');
    $('mpPanel').classList.remove('hidden');
    $('multiSoon').classList.add('active'); $('soloTab').classList.remove('active');
    $('playKicker').textContent = 'MULTIPLAYER // LIVE RACE';
    $('timerLabel').textContent = 'TIME LEFT';
    mpHideRound();
    mpSay(familyMember ? 'Create a room or join with an R24 code.' : 'Join a family using the top-right button to play together.');
    clearInterval(mpTickInterval); mpTickInterval = setInterval(mpTick, 100);
    clearInterval(mpPollInterval); mpPollInterval = setInterval(() => void mpRefresh(), 1200);
    if (mpRoomId) void mpRefresh();
    else if (familyMember) {
      let stored = null;
      try { stored = localStorage.getItem(mpStorageKey()); } catch { /* optional */ }
      if (stored) { mpRoomId = stored; void mpRefresh(); }
    }
  } else {
    gameMode = 'solo';
    clearInterval(mpTickInterval); clearInterval(mpPollInterval);
    mpTickInterval = null; mpPollInterval = null;
    document.body.classList.remove('mp-active');
    $('mpPanel').classList.add('hidden');
    $('multiSoon').classList.remove('active'); $('soloTab').classList.add('active');
    $('playKicker').textContent = 'SOLO // TIME TRIAL';
    $('timerLabel').textContent = 'YOUR TIME';
    mpHideRound();
    $('timer').textContent = '00:00.0';
    $('banner').textContent = 'Press Deal cards to start a Solo time trial.';
  }
  mpRender();
}
async function mpRequest(action, extra = {}) {
  if (!supabase || !user || !familyMember) throw Error('Connect to Supabase and join a family first.');
  const start = Date.now();
  const payload = { action, ...extra };
  if (mpRoomId && !payload.roomId) payload.roomId = mpRoomId;
  const data = await invoke('multiplayer', payload);
  if (data.serverTime) mpOffsetMs = Date.parse(data.serverTime) - (start + Date.now()) / 2;
  return data;
}
async function mpCreate() {
  if (mpActionBusy || mpRoomId) return;
  mpActionBusy = true; $('mpCreateBtn').disabled = true;
  try {
    const state = await mpRequest('create', {
      familyId: selectedFamilyId, mode: $('mpMode').value, difficulty: $('mpDifficulty').value,
      seconds: Number($('mpSeconds').value), grace: Number($('mpGrace').value), rounds: Number($('mpRounds').value),
    });
    mpUseRoom(state.room.id); mpApply(state); mpSay('Room created. Share the code and wait for everyone to press Ready.');
  } catch (error) { mpSay(error.message, true); }
  finally { mpActionBusy = false; $('mpCreateBtn').disabled = false; }
}
async function mpJoin() {
  if (mpActionBusy || mpRoomId) return;
  mpActionBusy = true; $('mpJoinBtn').disabled = true;
  try {
    const state = await mpRequest('join', { code: $('mpCodeInput').value.trim().toUpperCase() });
    mpUseRoom(state.room.id); mpApply(state); mpSay('Joined! Press Ready when you are prepared to play.');
  } catch (error) { mpSay(error.message, true); }
  finally { mpActionBusy = false; $('mpJoinBtn').disabled = false; }
}
async function mpDo(action, extra = {}) {
  if (!mpRoomId || mpActionBusy) return;
  mpActionBusy = true;
  for (const id of ['mpReadyBtn','mpStartBtn','mpLeaveBtn']) $(id).disabled = true;
  try {
    const state = await mpRequest(action, extra);
    mpApply(state);
    mpSay(action === 'start' ? 'Round starting. Good luck!' : action === 'rematch' ? 'Rematch lobby is open.' : 'Room updated.');
  } catch (error) { mpSay(error.message, true); }
  finally { mpActionBusy = false; mpRender(); }
}
async function mpLeave() {
  if (!mpRoomId || mpActionBusy || mpSnapshot?.room.status === 'playing') return;
  mpActionBusy = true;
  try {
    await mpRequest('leave');
    mpUseRoom(null); mpSnapshot = null; mpHideRound(); mpRender();
    mpSay('Left room. You can create or join another one.');
  } catch (error) { mpSay(error.message, true); }
  finally { mpActionBusy = false; mpRender(); }
}
async function mpRefresh() {
  if (!mpRoomId || mpFetching || gameMode !== 'multi' || mpActionBusy) return;
  mpFetching = true;
  const expectedRoom = mpRoomId;
  try {
    const state = await mpRequest('status');
    if (mpRoomId === expectedRoom && gameMode === 'multi') mpApply(state);
  } catch (error) {
    if (mpRoomId === expectedRoom) {
      if (/room unavailable|room not found|not a member of this room/i.test(error.message)) {
        mpUseRoom(null); mpSnapshot = null; mpHideRound(); mpRender();
        mpSay('This room is no longer available. Create or join another room.', true);
      } else mpSay(`Connection problem: ${error.message}`, true);
    }
  } finally { mpFetching = false; }
}
function mpApply(state) {
  if (!state?.room || !state.players || state.room.id !== mpRoomId) return;
  const previousRound = mpRoundId;
  mpSnapshot = state;
  const rd = state.round;
  if (!rd || rd.id !== previousRound) {
    mpHideRound();
    mpRoundId = rd?.id || null;
    mpLastCountdown = null;
  }
  if (rd?.cards && !mpHandLoaded && gameMode === 'multi') {
    cards = rd.cards;
    analysis = analyzeHand(cards);
    tiles = cards.map((card, index) => leaf(card, index)); nextId = 4; history = [];
    mpHandLoaded = true;
    clearInteraction();
    $('handKeyChip').textContent = rd.handKey;
    $('difficultyChip').textContent = rd.difficulty;
    $('difficultyChip').classList.remove('hidden');
    $('expertNotice').classList.toggle('hidden', rd.difficulty !== 'Expert');
    $('roundText').textContent = `Round ${String(rd.number).padStart(2, '0')}`;
    $('solutionReveal').classList.add('hidden'); $('result').classList.add('hidden');
    finished = state.room.status === 'results' || !!rd.yourFinish;
    running = !finished;
    renderTiles();
    notify(running ? 'Race is on! Combine all four cards into 24.' : 'Round finished.');
  }
  if (rd?.yourFinish && !mpSubmitting) {
    mpPendingExpression = null;
    if (running || !finished) { running = false; finished = true; renderTiles(); }
    notify(`Finished in place #${rd.yourFinish.place} (+${rd.yourFinish.points} pts)!`, 'success');
  }
  if (state.room.status === 'results') {
    if (running || !finished) { running = false; finished = true; renderTiles(); }
    if (!rd?.yourFinish) notify('Round ended. Wait for the next hand.', '');
    mpSay(state.room.roundNumber === state.room.maxRounds ? 'Match finished! Start a rematch or leave the room.' : 'Round finished. Host can start the next round.');
  }
  mpRender(); mpTick();
}
function mpRender() {
  if (gameMode !== 'multi') return;
  const state = mpSnapshot, room = state?.room, rd = state?.round;
  $('mpSetup').classList.toggle('hidden', !!room);
  $('mpRoom').classList.toggle('hidden', !room);
  if (!room) return;
  const isHost = room.hostId === state.you;
  const mine = state.players.find(p => p.isYou);
  const ready = state.players.filter(p => p.ready).length;
  $('mpRoomCode').textContent = room.code;
  $('mpRoomDetails').textContent = `${room.mode === 'first' ? 'First Wins' : 'Everyone Finishes'} · ${room.difficulty} · ${room.seconds}s / round · ${room.maxRounds} rounds${room.mode === 'everyone' && room.grace ? ` · ${room.grace}s grace` : ''}`;
  $('mpPhase').textContent = room.status === 'lobby' ? `${ready}/${state.players.length} ready` : room.status === 'playing' ? `Round ${room.roundNumber} / ${room.maxRounds}` : `Round ${room.roundNumber} complete`;
  const placements = new Map((rd?.finishes || []).map(f => [f.playerId, f]));
  $('mpPlayers').innerHTML = [...state.players].sort((a,b) => b.score - a.score || a.nickname.localeCompare(b.nickname)).map(p => {
    const f = placements.get(p.id);
    const label = room.status === 'lobby' ? (p.ready ? '✓ Ready' : 'Waiting') : f ? `✓ Finished #${f.place}${room.status==='results' ? ` · ${fmt(f.timeMs)}` : ''}` : room.status === 'results' ? 'Not finished' : 'Solving…';
    const kick = isHost && !p.isYou && room.status !== 'playing'
      ? `<button class="mp-kick" data-mp-kick="${p.id}" type="button" aria-label="Remove ${escapeHtml(p.nickname)}">Remove</button>` : '';
    return `<div class="mp-player"><div class="mp-player-top"><span>${escapeHtml(p.nickname)}${p.isYou ? ' (you)' : ''}${p.isHost ? ' ★' : ''}</span><span>${p.score} pts</span></div><div class="mp-player-label">${escapeHtml(label)} ${kick}</div></div>`;
  }).join('');
  $('mpReadyBtn').classList.toggle('hidden', room.status !== 'lobby');
  $('mpReadyBtn').textContent = mine?.ready ? 'Not ready' : "I'm ready";
  $('mpReadyBtn').disabled = mpActionBusy;
  $('mpStartBtn').classList.toggle('hidden', !isHost || (room.status !== 'lobby' && room.status !== 'results'));
  const rematch = room.status === 'results' && room.roundNumber >= room.maxRounds;
  $('mpStartBtn').textContent = rematch ? 'New match ↻' : room.status === 'results' ? 'Next round ↗' : 'Start match ↗';
  $('mpStartBtn').disabled = mpActionBusy || (room.status === 'lobby' && (state.players.length < 2 || ready !== state.players.length));
  $('mpLeaveBtn').disabled = mpActionBusy || room.status === 'playing';
  $('mpRoundResults').classList.toggle('hidden', room.status !== 'results');
  if (room.status === 'results') {
    const standings = [...state.players].sort((a,b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
    const finishNames = new Map(state.players.map(p => [p.id, p.nickname]));
    const solved = (rd?.finishes || []).map(f => `${f.place}. ${escapeHtml(finishNames.get(f.playerId) || 'Player')} (+${f.points} pts)`);
    const steps = (rd?.solutionSteps || []).map(step => `<li>${escapeHtml(step)}</li>`).join('');
    $('mpRoundResults').innerHTML = `<h3>${room.roundNumber === room.maxRounds ? 'Match complete! 🏆' : 'Round complete'}</h3>
      <p>${solved.length ? solved.join(' · ') : 'Nobody solved this round.'}</p>
      ${room.roundNumber === room.maxRounds ? `<p><b>Winner: ${escapeHtml(standings[0]?.nickname || '—')}</b> · ${standings[0]?.score || 0} points</p>` : ''}
      <details><summary>Show one solution</summary><ol>${steps}</ol></details>`;
  }
}
function mpTick() {
  if (gameMode !== 'multi') return;
  const rd = mpSnapshot?.round, room = mpSnapshot?.room;
  if (!rd || !room) { $('timer').textContent = '--:--'; return; }
  if (room.status === 'results') { $('timer').textContent = '00:00'; return; }
  const current = mpLiveNow();
  const left = Date.parse(rd.endsAt) - current;
  const until = Date.parse(rd.startsAt) - current;
  if (until > 0) {
    const text = `START ${Math.ceil(until/1000)}`;
    if ($('timer').textContent !== text) $('timer').textContent = text;
  } else {
    const seconds = Math.max(0, Math.ceil(left / 1000));
    const display = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    if ($('timer').textContent !== display) $('timer').textContent = display;
    if (left > 0 && mpHandLoaded && !mpSnapshot.round.yourFinish && !mpSubmitting && !finished && !running) {
      running = true; renderTiles(); notify('Race is on! Make 24.');
    }
    if (left <= 0 && running) { running = false; finished = true; renderTiles(); notify('Time is up. Waiting for official results.'); }
  }
}
async function mpCompleted() {
  if (mpSubmitting || !mpSnapshot?.round || !mpHandLoaded || !tiles[0]) return;
  if (!verifySolution(cards, tiles[0].expr).valid) { notify('Invalid solution. Please undo.', 'error'); return; }
  mpPendingExpression = tiles[0].expr;
  mpSubmitting = true; running = false; finished = true; renderTiles();
  notify('24! Submitting to the server…');
  try {
    const state = await mpRequest('submit', { roundId: mpSnapshot.round.id, expression: mpPendingExpression });
    mpPendingExpression = null;
    mpApply(state.state);
    notify(`Verified! Place #${state.finish.place} · +${state.finish.points} points.`, 'success');
  } catch (error) {
    // An interrupted request may already have been accepted by the server.
    // Refresh first so a retry never awards a second finish.
    mpSay(`Submission: ${error.message}`, true);
    await mpRefresh();
    if (!mpSnapshot?.round?.yourFinish && mpSnapshot?.room.status === 'playing') {
      running = true; finished = false; renderTiles();
      notify(`Submission failed: ${error.message}. Tap the 24 tile to retry.`, 'error');
      // A user can tap the finished 24 tile to retry without recomputing.
      if (tiles.length === 1 && mpPendingExpression) {
        const tile = document.querySelector('.number-tile');
        tile?.addEventListener('click', () => { if (!mpSubmitting) void mpCompleted(); }, { once: true });
      }
    }
  } finally { mpSubmitting = false; mpTick(); }
}

function wire() {
  $('newHandBtn').addEventListener('click', newHand);
  $('revealSolutionBtn').addEventListener('click', revealSolution);
  $('undoBtn').addEventListener('click', undo);
  $('clearBtn').addEventListener('click', () => { clearInteraction(); notify('Selection cleared.'); });
  $('closeQuickBtn').addEventListener('click', clearInteraction);

  $('swapQuickBtn').addEventListener('click', () => {
    if (selected.a === null || selected.b === null) return;
    // Reverse the operands
    [selected.a, selected.b] = [selected.b, selected.a];
    updateSelection();
    // Update only the equation, not the popup position
    const a = tiles.find(t => t.id === selected.a);
    const b = tiles.find(t => t.id === selected.b);
    $('quickEquation').textContent =
      `${formatR(a.value)}  ?  ${formatR(b.value)}`;
  });
  
  $('soloTab').addEventListener('click', () => mpSwitchMode('solo'));
  $('multiSoon').addEventListener('click', () => void mpSwitchMode('multi'));
  $('mpCreateBtn').addEventListener('click', () => void mpCreate());
  $('mpJoinBtn').addEventListener('click', () => void mpJoin());
  $('mpReadyBtn').addEventListener('click', () => void mpDo('ready', { ready: !mpSnapshot?.players.find(p => p.isYou)?.ready }));
  $('mpStartBtn').addEventListener('click', () => void mpDo(mpSnapshot?.room.status === 'results' && mpSnapshot.room.roundNumber >= mpSnapshot.room.maxRounds ? 'rematch' : 'start'));
  $('mpLeaveBtn').addEventListener('click', () => void mpLeave());
  $('mpPlayers').addEventListener('click', e => {
    const id = e.target.closest('[data-mp-kick]')?.dataset.mpKick;
    if (id && mpSnapshot?.room.status !== 'playing') void mpDo('kick', { targetId: id });
  });
  $('mpCopyBtn').addEventListener('click', async () => {
    if (!mpSnapshot) return;
    try { await navigator.clipboard.writeText(mpSnapshot.room.code); $('mpMessage').textContent = 'Room code copied!'; }
    catch { $('mpMessage').textContent = `Share this room code: ${mpSnapshot.room.code}`; }
  });
  $('themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('accountBtn').addEventListener('click', () => $('accountDialog').showModal());
  $('familySelect').addEventListener('change', e => selectFamily(e.target.value));
  $('closeAccountBtn').addEventListener('click', () => $('accountDialog').close());
  $('familyJoinBtn').addEventListener('click', () => familyAction('join', {
    nickname: $('nicknameInput').value, inviteCode: $('familyCodeInput').value,
  }, 'familyJoinBtn', 'Welcome! Your family is ready to play.'));
  $('recoverBtn').addEventListener('click', () => familyAction('recover', {
    recoveryKey: $('recoverInput').value,
  }, 'recoverBtn', 'Your families and records are restored.'));
  $('saveNameBtn').addEventListener('click', () => familyAction('rename', {
    nickname: $('nameInput').value, familyId: selectedFamilyId,
  }, 'saveNameBtn', 'Nickname updated.'));
  $('newRecoveryBtn').addEventListener('click', () => familyAction('rotate-recovery', {},
    'newRecoveryBtn', 'New recovery key created. Previous key no longer works.'));
  $('setupFamilyBtn').addEventListener('click', () => familyAction('bootstrap', {
    setupSecret: $('setupSecretInput').value, familyName: $('familyNameInput').value,
  }, 'setupFamilyBtn', 'Family created. Save both new keys before closing this window.'));
  $('rotateInviteBtn').addEventListener('click', () => familyAction('rotate-invite', {
    adminKey: $('adminKeyInput').value,
  }, 'rotateInviteBtn', 'Invitation code rotated; this family’s records are unchanged.'));
  $('rotateAdminBtn').addEventListener('click', () => familyAction('rotate-admin', {
    adminKey: $('adminKeyInput').value,
  }, 'rotateAdminBtn', 'Admin key replaced; save the new key.'));
  $('copyKeyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('keyValue').textContent); $('authMessage').textContent = 'Copied! Store this key somewhere private.'; }
    catch { $('authMessage').textContent = 'Please select and manually copy the key above.'; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('accountDialog').open) clearInteraction();
    if (e.key === 'Backspace' && !$('accountDialog').open) { e.preventDefault(); undo(); }
  });
}
initialTheme(); wire(); renderOperations(); renderStats(); renderLeaderTabs(); renderTiles();
void connectCloud();
