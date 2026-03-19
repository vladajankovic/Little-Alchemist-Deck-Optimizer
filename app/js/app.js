/**
 * app.js  –  Little Alchemist Deck Optimizer  (Web App)
 *
 * All application state, UI bindings and interaction logic.
 */
import {
    comboValue, rankSuggestions, nextSuggestion, totalDeckScore,
    fillDeck, advancedFill, buildKeyLookup, defaultSettings,
} from './engine.js';
import comboData from '../combo_data.json';

// ── State ────────────────────────────────────────────────────────────────────
const STATE = {
    comboDict:    {},          // loaded from combo_data.json
    nameToId:     {},          // card_name → CC_Num (catalog number)
    comboNameToId: {},         // card_name → sequential combo ID (used in scoring)
    cardInfo:     {},          // card_name → { num, rare, cmb_cntr }
    baseCardNames: [],         // sorted unique base card names (for datalist)
    library:      [],          // array of { name, id, level, fused, onyx, quantity }
    deck:         [],          // array of card name strings
    settings:     defaultSettings(),
    leaderboard:  [],          // array of { startCard, score, deck }
    startCard:    '',
};

// Composite card key: distinguishes plain / fused / onyx variants of the same name
function _cardKey(c) { return c.name + '|' + (c.fused ? '1' : '0') + '|' + (c.onyx ? '1' : '0'); }
function _nameFromKey(k) { return k ? k.split('|')[0] : ''; }
function _dispName(c) { return c && c.name ? c.name + (c.onyx ? ' (Onyx)' : '') : ''; }

/** Returns an <img> tag for the card's rarity, or an empty string if unknown. */
function _rarityImg(card) {
    if (!card) return '';
    if (card.onyx) return `<img src="assets/Onyx.png" class="rarity-icon" alt="Onyx" title="Onyx">`;
    const info = STATE.cardInfo[card.name];
    const rare = info ? info.rare : '';
    const map = {
        'Common':   'Bronze_Card.png',
        'Uncommon': 'Silver_Card.png',
        'Rare':     'Gold_Card.png',
        'Onyx':     'Onyx.png',
    };
    const img = map[rare];
    return img ? `<img src="assets/${img}" class="rarity-icon" alt="${esc(rare)}" title="${esc(rare)}">` : '';
}

// UI selection tracking
let _libSelectedKey    = null;   // composite key (name|fused|onyx)
let _deckSelectedIdx   = null;   // 0-based
let _sugSelectedKey    = null;
let _lbSelectedIdx     = null;   // 0-based

// Sort tracking for library
let _libSortCol = 'name';
let _libSortAsc = true;

// Sort tracking for deck
let _deckSortCol = null;
let _deckSortAsc = true;

// Background worker
let _worker        = null;
let _workerCancelled = false;
let _workerRunning = false;

// Confirm dialog callback
let _confirmCallback = null;

// Pending conflict resolution { updated, collisionCard, origKey }
let _conflictPending = null;

// ── Startup ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Restore theme before first paint
    if (localStorage.getItem('la_theme') === 'light') {
        document.body.classList.add('light');
        document.getElementById('theme-toggle-cb').checked = true;
    }
    _bindEvents();
    _loadFromStorage();
});

function _loadFromStorage() {
    // Restore persisted user data (library, settings, deck, leaderboard)
    try {
        const lib = localStorage.getItem('la_library');
        if (lib) STATE.library = JSON.parse(lib);
    } catch { /* ignore */ }
    try {
        const s = localStorage.getItem('la_settings');
        if (s) Object.assign(STATE.settings, JSON.parse(s));
    } catch { /* ignore */ }
    try {
        const d = localStorage.getItem('la_deck');
        if (d) {
            const parsed = JSON.parse(d);
            // Migrate: old format stored composite key strings – discard and rebuild
            if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'string') {
                STATE.deck = [];
            } else {
                STATE.deck = parsed;
            }
        }
    } catch { /* ignore */ }
    try {
        const lb = localStorage.getItem('la_leaderboard');
        if (lb) STATE.leaderboard = JSON.parse(lb);
    } catch { /* ignore */ }
    try {
        STATE.startCard = localStorage.getItem('la_start_card') || '';
    } catch { /* ignore */ }

    // Load combo data from the statically-imported combo_data.json
    const data = comboData;
    if (!data || !data.combos) {
        setStatus('\u26a0 combo_data.json is empty or invalid. Run data_loader.py then rebuild.');
        _toast('combo_data.json missing \u2014 run data_loader.py', 'error');
        return;
    }

    STATE.comboDict     = data.combos;
    STATE.nameToId      = data.name_to_id || {};
    STATE.cardInfo      = data.card_info  || {};
    STATE.comboNameToId = data.combo_name_to_id || {};
    STATE.baseCardNames = data.base_card_names || Object.keys(data.name_to_id || {}).sort();

    // Seed settings / deck / start-card from bundled data if not already persisted
    if (data.settings) Object.assign(STATE.settings, data.settings);
    // Re-apply localStorage settings on top (user overrides)
    try {
        const s = localStorage.getItem('la_settings');
        if (s) Object.assign(STATE.settings, JSON.parse(s));
    } catch { /* ignore */ }
    if (!STATE.startCard && data.start_card) STATE.startCard = data.start_card;

    _enterApp();
}

// ── Event binding ─────────────────────────────────────────────────────────────
function _bindEvents() {

    // ── Theme toggle ──────────────────────────────────────────────────────────
    document.getElementById('theme-toggle-cb').addEventListener('change', e => {
        if (e.target.checked) {
            document.body.classList.add('light');
            localStorage.setItem('la_theme', 'light');
        } else {
            document.body.classList.remove('light');
            localStorage.setItem('la_theme', 'dark');
        }
    });

    // ── Top bar ───────────────────────────────────────────────────────────────
    document.getElementById('btn-settings').addEventListener('click', _openSettings);
    document.getElementById('btn-reload-data').addEventListener('click', () => {
        STATE.comboDict = {};
        STATE.library = [];
        _loadFromStorage();
    });

    // ── Library ───────────────────────────────────────────────────────────────
    document.getElementById('lib-search').addEventListener('input', refreshLibrary);
    document.getElementById('btn-lib-add').addEventListener('click', _addCard);
    document.getElementById('btn-lib-edit').addEventListener('click', _editCard);
    document.getElementById('btn-lib-remove').addEventListener('click', _removeCard);
    document.getElementById('btn-lib-to-deck').addEventListener('click', _addSelectedToDeck);
    document.getElementById('btn-save-library').addEventListener('click', _saveLibraryToStorage);
    document.getElementById('btn-export-library').addEventListener('click', _exportLibrary);
    document.getElementById('btn-import-library').addEventListener('click', () => {
        document.getElementById('input-import-library').value = '';
        document.getElementById('input-import-library').click();
    });
    document.getElementById('input-import-library').addEventListener('change', _importLibrary);

    // Library table header sorting
    document.querySelectorAll('#lib-table thead th').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (!col) return;
            if (_libSortCol === col) _libSortAsc = !_libSortAsc;
            else { _libSortCol = col; _libSortAsc = true; }
            refreshLibrary();
        });
    });

    // Deck table header sorting
    document.querySelectorAll('#deck-table thead th').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (!col) return;
            if (_deckSortCol === col) _deckSortAsc = !_deckSortAsc;
            else { _deckSortCol = col; _deckSortAsc = true; }
            _sortDeckBy(_deckSortCol, _deckSortAsc);
        });
    });

    // ── Deck ──────────────────────────────────────────────────────────────────
    document.getElementById('btn-set-start').addEventListener('click', _setStartCard);
    document.getElementById('btn-deck-up').addEventListener('click', _deckUp);
    document.getElementById('btn-deck-down').addEventListener('click', _deckDown);
    document.getElementById('btn-deck-remove').addEventListener('click', _removeFromDeck);
    document.getElementById('btn-fill').addEventListener('click', () => _runAlgorithm('fill'));
    document.getElementById('btn-advanced-fill').addEventListener('click', () => _runAlgorithm('advanced'));
    document.getElementById('btn-try-all').addEventListener('click', () => _runAlgorithm('try_all'));
    document.getElementById('btn-to-leaderboard').addEventListener('click', _copyToLeaderboard);
    document.getElementById('btn-export-deck').addEventListener('click', _exportDeck);
    document.getElementById('btn-clear-deck').addEventListener('click', () => {
        _confirm('Clear Deck', 'Clear all cards from the deck?', () => {
            STATE.deck = [];
            _refreshAll();
        });
    });

    // ── Suggestions ───────────────────────────────────────────────────────────
    document.getElementById('btn-add-best').addEventListener('click', _addBestSuggestion);

    // ── Bottom tabs ────────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + tab).classList.add('active');
        });
    });

    // ── Leaderboard ────────────────────────────────────────────────────────────
    document.getElementById('btn-lb-load').addEventListener('click', _loadLbDeck);
    document.getElementById('btn-lb-clear').addEventListener('click', () => {
        _confirm('Clear Leaderboard', 'Clear all leaderboard entries?', () => {
            STATE.leaderboard = [];
            refreshLeaderboard();
        });
    });
    document.getElementById('btn-lb-save').addEventListener('click', _saveLeaderboardToStorage);
    document.getElementById('btn-lb-export').addEventListener('click', _exportLeaderboard);
    document.getElementById('btn-lb-import').addEventListener('click', () => {
        document.getElementById('input-lb-import').value = '';
        document.getElementById('input-lb-import').click();
    });
    document.getElementById('input-lb-import').addEventListener('change', _importLeaderboard);

    // ── Status bar ─────────────────────────────────────────────────────────────
    document.getElementById('btn-cancel').addEventListener('click', _cancelWorker);

    // ── Modals ─────────────────────────────────────────────────────────────────
    document.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', () => _closeModal(el.dataset.close));
    });
    document.getElementById('modal-overlay').addEventListener('click', _closeAllModals);

    // Settings save
    document.getElementById('btn-settings-save').addEventListener('click', _saveSettings);

    // Card dialog OK
    document.getElementById('btn-card-ok').addEventListener('click', _cardDialogOk);
    document.getElementById('btn-card-add-another').addEventListener('click', _cardDialogAddAnother);

    // Confirm dialog OK
    document.getElementById('btn-confirm-ok').addEventListener('click', () => {
        _closeModal('modal-confirm');
        if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
    });

    document.getElementById('btn-conflict-keep-edited').addEventListener('click', _conflictKeepEdited);
    document.getElementById('btn-conflict-keep-existing').addEventListener('click', _conflictKeepExisting);

    // Double-click suggestions to add to deck
    document.getElementById('sug-tbody').addEventListener('dblclick', e => {
        const row = e.target.closest('tr');
        if (row && row.dataset.key) {
            _addToDeck(row.dataset.key);
        }
    });

    // Double-click library to edit
    document.getElementById('lib-tbody').addEventListener('dblclick', () => _editCard());

    // Double-click leaderboard to load
    document.getElementById('lb-tbody').addEventListener('dblclick', () => _loadLbDeck());

    // ── Bottom area vertical resize ────────────────────────────────────────────
    const _resizeHandle = document.getElementById('bottom-resize-handle');
    const _appEl        = document.getElementById('app');
    const _BOTTOM_MIN   = 220;
    const _BOTTOM_MAX   = 440;

    _resizeHandle.addEventListener('mousedown', e => {
        e.preventDefault();
        const startY      = e.clientY;
        const startHeight = document.getElementById('bottom-area').getBoundingClientRect().height;
        _resizeHandle.classList.add('dragging');

        const onMove = ev => {
            const delta     = startY - ev.clientY;
            const newHeight = Math.min(_BOTTOM_MAX, Math.max(_BOTTOM_MIN, startHeight + delta));
            _appEl.style.gridTemplateRows = `52px 1fr 5px ${newHeight}px 36px`;
        };
        const onUp = () => {
            _resizeHandle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

// ── Data loading ──────────────────────────────────────────────────────────────

function _onComboFileChosen(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = evt => {
        try {
            const data = JSON.parse(evt.target.result);
            if (!data.combos || typeof data.combos !== 'object') {
                throw new Error('Missing "combos" key — is this a combo_data.json file?');
            }
            STATE.comboDict     = data.combos;
            STATE.nameToId      = data.name_to_id || {};
            STATE.cardInfo      = data.card_info  || {};
            STATE.comboNameToId = data.combo_name_to_id || {};
            STATE.baseCardNames = data.base_card_names || Object.keys(data.name_to_id || {}).sort();

            // Persist to sessionStorage for reload within session
            try {
                sessionStorage.setItem('la_combo_data', JSON.stringify({
                    combos:          STATE.comboDict,
                    name_to_id:      STATE.nameToId,
                    card_info:       STATE.cardInfo,
                    combo_name_to_id: STATE.comboNameToId,
                    base_card_names: STATE.baseCardNames,
                }));
            } catch { /* quota exceeded — no biggie */ }

            // Try to load library from data if no library yet
            if (STATE.library.length === 0 && data.library && data.library.length > 0) {
                STATE.library = data.library;
            }
            if (!STATE.startCard && data.start_card) STATE.startCard = data.start_card;
            if (data.settings) Object.assign(STATE.settings, data.settings);

            document.getElementById('load-combo-err').classList.add('hidden');
            document.getElementById('load-lib-row').classList.remove('hidden');
            document.getElementById('load-lib-row').style.display = 'flex';
        } catch (err) {
            const errEl = document.getElementById('load-combo-err');
            errEl.textContent = '✗ ' + err.message;
            errEl.classList.remove('hidden');
        }
    };
    reader.readAsText(file);
}

function _onLibFileChosen(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
        try {
            const lib = JSON.parse(evt.target.result);
            if (!Array.isArray(lib)) throw new Error('library.json must be an array');
            STATE.library = lib;
            _resolveIds();
            _toast('Library imported (' + lib.length + ' cards)', 'success');
        } catch (err) {
            _toast('Library import failed: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

function _enterApp() {
    // On first launch (no saved library) seed with all Common + Uncommon cards
    if (STATE.library.length === 0) {
        const SEED_RARITIES = new Set(['Common', 'Uncommon']);
        for (const [name, info] of Object.entries(STATE.cardInfo)) {
            if (!SEED_RARITIES.has(info.rare) || name.includes(':Onyx')) continue;
            const id = STATE.comboNameToId[name] || STATE.nameToId[name] || 0;
            STATE.library.push({ name, level: 5, fused: false, onyx: false, quantity: 3, id });
        }
        STATE.library.sort((a, b) => a.name.localeCompare(b.name));
        try { localStorage.setItem('la_library', JSON.stringify(STATE.library)); } catch { /* ignore */ }
    }
    _resolveIds();
    _refreshAll();
    setStatus('Loaded ' + Object.keys(STATE.comboDict).length.toLocaleString() + ' combinations  |  ' + STATE.library.length + ' cards in library');
}

function _resolveIds() {
    // Always use the sequential combo ID (not CC_Num) so score lookups work
    for (const card of STATE.library) {
        card.id = STATE.comboNameToId[card.name] || STATE.nameToId[card.name] || 0;
    }
    for (const card of STATE.deck) {
        if (card) card.id = STATE.comboNameToId[card.name] || STATE.nameToId[card.name] || 0;
    }
}

// ── Refresh all panels ────────────────────────────────────────────────────────

function _refreshAll() {
    refreshLibrary();
    refreshDeck();
    refreshSuggestions();
    refreshMatrix();
    refreshScore();
    _refreshStartCardDropdown();
    refreshLeaderboard();
}

// ── Library refresh ───────────────────────────────────────────────────────────

function refreshLibrary() {
    const q = document.getElementById('lib-search').value.trim().toLowerCase();
    let rows = STATE.library.slice();

    if (q) rows = rows.filter(c => c.name.toLowerCase().includes(q));

    // Sort
    const _rarityOrder = { 'Common': 0, 'Uncommon': 1, 'Rare': 2, 'Onyx': 3 };
    rows.sort((a, b) => {
        let va, vb;
        if (_libSortCol === 'rarity') {
            va = _rarityOrder[(STATE.cardInfo[a.name] || {}).rare] ?? -1;
            vb = _rarityOrder[(STATE.cardInfo[b.name] || {}).rare] ?? -1;
        } else {
            va = a[_libSortCol]; vb = b[_libSortCol];
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
        }
        if (va < vb) return _libSortAsc ? -1 : 1;
        if (va > vb) return _libSortAsc ? 1 : -1;
        // Secondary sort: always alphabetical by name within a group
        return a.name.localeCompare(b.name);
    });

    // Update header indicators
    document.querySelectorAll('#lib-table thead th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.col === _libSortCol) {
            th.classList.add(_libSortAsc ? 'sort-asc' : 'sort-desc');
        }
    });

    const tbody = document.getElementById('lib-tbody');
    tbody.innerHTML = '';
    for (const card of rows) {
        const tr = document.createElement('tr');
        tr.dataset.name = card.name;
        if (_cardKey(card) === _libSelectedKey) tr.classList.add('selected');
        tr.innerHTML = `
            <td title="${esc(_dispName(card))}">${card.fused ? '<img src="assets/Orb.png" class="orb-icon" alt="fused" title="Fused">' : ''
            }${esc(_dispName(card))}</td>
            <td class="center">${_rarityImg(card)}</td>
            <td class="center">${card.level}</td>
            <td class="center">${card.fused ? '✓' : '–'}</td>
            <td class="center">${card.onyx  ? '✓' : '–'}</td>
            <td class="center">${card.quantity}</td>
        `;
        tr.addEventListener('click', () => {
            document.querySelectorAll('#lib-tbody tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            _libSelectedKey = _cardKey(card);
        });
        tbody.appendChild(tr);
    }
}

// ── Deck refresh ──────────────────────────────────────────────────────────────

function refreshDeck() {
    // Update header sort indicators
    const _rarityOrder = { 'Common': 0, 'Uncommon': 1, 'Rare': 2, 'Onyx': 3 };
    document.querySelectorAll('#deck-table thead th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.col && th.dataset.col === _deckSortCol) {
            th.classList.add(_deckSortAsc ? 'sort-asc' : 'sort-desc');
        }
    });

    const tbody = document.getElementById('deck-tbody');
    tbody.innerHTML = '';
    for (let i = 0; i < STATE.deck.length; i++) {
        const card = STATE.deck[i] || {};
        const tr = document.createElement('tr');
        tr.dataset.idx = i;
        if (i === _deckSelectedIdx) tr.classList.add('selected');
        tr.innerHTML = `
            <td class="center text-fg2">${i + 1}</td>
            <td title="${esc(_dispName(card))}">${card.fused ? '<img src="assets/Orb.png" class="orb-icon" alt="fused" title="Fused">' : ''}${esc(_dispName(card))}</td>
            <td class="center">${_rarityImg(card)}</td>
            <td class="center">${card.level || '?'}</td>
            <td class="center">${card.fused ? '✓' : '–'}</td>
            <td class="center">${card.onyx  ? '✓' : '–'}</td>
        `;
        tr.addEventListener('click', () => {
            document.querySelectorAll('#deck-tbody tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            _deckSelectedIdx = i;
        });
        tbody.appendChild(tr);
    }
    document.getElementById('deck-count').textContent = '(' + STATE.deck.length + ' cards)';
}

// ── Suggestions refresh ───────────────────────────────────────────────────────

function refreshSuggestions() {
    if (Object.keys(STATE.comboDict).length === 0 || STATE.library.length === 0) return;

    const deckKeys = STATE.deck.map(c => _cardKey(c));
    const ranked = rankSuggestions(STATE.comboDict, STATE.library, deckKeys, STATE.settings);
    const keyLookup = buildKeyLookup(STATE.library);
    const deckCards = STATE.deck;

    const tbody = document.getElementById('sug-tbody');
    tbody.innerHTML = '';

    const cap = Math.min(ranked.length, 80);
    for (let i = 0; i < cap; i++) {
        const [key, score] = ranked[i];
        const libCard = keyLookup[key];
        const topCombo = libCard ? _getTopComboName(libCard, deckCards) : '';
        const topComboCard = keyLookup[topCombo];
        const topComboLabel = topComboCard ? _dispName(topComboCard) : topCombo;

        const tr = document.createElement('tr');
        tr.dataset.key = key;
        if (key === _sugSelectedKey) tr.classList.add('selected');
        tr.innerHTML = `
            <td class="center text-fg2">${i + 1}</td>
            <td title="${esc(_dispName(libCard))}">${libCard && libCard.fused ? '<img src="assets/Orb.png" class="orb-icon" alt="fused" title="Fused">' : ''}${esc(_dispName(libCard))}</td>
            <td class="center text-score">${score.toFixed(1)}</td>
            <td title="${esc(topComboLabel)}">${esc(topComboLabel)}</td>
        `;
        tr.addEventListener('click', () => {
            document.querySelectorAll('#sug-tbody tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            _sugSelectedKey = key;
        });
        tbody.appendChild(tr);
    }
}

function _getTopComboName(libCard, deckCards) {
    if (!deckCards.length) return '';
    const s = STATE.settings;
    let bestVal = -1, bestName = '';
    for (const dc of deckCards) {
        const val = comboValue(STATE.comboDict,
            libCard.id, libCard.level, libCard.onyx,
            dc.id, dc.level, dc.onyx,
            s.mode, s.ab, s.db);
        if (val > bestVal) { bestVal = val; bestName = dc.name; }
    }
    return bestVal > 0 ? bestName : '';
}

// ── Matrix refresh ────────────────────────────────────────────────────────────

function refreshMatrix() {
    const el = document.getElementById('matrix-output');
    if (Object.keys(STATE.comboDict).length === 0 || STATE.deck.length === 0) {
        el.textContent = '';
        return;
    }

    const keyLookup = buildKeyLookup(STATE.library);
    const deckCards  = STATE.deck;
    if (!deckCards.length) { el.textContent = ''; return; }

    const s   = STATE.settings;
    const w   = 6;
    const nw  = 18;

    const lines = [];
    const header = ' '.repeat(nw) + deckCards.map(c => {
        const prefix = c.fused ? '●' : ' ';
        return (prefix + _dispName(c)).substring(0, w - 1).padStart(w);
    }).join('');
    lines.push(header);
    lines.push('─'.repeat(header.length));

    for (const libCard of STATE.library) {
        if (!keyLookup[_cardKey(libCard)]) continue;
        const rowVals = deckCards.map(dc =>
            comboValue(STATE.comboDict,
                libCard.id, libCard.level, libCard.onyx,
                dc.id, dc.level, dc.onyx,
                s.mode, s.ab, s.db)
        );
        if (!rowVals.some(v => v > 0)) continue;

        const prefix = libCard.fused ? '●' : '';
        let row = (prefix + _dispName(libCard)).substring(0, nw - 1).padEnd(nw);
        for (const val of rowVals) {
            row += val > 0 ? String(Math.round(val)).padStart(w) : (' '.repeat(w - 1) + '–');
        }
        lines.push(row);
    }

    el.textContent = lines.join('\n');
}

// ── Score refresh ─────────────────────────────────────────────────────────────

function refreshScore() {
    if (Object.keys(STATE.comboDict).length === 0 || STATE.deck.length === 0) {
        document.getElementById('score-display').textContent = 'Score: –';
        document.getElementById('info-display').textContent = '';
        return;
    }
    const score = totalDeckScore(STATE.comboDict, STATE.deck.map(c => _cardKey(c)), STATE.library, STATE.settings);
    document.getElementById('score-display').textContent = 'Score: ' + Math.round(score).toLocaleString();

    const fused   = STATE.deck.filter(c => c && c.fused).length;
    const unfused = STATE.deck.length - fused;
    document.getElementById('info-display').textContent =
        `Fused: ${fused}  |  Unfused: ${unfused}  |  Deck: ${STATE.deck.length}`;
}

// ── Leaderboard refresh ───────────────────────────────────────────────────────

function refreshLeaderboard() {
    const tbody = document.getElementById('lb-tbody');
    tbody.innerHTML = '';
    const keyLookup = buildKeyLookup(STATE.library);
    for (let i = 0; i < STATE.leaderboard.length; i++) {
        const entry = STATE.leaderboard[i];
        // Support both old (composite key string) and new (card object) deck formats
        const _resolveCard = item =>
            typeof item === 'string' ? (keyLookup[item] || { name: _nameFromKey(item) }) : item;
        const deckNames = entry.deck.map(item => _dispName(_resolveCard(item)));
        const startDisp = (() => {
            if (typeof entry.startCard === 'object') return _dispName(entry.startCard);
            const c = keyLookup[entry.startCard];
            return c ? _dispName(c) : _nameFromKey(entry.startCard);
        })();
        const preview = deckNames.slice(0, 6).join(', ') + (deckNames.length > 6 ? '…' : '');
        const tr = document.createElement('tr');
        tr.dataset.idx = i;
        if (i === _lbSelectedIdx) tr.classList.add('selected');
        tr.innerHTML = `
            <td class="center text-fg2">${i + 1}</td>
            <td title="${esc(startDisp)}">${esc(startDisp)}</td>
            <td class="center text-score">${Math.round(entry.score).toLocaleString()}</td>
            <td class="center">${entry.deck.length}</td>
            <td title="${esc(deckNames.join(', '))}">${esc(preview)}</td>
        `;
        tr.addEventListener('click', () => {
            document.querySelectorAll('#lb-tbody tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            _lbSelectedIdx = i;
        });
        tbody.appendChild(tr);
    }
}

// ── Start card dropdown ───────────────────────────────────────────────────────

function _refreshStartCardDropdown() {
    const sel = document.getElementById('start-card-select');
    const cards = STATE.library;
    sel.innerHTML = cards.map(c => {
        const key = _cardKey(c);
        const label = (c.fused ? '\u25cf ' : '') + _dispName(c);
        return `<option value="${esc(key)}">${esc(label)}</option>`;
    }).join('');
    const keys = cards.map(c => _cardKey(c));
    if (STATE.startCard && keys.includes(STATE.startCard)) {
        sel.value = STATE.startCard;
    } else if (keys.length > 0) {
        sel.value = keys[0];
        STATE.startCard = keys[0];
    }

    // Populate datalist used in card dialog
    const dl = document.getElementById('card-name-list');
    dl.innerHTML = STATE.baseCardNames.map(n => `<option value="${esc(n)}"></option>`).join('');
}

// ── Library actions ───────────────────────────────────────────────────────────

function _addCard() {
    _openCardDialog(null);
}

function _editCard() {
    if (!_libSelectedKey) { _toast('Select a card first.'); return; }
    const card = STATE.library.find(c => _cardKey(c) === _libSelectedKey);
    if (card) _openCardDialog(card);
}

function _removeCard() {
    if (!_libSelectedKey) { _toast('Select a card first.'); return; }
    const cardName = _nameFromKey(_libSelectedKey);
    _confirm('Remove Card', `Remove "${cardName}" from library?`, () => {
        STATE.library = STATE.library.filter(c => _cardKey(c) !== _libSelectedKey);
        _libSelectedKey = null;
        _refreshAll();
        _saveLibraryToStorage();
    });
}

function _addSelectedToDeck() {
    if (!_libSelectedKey) { _toast('Select a card first.'); return; }
    const card = buildKeyLookup(STATE.library)[_libSelectedKey];
    if (card) _addToDeck(_libSelectedKey);
}

function _saveLibraryToStorage() {
    try {
        localStorage.setItem('la_library', JSON.stringify(STATE.library));
        _toast('Library saved (' + STATE.library.length + ' cards)', 'success');
    } catch (err) {
        _toast('Save failed: ' + err.message, 'error');
    }
}

function _exportLibrary() {
    _download('library.json', JSON.stringify(STATE.library, null, 2));
    _toast('Library exported', 'success');
}

function _importLibrary(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
        try {
            const lib = JSON.parse(evt.target.result);
            if (!Array.isArray(lib)) throw new Error('Not an array');
            STATE.library = lib;
            _resolveIds();
            _refreshAll();
            _saveLibraryToStorage();
            _toast('Library imported (' + lib.length + ' cards)', 'success');
        } catch (err) { _toast('Import failed: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
}

// ── Card dialog ────────────────────────────────────────────────────────────────

let _cardDialogMode     = 'add';   // 'add' | 'edit'
let _cardDialogOrigKey  = null;    // composite key of the card being edited

function _openCardDialog(card) {
    _cardDialogMode = card ? 'edit' : 'add';
    _cardDialogOrigKey = card ? _cardKey(card) : null;

    document.getElementById('modal-card-title').textContent = card ? 'Edit Card' : 'Add Card';
    document.getElementById('card-name').value   = card ? card.name     : '';
    document.getElementById('card-level').value  = card ? card.level    : 5;
    document.getElementById('card-fused').checked = card ? !!card.fused : false;
    document.getElementById('card-onyx').checked  = card ? !!card.onyx  : false;
    document.getElementById('card-qty').value    = card ? card.quantity : 1;

    _openModal('modal-card');
    // Show 'Add Another' only in add mode
    document.getElementById('btn-card-add-another').style.display =
        card ? 'none' : '';
}

function _cardDialogOk() {
    const name   = document.getElementById('card-name').value.trim();
    const level  = parseInt(document.getElementById('card-level').value, 10);
    const fused  = document.getElementById('card-fused').checked;
    const onyx   = document.getElementById('card-onyx').checked;
    const qty    = parseInt(document.getElementById('card-qty').value, 10);

    if (!name) { _toast('Please enter a card name.', 'error'); return; }
    if (!STATE.nameToId[name]) { _toast(`"${name}" is not a valid card name.`, 'error'); return; }
    if (isNaN(level) || level < 1 || level > 5) { _toast('Level must be 1–5.', 'error'); return; }
    if (isNaN(qty)   || qty < 1 || qty > 3)      { _toast('Quantity must be 1–3.', 'error'); return; }

    const id = STATE.comboNameToId[name] || STATE.nameToId[name] || 0;
    const updated = { name, level, fused, onyx, quantity: qty, id };

    if (_cardDialogMode === 'edit' && _cardDialogOrigKey) {
        const newKey = _cardKey(updated);

        // If the key changed, check for a collision with an existing entry
        if (newKey !== _cardDialogOrigKey) {
            const collisionIdx = STATE.library.findIndex(c => _cardKey(c) === newKey);
            if (collisionIdx !== -1) {
                // Pause and ask the user which entry to keep
                _conflictPending = { updated, collisionCard: STATE.library[collisionIdx], origKey: _cardDialogOrigKey };
                _closeModal('modal-card');
                _showConflictModal();
                return;
            }
        }

        // No collision — just update in place
        const freshIdx = STATE.library.findIndex(c => _cardKey(c) === _cardDialogOrigKey);
        if (freshIdx !== -1) STATE.library[freshIdx] = updated;
        else STATE.library.push(updated);

        // Update any deck cards that were the old variant to the new variant
        if (newKey !== _cardDialogOrigKey) {
            STATE.deck = STATE.deck.map(c => _cardKey(c) === _cardDialogOrigKey ? updated : c);
            _saveDeck();
        }
    } else {
        // Deduplicate by composite key (name + fused + onyx)
        const existing = STATE.library.findIndex(c => _cardKey(c) === _cardKey(updated));
        if (existing !== -1) {
            STATE.library[existing] = updated;
        } else {
            STATE.library.push(updated);
        }
    }

    _libSelectedKey = _cardKey(updated);
    _closeModal('modal-card');
    _refreshAll();
    _saveLibraryToStorage();
}

function _cardDialogAddAnother() {
    // Save current card without closing the modal, then reset for the next entry
    const name   = document.getElementById('card-name').value.trim();
    const level  = parseInt(document.getElementById('card-level').value, 10);
    const fused  = document.getElementById('card-fused').checked;
    const onyx   = document.getElementById('card-onyx').checked;
    const qty    = parseInt(document.getElementById('card-qty').value, 10);

    if (!name) { _toast('Please enter a card name.', 'error'); return; }
    if (!STATE.nameToId[name]) { _toast(`"${name}" is not a valid card name.`, 'error'); return; }
    if (isNaN(level) || level < 1 || level > 5) { _toast('Level must be 1–5.', 'error'); return; }
    if (isNaN(qty)   || qty < 1 || qty > 3)     { _toast('Quantity must be 1–3.', 'error'); return; }

    const id = STATE.comboNameToId[name] || STATE.nameToId[name] || 0;
    const card = { name, level, fused, onyx, quantity: qty, id };
    // Deduplicate by composite key (name + fused + onyx)
    const existing = STATE.library.findIndex(c => _cardKey(c) === _cardKey(card));
    if (existing !== -1) STATE.library[existing] = card;
    else STATE.library.push(card);

    _saveLibraryToStorage();
    _refreshAll();
    _toast(`"${name}" added`, 'success');

    // Reset form for next card
    document.getElementById('card-name').value = '';
    document.getElementById('card-level').value = '5';
    document.getElementById('card-fused').checked = false;
    document.getElementById('card-onyx').checked = false;
    document.getElementById('card-qty').value = '1';
    document.getElementById('card-name').focus();
}

// ── Deck actions ──────────────────────────────────────────────────────────────

function _addToDeck(cardKey) {
    const card = buildKeyLookup(STATE.library)[cardKey];
    if (!card) { _toast(`Card not found in library.`, 'error'); return; }

    // Per-variant copy limit
    const copies = STATE.deck.filter(c => _cardKey(c) === cardKey).length;
    if (copies >= card.quantity) {
        _toast(`Already have ${copies}/${card.quantity} copies of "${_dispName(card)}".`);
        return;
    }

    // Cross-variant name cap: total of all variants of the same base name
    const nameTotal = STATE.deck.filter(c => c.name === card.name).length;
    const nameMaxQty = STATE.library
        .filter(c => c.name === card.name)
        .reduce((mx, c) => Math.max(mx, c.quantity), 0);
    if (nameTotal >= nameMaxQty) {
        _toast(`Deck already has ${nameTotal}/${nameMaxQty} "${card.name}" cards (all variants combined).`);
        return;
    }
    STATE.deck.push(card);
    _saveDeck();
    refreshDeck();
    refreshSuggestions();
    refreshMatrix();
    refreshScore();
}

function _setStartCard() {
    const sel = document.getElementById('start-card-select');
    const key = sel.value;  // now a composite key
    if (!key) return;

    STATE.startCard = key;
    localStorage.setItem('la_start_card', key);

    // Find the card for this composite key
    const card = buildKeyLookup(STATE.library)[key];
    if (!card) { _toast(`Selected card is not in your library.`, 'error'); return; }

    const idx = STATE.deck.findIndex(c => _cardKey(c) === key);
    if (idx === 0) {
        _toast(`"${_dispName(card)}" is already the first card.`);
        return;
    } else if (idx > 0) {
        STATE.deck.splice(idx, 1);
        STATE.deck.unshift(card);
    } else {
        STATE.deck.unshift(card);
    }

    _deckSelectedIdx = 0;
    _saveDeck();
    refreshDeck();
    refreshSuggestions();
    refreshMatrix();
    refreshScore();
}

function _removeFromDeck() {
    if (_deckSelectedIdx === null) { _toast('Select a card first.'); return; }
    STATE.deck.splice(_deckSelectedIdx, 1);
    _deckSelectedIdx = Math.min(_deckSelectedIdx, STATE.deck.length - 1);
    if (_deckSelectedIdx < 0) _deckSelectedIdx = null;
    _saveDeck();
    refreshDeck();
    refreshSuggestions();
    refreshMatrix();
    refreshScore();
}

function _deckUp() {
    if (_deckSelectedIdx === null || _deckSelectedIdx === 0) return;
    const i = _deckSelectedIdx;
    [STATE.deck[i - 1], STATE.deck[i]] = [STATE.deck[i], STATE.deck[i - 1]];
    _deckSelectedIdx = i - 1;
    _saveDeck();
    refreshDeck();
}

function _deckDown() {
    if (_deckSelectedIdx === null || _deckSelectedIdx >= STATE.deck.length - 1) return;
    const i = _deckSelectedIdx;
    [STATE.deck[i + 1], STATE.deck[i]] = [STATE.deck[i], STATE.deck[i + 1]];
    _deckSelectedIdx = i + 1;
    _saveDeck();
    refreshDeck();
}

function _sortDeckBy(col, asc) {
    const _rarityOrder = { 'Common': 0, 'Uncommon': 1, 'Rare': 2, 'Onyx': 3 };
    STATE.deck.sort((a, b) => {
        let va, vb;
        if (col === 'level') {
            va = a.level || 0;
            vb = b.level || 0;
        } else if (col === 'rarity') {
            const ra = a.onyx ? 'Onyx' : (STATE.cardInfo[a.name] || {}).rare || '';
            const rb = b.onyx ? 'Onyx' : (STATE.cardInfo[b.name] || {}).rare || '';
            va = _rarityOrder[ra] ?? -1;
            vb = _rarityOrder[rb] ?? -1;
        } else { // name
            va = (a.name || '').toLowerCase();
            vb = (b.name || '').toLowerCase();
        }
        if (va < vb) return asc ? -1 : 1;
        if (va > vb) return asc ? 1 : -1;
        return (a.name || '').localeCompare(b.name || '');
    });
    _deckSelectedIdx = null;
    _saveDeck();
    refreshDeck();
}

function _saveDeck() {
    try { localStorage.setItem('la_deck', JSON.stringify(STATE.deck)); } catch { /* ignore */ }
}

// ── Suggestion actions ────────────────────────────────────────────────────────

function _addBestSuggestion() {
    if (Object.keys(STATE.comboDict).length === 0 || STATE.library.length === 0) return;
    const ranked = rankSuggestions(STATE.comboDict, STATE.library, STATE.deck.map(c => _cardKey(c)), STATE.settings);
    if (ranked.length > 0) _addToDeck(ranked[0][0]);
}

// ── Algorithm runner ──────────────────────────────────────────────────────────

function _makeWorker() {
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function _runAlgorithm(job) {
    if (_workerRunning) { _toast('Another operation is in progress.'); return; }
    if (Object.keys(STATE.comboDict).length === 0) { _toast('Load combo data first.', 'error'); return; }

    const startCard = document.getElementById('start-card-select').value || STATE.startCard;

    if (job === 'fill' || job === 'advanced') {
        if (!startCard) { _toast('Select a start card.', 'error'); return; }
        if (!buildKeyLookup(STATE.library)[startCard]) {
            _toast(`Selected start card is not in your library.`, 'error'); return;
        }
    }

    const label = {
        fill:     '⚡ Filling deck…',
        advanced: '🧠 Running advanced fill…',
        try_all:  '🔁 Trying all start cards…',
    }[job] || 'Running…';

    setStatus(label);
    setProgress(0);
    _setWorkerBusy(true);

    // Clear deck for fill operations
    if (job === 'fill' || job === 'advanced') {
        STATE.deck = [];
        refreshDeck();
    }

    _worker = _makeWorker();
    if (!_worker) {
        _setWorkerBusy(false);
        _toast('Worker bundle missing — run build_data.py', 'error');
        return;
    }

    const msg = {
        type:       'run',
        job,
        comboDict:  STATE.comboDict,
        library:    STATE.library,
        startCard,
        targetSize: STATE.settings.n_cards,
        settings:   STATE.settings,
    };
    _worker.onmessage = e => {
        const { type, pct, label: lbl, result, message } = e.data;
        if (type === 'progress') {
            setProgress(pct);
            if (lbl) setStatus(label.replace('…', '') + ' — ' + lbl + '…');
        } else if (type === 'done') {
            _setWorkerBusy(false);
            setProgress(100);
            if (job === 'try_all') {
                const kl = buildKeyLookup(STATE.library);
                STATE.leaderboard = result.map(r => ({
                    startCard: r.startCard,
                    score:     r.score,
                    deck:      r.deck.map(k => kl[k]).filter(Boolean),
                }));
                refreshLeaderboard();
                setStatus(`Tried ${result.length} start cards. Best: "${result[0]?.startCard || '–'}"`);
                // Switch to leaderboard tab
                document.querySelector('.tab-btn[data-tab="leaderboard"]').click();
            } else {
                const kl = buildKeyLookup(STATE.library);
                STATE.deck = result.map(k => kl[k]).filter(Boolean);
                _saveDeck();
                _refreshAll();
                const sc = totalDeckScore(STATE.comboDict, result, STATE.library, STATE.settings);
                setStatus(`Deck filled: ${result.length} cards  |  Score: ${Math.round(sc).toLocaleString()}`);
            }
        } else if (type === 'error') {
            _setWorkerBusy(false);
            setProgress(0);
            _toast('Error: ' + message, 'error');
            setStatus('Error: ' + message);
        }
    };
    _worker.onerror = err => {
        _setWorkerBusy(false);
        setProgress(0);
        _toast('Worker error: ' + (err.message || 'unknown'), 'error');
    };
    _worker.postMessage(msg);
}

function _cancelWorker() {
    if (_worker) {
        _worker.postMessage({ type: 'cancel' });
        setTimeout(() => { _worker.terminate(); _worker = null; }, 500);
    }
    _setWorkerBusy(false);
    setStatus('Cancelled.');
}

function _setWorkerBusy(busy) {
    _workerRunning = busy;
    document.getElementById('btn-cancel').disabled = !busy;
}

// ── Leaderboard actions ───────────────────────────────────────────────────────

function _copyToLeaderboard() {
    if (!STATE.deck.length) { _toast('Deck is empty.'); return; }
    const startCard = document.getElementById('start-card-select').value || (STATE.deck[0] ? _cardKey(STATE.deck[0]) : '?');
    const deckKeys = STATE.deck.map(c => _cardKey(c));
    const score = totalDeckScore(STATE.comboDict, deckKeys, STATE.library, STATE.settings);
    const entry = { startCard, score, deck: [...STATE.deck] };

    const idx = STATE.leaderboard.findIndex(e => e.startCard === startCard);
    if (idx !== -1) {
        if (score > STATE.leaderboard[idx].score) STATE.leaderboard[idx] = entry;
    } else {
        STATE.leaderboard.push(entry);
    }
    STATE.leaderboard.sort((a, b) => b.score - a.score);
    refreshLeaderboard();
    setStatus(`Copied to leaderboard  (score ${Math.round(score).toLocaleString()})`);
    // Switch to leaderboard tab
    document.querySelector('.tab-btn[data-tab="leaderboard"]').click();
}

function _loadLbDeck() {
    if (_lbSelectedIdx === null) { _toast('Select a leaderboard entry first.'); return; }
    const entry = STATE.leaderboard[_lbSelectedIdx];
    if (!entry) return;
    STATE.deck = [...entry.deck];
    STATE.startCard = entry.startCard;
    _saveDeck();
    localStorage.setItem('la_start_card', entry.startCard);
    _refreshAll();
    setStatus(`Loaded leaderboard deck: "${entry.startCard}"  (score ${Math.round(entry.score).toLocaleString()})`);
}

function _saveLeaderboardToStorage() {
    try {
        localStorage.setItem('la_leaderboard', JSON.stringify(STATE.leaderboard));
        _toast('Leaderboard saved', 'success');
    } catch (err) { _toast('Save failed: ' + err.message, 'error'); }
}

function _exportLeaderboard() {
    _download('leaderboard.json', JSON.stringify(STATE.leaderboard, null, 2));
    _toast('Leaderboard exported', 'success');
}

function _importLeaderboard(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
        try {
            const lb = JSON.parse(evt.target.result);
            if (!Array.isArray(lb)) throw new Error('Not an array');
            STATE.leaderboard = lb;
            refreshLeaderboard();
            _toast('Leaderboard imported (' + lb.length + ' entries)', 'success');
        } catch (err) { _toast('Import failed: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
}

// ── Export deck ───────────────────────────────────────────────────────────────

function _exportDeck() {
    if (!STATE.deck.length) { _toast('Deck is empty.'); return; }

    const keyLookup = buildKeyLookup(STATE.library);
    const score  = totalDeckScore(STATE.comboDict, STATE.deck.map(c => _cardKey(c)), STATE.library, STATE.settings);
    const startKey = document.getElementById('start-card-select').value || (STATE.deck[0] ? _cardKey(STATE.deck[0]) : '');
    const startCard = keyLookup[startKey] ? _dispName(keyLookup[startKey]) : (startKey ? _nameFromKey(startKey) : '–');
    const start = startCard;
    const modeLabels = { 1: 'Sum (Attack+Defence)', 2: 'Attack only', 3: 'Defence only', 4: 'Heroics' };
    const modeStr = modeLabels[STATE.settings.mode] || 'Sum';
    const s = STATE.settings;

    const lines = [
        'Little Alchemist Deck Optimizer  –  Deck Export',
        '='.repeat(52),
        `Start card  : ${start}`,
        `Deck size   : ${STATE.deck.length} cards`,
        `Score       : ${Math.round(score).toLocaleString()}`,
        `Score mode  : ${modeStr}`,
        `LCwC: ${s.lcwc}  SV: ${s.sv}  CR: ${s.cr}  FB: ${s.fb}`,
        '',
        `${'#'.padEnd(4)} ${'Card'.padEnd(26)} ${'Lv'.padEnd(4)} ${'Fused'.padEnd(6)} Onyx`,
        '-'.repeat(52),
    ];

    STATE.deck.forEach((card, i) => {
        const level = card.level || '?';
        const fused = card.fused ? 'Yes' : 'No';
        const onyx  = card.onyx  ? 'Yes' : 'No';
        lines.push(`${String(i + 1).padEnd(4)} ${_dispName(card).padEnd(26)} ${String(level).padEnd(4)} ${fused.padEnd(6)} ${onyx}`);
    });

    lines.push('-'.repeat(52), '', 'Generated by Little Alchemist Deck Optimizer (Web)');
    _download('deck_export.txt', lines.join('\n'));
    setStatus('Deck exported.');
}

// ── Settings modal ────────────────────────────────────────────────────────────

function _openSettings() {
    const s = STATE.settings;
    document.getElementById('setting-mode').value    = s.mode;
    document.getElementById('setting-lcwc').value    = s.lcwc;
    document.getElementById('setting-sv').value      = s.sv;
    document.getElementById('setting-cr').value      = s.cr;
    document.getElementById('setting-fb').value      = s.fb;
    document.getElementById('setting-ab').value      = s.ab;
    document.getElementById('setting-db').value      = s.db;
    document.getElementById('setting-ncards').value  = s.n_cards;
    _openModal('modal-settings');
}

function _saveSettings() {
    const mode    = parseInt(document.getElementById('setting-mode').value, 10);
    const lcwc    = parseInt(document.getElementById('setting-lcwc').value, 10);
    const sv      = parseFloat(document.getElementById('setting-sv').value);
    const cr      = parseFloat(document.getElementById('setting-cr').value);
    const fb      = parseFloat(document.getElementById('setting-fb').value);
    const ab      = parseFloat(document.getElementById('setting-ab').value);
    const db      = parseFloat(document.getElementById('setting-db').value);
    const n_cards = parseInt(document.getElementById('setting-ncards').value, 10);

    if ([mode, lcwc, sv, cr, fb, ab, db, n_cards].some(isNaN)) {
        _toast('Invalid value — check all fields.', 'error'); return;
    }

    Object.assign(STATE.settings, { mode, lcwc, sv, cr, fb, ab, db, n_cards });
    try {
        localStorage.setItem('la_settings', JSON.stringify(STATE.settings));
    } catch { /* ignore */ }

    _closeModal('modal-settings');
    _refreshAll();
    _toast('Settings saved', 'success');
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function _cardDesc(c) {
    return `<div style="font-size:0.85em;line-height:1.7">
        <b>${esc(_dispName(c))}</b><br>
        Level: ${c.level} &nbsp;|&nbsp; Fused: ${c.fused ? 'Yes' : 'No'} &nbsp;|&nbsp; Onyx: ${c.onyx ? 'Yes' : 'No'} &nbsp;|&nbsp; Qty: ${c.quantity}
    </div>`;
}

function _showConflictModal() {
    const { updated, collisionCard } = _conflictPending;
    document.getElementById('conflict-edited').innerHTML   = _cardDesc(updated);
    document.getElementById('conflict-existing').innerHTML = _cardDesc(collisionCard);
    _openModal('modal-conflict');
}

function _conflictKeepEdited() {
    if (!_conflictPending) return;
    const { updated, collisionCard, origKey } = _conflictPending;
    _conflictPending = null;
    _closeModal('modal-conflict');

    // Remove both the original and the collision, then insert the edited one
    STATE.library = STATE.library.filter(c => _cardKey(c) !== origKey && _cardKey(c) !== _cardKey(collisionCard));
    STATE.library.push(updated);

    // Migrate deck entries from both old keys to the new card
    const newKey = _cardKey(updated);
    STATE.deck = STATE.deck.map(c =>
        (_cardKey(c) === origKey || _cardKey(c) === _cardKey(collisionCard)) ? updated : c);
    _saveDeck();
    _libSelectedKey = newKey;
    _refreshAll();
    _saveLibraryToStorage();
}

function _conflictKeepExisting() {
    if (!_conflictPending) return;
    const { updated, collisionCard, origKey } = _conflictPending;
    _conflictPending = null;
    _closeModal('modal-conflict');

    // Remove the original being edited; the existing (collision) entry is kept as-is
    STATE.library = STATE.library.filter(c => _cardKey(c) !== origKey);

    // Migrate deck entries that pointed to the old key to point to the surviving card
    STATE.deck = STATE.deck.map(c => _cardKey(c) === origKey ? collisionCard : c);
    _saveDeck();
    _libSelectedKey = _cardKey(collisionCard);
    _refreshAll();
    _saveLibraryToStorage();
}

function _openModal(id) {
    document.getElementById(id).classList.add('visible');
    document.getElementById('modal-overlay').classList.add('visible');
}

function _closeModal(id) {
    document.getElementById(id).classList.remove('visible');
    // Close overlay if no other modal is open
    const anyOpen = document.querySelector('.modal.visible');
    if (!anyOpen) document.getElementById('modal-overlay').classList.remove('visible');
}

function _closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('visible'));
    document.getElementById('modal-overlay').classList.remove('visible');
}

function _confirm(title, message, callback) {
    document.getElementById('confirm-title').textContent   = title;
    document.getElementById('confirm-message').textContent = message;
    _confirmCallback = callback;
    _openModal('modal-confirm');
}

// ── Status bar helpers ────────────────────────────────────────────────────────

function setStatus(text) {
    document.getElementById('status-text').textContent = text;
}

function setProgress(pct) {
    document.getElementById('progress-bar').value = Math.max(0, Math.min(100, pct));
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer = null;

function _toast(text, type = '') {
    const el = document.getElementById('toast');
    el.textContent  = text;
    el.className    = 'visible' + (type ? ' ' + type : '');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

// ── Download helper ───────────────────────────────────────────────────────────

function _download(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
