import {
  OPERATIONS, DIFFICULTIES, TARGET, drawHand, analyzeHand, canonicalKey,
  cardChoices, leaf, combine, equalR, rational, formatR, verifySolution,
} from './engine.js';
import { config } from './config.js';

const $ = id => document.getElementById(id);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = ms => (ms / 1000).toFixed(2) + 's';
const timerText = ms => { const secs = Math.floor(ms / 1000); return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`; };
const storageKey = '24race-v1-records';
const safeLoad = () => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } };
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
let selectedDifficulty = 'Easy', busy = false, suppressedClick = false;
let raf = 0;

function notify(message, kind = '') { $('banner').textContent = message; $('banner').className = `banner ${kind}`; }
function drawClock() {
  if (running) {
    stoppedMs = Math.max(0, performance.now() - clockStart);
    $('timer').textContent = timerText(stoppedMs);
    raf = requestAnimationFrame(drawClock);
  }
}
function stopClock() { running = false; cancelAnimationFrame(raf); return Math.round(stoppedMs); }
function beginClock() { stoppedMs = 0; clockStart = performance.now(); running = true; cancelAnimationFrame(raf); drawClock(); }
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
    el.addEventListener('click', () => { if (suppressedClick) return; pickTile(tile.id); });
    attachDrag(el, tile.id);
    area.append(wrap);
  }
  updateSelection();
  $('undoBtn').disabled = !history.length || finished;
  $('clearBtn').disabled = !tiles.length;
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
    small.addEventListener('click', () => chooseOperation(op));
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
function attachDrag(element, id) {
  let drag = null;
  element.addEventListener('pointerdown', e => {
    if (!running || finished || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moving: false, ghost: null };
    element.setPointerCapture(e.pointerId);
  });
  element.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moving && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) {
      drag.moving = true; drag.ghost = document.createElement('div'); drag.ghost.className = 'drag-ghost';
      drag.ghost.textContent = formatR(tiles.find(t => t.id === id)?.value || rational(0)); document.body.append(drag.ghost);
    }
    if (drag.moving) { drag.ghost.style.left = `${e.clientX}px`; drag.ghost.style.top = `${e.clientY}px`; }
  });
  element.addEventListener('pointerup', e => {
    if (!drag) return;
    const didDrag = drag.moving; drag.ghost?.remove(); drag = null;
    if (!didDrag) return;
    suppressedClick = true; setTimeout(() => { suppressedClick = false; }, 0);
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const slot = target?.closest('[data-slot]')?.dataset.slot;
    const other = target?.closest('[data-tile-id]')?.dataset.tileId;
    if (slot) chooseSlot(slot, id);
    else if (other && Number(other) !== id) { setSelection(id, Number(other)); maybeCombine({ x: e.clientX, y: e.clientY }); }
  });
  element.addEventListener('pointercancel', () => { drag?.ghost?.remove(); drag = null; });
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
  records[key] = { bestMs: Math.min(old.bestMs, ms), attempts: (old.attempts || 0) + 1, difficulty, updatedAt: Date.now() };
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
async function newHand() {
  if (busy) return;
  busy = true; $('newHandBtn').disabled = true;
  stopClock();
  $('result').classList.add('hidden'); $('difficultyChip').classList.add('hidden');
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
        newCards = data.cards; cloudChallengeId = data.challengeId;
        cloudChallengeFamilyId = challengeFamily; cloudEligible = true;
        report = data.difficulty && data.handKey
          ? { key: data.handKey, difficulty: data.difficulty, score: data.score, solvable: true }
          : analyzeHand(newCards);
      } catch (error) { notify(`Online run unavailable (${error.message}). Playing locally instead.`, 'error'); }
    }
    if (!newCards) {
      for (let i = 0; i < 60; i++) {
        newCards = drawHand(); report = analyzeHand(newCards);
        if (report.solvable) break;
      }
      if (!report?.solvable) { newCards = [{ rank: 'A', suit: '♠' }, { rank: '3', suit: '♥' }, { rank: '8', suit: '♦' }, { rank: '2', suit: '♣' }]; report = analyzeHand(newCards); }
    }
    cards = newCards; analysis = report; nextId = 4;
    tiles = cards.map((card, index) => leaf(card, index)); history = [];
    clearInteraction();
    round++;
    $('roundText').textContent = `Round ${String(round).padStart(2, '0')}`;
    $('handKeyChip').textContent = canonicalKey(cards);
    finished = false;
    renderTiles();
    notify(cloudEligible ? 'Verified time trial: solve the hand as fast as you can!' : 'Clock is running! Combine all four cards into 24.');
    beginClock();
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
function wire() {
  $('newHandBtn').addEventListener('click', newHand);
  $('undoBtn').addEventListener('click', undo);
  $('clearBtn').addEventListener('click', () => { clearInteraction(); notify('Selection cleared.'); });
  $('closeQuickBtn').addEventListener('click', clearInteraction);
  $('swapQuickBtn').addEventListener('click', () => {
    if (selected.a === null || selected.b === null) return;
    [selected.a, selected.b] = [selected.b, selected.a];
    updateSelection();
    openQuickOperations();
  });
  $('multiSoon').addEventListener('click', () => notify('Multiplayer rooms are planned. The exact math engine is already shared.'));
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
