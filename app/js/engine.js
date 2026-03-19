/**
 * engine.js
 * Scoring and deck-optimisation logic for Little Alchemist Deck Optimizer.
 * Pure JavaScript port of engine.py — no DOM dependencies.
 * Works in both the main thread and a Web Worker (via importScripts).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SCORING FORMULA  (reverse-engineered from the Excel sheet)
 * ──────────────────────────────────────────────────────────────────────────
 *  key     = str(min(idA + idB/1000,  idB + idA/1000))  (matches Python)
 *  col     = int(onyxA) + int(onyxB)          // 0, 1 or 2
 *  ba/bd   = entry.ba[col] / entry.bd[col]
 *  avgLvl  = roundHalfUp((levelA + levelB) / 2)
 *  if onyx: resRare = cmbRare = 4
 *  resAdj  = -1 if resRare <= 2 else 0
 *  lvSum   = avgLvl + resAdj
 *  mode 1  → ba + bd + lvSum*cmbRare*2
 *  mode 2  → ba      + lvSum*cmbRare*2
 *  mode 3  →      bd + lvSum*cmbRare*2
 *  mode 4  → ba*AB + bd*DB + lvSum*cmbRare*(AB+DB)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round 0.5 up (Excel ROUND behaviour). */
function roundHalfUp(x) {
    return Math.floor(x + 0.5);
}

/**
 * Compute the combo-dict key string from two card IDs.
 * Matches Python: str(round(min(idA + idB/1000, idB + idA/1000), 3))
 */
function comboKey(idA, idB) {
    const raw = Math.min(idA + idB / 1000.0, idB + idA / 1000.0);
    // Replicate Python round(x, 3) -> avoid floating point drift
    const rounded = Math.round(raw * 1000) / 1000;
    const s = rounded.toString();
    // Python str(2.0) = "2.0", JS (2.0).toString() = "2" → fix
    return s.includes('.') ? s : s + '.0';
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

/**
 * Return the raw combination value for cards A and B.
 * @param {Object} comboDict  - The parsed combo dictionary (string keys)
 * @param {number} idA / levelA / onyxA  - Card A properties
 * @param {number} idB / levelB / onyxB  - Card B properties
 * @param {number} mode  - 1=Sum 2=Attack 3=Defence 4=Heroics
 * @param {number} ab / db  - Heroic attack/defence buffs
 * @returns {number}
 */
export function comboValue(comboDict, idA, levelA, onyxA, idB, levelB, onyxB, mode, ab, db) {
    if (idA === 0 || idB === 0) return 0.0;

    const key = comboKey(idA, idB);
    const entry = comboDict[key];
    if (!entry) return 0.0;

    const col = (onyxA ? 1 : 0) + (onyxB ? 1 : 0);
    const ba = entry.ba[col];
    const bd = entry.bd[col];

    const avgLvl = roundHalfUp((levelA + levelB) / 2.0);

    let resRare, cmbRare;
    if (onyxA || onyxB) {
        resRare = 4;
        cmbRare = 4;
    } else {
        resRare = entry.res_rare;
        cmbRare = entry.cmb_rare;
    }

    const resAdj = resRare <= 2 ? -1 : 0;
    const lvSum = avgLvl + resAdj;

    if (mode === 1) return ba + bd + lvSum * cmbRare * 2;
    if (mode === 2) return ba      + lvSum * cmbRare * 2;
    if (mode === 3) return      bd + lvSum * cmbRare * 2;
    // mode 4 – Heroics
    return ba * ab + bd * db + lvSum * cmbRare * (ab + db);
}

// ---------------------------------------------------------------------------
// Per-card scoring against the current deck
// ---------------------------------------------------------------------------

/** Raw combo values of a library card vs every deck card. */
function computeMatrixRow(comboDict, libId, libLevel, libOnyx, deckCards, mode, ab, db) {
    return deckCards.map(dc =>
        comboValue(comboDict, libId, libLevel, libOnyx, dc.id, dc.level, dc.onyx, mode, ab, db)
    );
}

/** Six SUMIF totals at thresholds lcwc, lcwc+sv, …, lcwc+5*sv. */
function thresholdScores(values, lcwc, sv) {
    const result = [];
    for (let i = 0; i < 6; i++) {
        const threshold = lcwc + i * sv;
        result.push(values.reduce((sum, v) => (v >= threshold ? sum + v : sum), 0));
    }
    return result;
}

/**
 * Ranked / weighted score for adding libCard to the deck.
 * @param {Object} comboDict
 * @param {Object} libCard     - { id, level, onyx, fused, name }
 * @param {Array}  deckCards   - array of { id, level, onyx }
 * @param {Object} settings    - { mode, lcwc, sv, cr, fb, ab, db }
 * @param {number} copiesInDeck - how many copies already in deck
 * @returns {number}
 */
function cardSuggestionScore(comboDict, libCard, deckCards, settings, copiesInDeck) {
    if (!deckCards || deckCards.length === 0) return 0.0;

    const row = computeMatrixRow(
        comboDict,
        libCard.id, libCard.level, libCard.onyx,
        deckCards,
        settings.mode, settings.ab, settings.db
    );

    const sums = thresholdScores(row, settings.lcwc, settings.sv);
    let score = sums.reduce((a, b) => a + b, 0) / sums.length;
    score *= Math.pow(settings.cr, copiesInDeck);
    if (libCard.fused) score *= settings.fb;

    return score;
}

// ---------------------------------------------------------------------------
// Suggestion ranking
// ---------------------------------------------------------------------------

/**
 * Return library cards sorted by suggestion score (descending).
 * @param {Object} comboDict
 * @param {Array}  library    - array of card objects
 * @param {Array}  deck       - array of card name strings (may have duplicates)
 * @param {Object} settings
 * @returns {Array}  [ [name, score], ... ]
 */
export function rankSuggestions(comboDict, library, deck, settings) {
    const keyLookup = buildKeyLookup(library);

    const deckCards = deck.map(k => keyLookup[k]).filter(Boolean);

    // Count copies already in deck (keyed by composite key)
    const deckCounts = {};
    for (const k of deck) deckCounts[k] = (deckCounts[k] || 0) + 1;

    // Count total same-name copies in deck across all variants
    const deckNameCounts = {};
    for (const k of deck) {
        const c = keyLookup[k];
        if (c) deckNameCounts[c.name] = (deckNameCounts[c.name] || 0) + 1;
    }

    // Max quantity per base name across all variants in library
    const nameMaxQty = {};
    for (const c of library) {
        if (nameMaxQty[c.name] === undefined || c.quantity > nameMaxQty[c.name])
            nameMaxQty[c.name] = c.quantity;
    }

    const ranked = [];
    for (const libCard of library) {
        const key = _ck(libCard);
        const inDeck = deckCounts[key] || 0;
        if (inDeck >= libCard.quantity) continue;

        // Cross-variant name cap
        const nameCopies = deckNameCounts[libCard.name] || 0;
        if (nameCopies >= (nameMaxQty[libCard.name] || libCard.quantity)) continue;

        const score = cardSuggestionScore(comboDict, libCard, deckCards, settings, inDeck);
        ranked.push([key, score]);
    }

    ranked.sort((a, b) => b[1] - a[1]);
    return ranked;
}

/** Return the single best card name to add next, or null. */
export function nextSuggestion(comboDict, library, deck, settings) {
    const ranked = rankSuggestions(comboDict, library, deck, settings);
    return ranked.length > 0 ? ranked[0][0] : null;
}

// ---------------------------------------------------------------------------
// Total deck score
// ---------------------------------------------------------------------------

/**
 * Total deck score = sum of each card's contribution score against other cards.
 * @param {Object} comboDict
 * @param {Array}  deck      - array of card name strings
 * @param {Array}  library
 * @param {Object} settings
 * @returns {number}
 */
export function totalDeckScore(comboDict, deck, library, settings) {
    const keyLookup = buildKeyLookup(library);
    let total = 0.0;
    const copyCounts = {};

    for (let i = 0; i < deck.length; i++) {
        const key = deck[i];
        const card = keyLookup[key];
        if (!card) continue;

        const copyN = copyCounts[key] || 0;
        copyCounts[key] = copyN + 1;

        const others = [];
        for (let j = 0; j < deck.length; j++) {
            if (j !== i && keyLookup[deck[j]]) others.push(keyLookup[deck[j]]);
        }

        total += cardSuggestionScore(comboDict, card, others, settings, copyN);
    }

    return total;
}

// ---------------------------------------------------------------------------
// Algorithm: Greedy Fill
// ---------------------------------------------------------------------------

/**
 * Greedy fast fill – at each step add the top-ranked suggestion.
 * @param {Object}   comboDict
 * @param {Array}    library
 * @param {string}   startCard
 * @param {number}   targetSize
 * @param {Object}   settings
 * @param {Function} [progressCb]   - (current, total) => void
 * @returns {string[]}
 */
export function fillDeck(comboDict, library, startCard, targetSize, settings, progressCb) {
    const keyLookup = buildKeyLookup(library);
    if (!keyLookup[startCard]) {
        const s = nextSuggestion(comboDict, library, [], settings);
        startCard = s || startCard;
    }

    const deck = [startCard];

    for (let step = 1; step < targetSize; step++) {
        const suggestion = nextSuggestion(comboDict, library, deck, settings);
        if (!suggestion) break;
        deck.push(suggestion);
        if (progressCb) progressCb(step, targetSize - 1);
    }

    return deck;
}

// ---------------------------------------------------------------------------
// Algorithm: Advanced Fill
// ---------------------------------------------------------------------------

/**
 * Advanced filler – mimics the VBA AdvancedFiller algorithm.
 */
export function advancedFill(comboDict, library, startCard, targetSize, settings, progressCb) {
    if (targetSize < 2) return [startCard];

    const keyLookup = buildKeyLookup(library);
    let deck = [startCard];

    if (!keyLookup[startCard]) {
        const s = nextSuggestion(comboDict, library, [], settings);
        if (s) deck = [s];
        else return [];
    }

    const s2 = nextSuggestion(comboDict, library, deck, settings);
    if (s2) deck.push(s2);

    const totalSteps = targetSize - deck.length;
    let done = 0;

    for (let i = deck.length - 1; i < targetSize - 1; i++) {
        // Re-optimise each position 1..i
        for (let pos = 1; pos <= i; pos++) {
            optimisePosition(comboDict, library, deck, pos, settings);
        }

        const nextCard = nextSuggestion(comboDict, library, deck, settings);
        if (!nextCard) break;
        deck.push(nextCard);

        done++;
        if (progressCb) progressCb(done, totalSteps);
    }

    return deck;
}

/** Replace deck[position] (1-based) with best suggestion until stable. */
export function optimisePosition(comboDict, library, deck, position, settings, maxIter = 10) {
    const idx = position - 1;
    for (let iter = 0; iter < maxIter; iter++) {
        const current = deck[idx];
        const deckWithout = [...deck.slice(0, idx), ...deck.slice(idx + 1)];
        const suggestion = nextSuggestion(comboDict, library, deckWithout, settings);
        if (!suggestion || suggestion === current) break;
        deck[idx] = suggestion;
    }
}

// ---------------------------------------------------------------------------
// Algorithm: Hill Climb
// ---------------------------------------------------------------------------

/**
 * Full Hill-Climb – exhaustive single-swap search.
 * Stops when no improving swap exists or maxPasses reached.
 */
export function hillClimb(comboDict, library, startDeck, settings, progressCb, cancelledCb, maxPasses = 50) {
    const keyLookup  = buildKeyLookup(library);
    const nameMaxQty = buildNameMaxQty(library);
    const deck = [...startDeck];
    let bestScore = totalDeckScore(comboDict, deck, library, settings);

    for (let pass = 0; pass < maxPasses; pass++) {
        if (cancelledCb && cancelledCb()) break;

        const deckCounts = {};
        const deckNameCounts = {};
        for (const k of deck) {
            deckCounts[k] = (deckCounts[k] || 0) + 1;
            const name = (keyLookup[k] || {}).name;
            if (name) deckNameCounts[name] = (deckNameCounts[name] || 0) + 1;
        }

        let bestDelta = 0.0;
        let bestSwap = null;

        for (let deckIdx = 0; deckIdx < deck.length; deckIdx++) {
            const oldKey  = deck[deckIdx];
            const oldName = (keyLookup[oldKey] || {}).name;

            const partial = [...deck.slice(0, deckIdx), ...deck.slice(deckIdx + 1)];
            const partialCounts = { ...deckCounts };
            partialCounts[oldKey] = (partialCounts[oldKey] || 1) - 1;

            for (const libCard of library) {
                const newKey = _ck(libCard);
                if (newKey === oldKey) continue;

                const copiesInPartial = partialCounts[newKey] || 0;
                if (copiesInPartial >= libCard.quantity) continue;

                // Name cap: count of same name in partial (subtract old if same name)
                const nameCopies = (deckNameCounts[libCard.name] || 0)
                    - (oldName === libCard.name ? 1 : 0);
                if (nameCopies >= (nameMaxQty[libCard.name] || libCard.quantity)) continue;

                const candidate = [...partial, newKey];
                const score = totalDeckScore(comboDict, candidate, library, settings);
                const delta = score - bestScore;
                if (delta > bestDelta) {
                    bestDelta = delta;
                    bestSwap = [deckIdx, newKey];
                }
            }
        }

        if (!bestSwap) break;

        deck[bestSwap[0]] = bestSwap[1];
        bestScore += bestDelta;

        if (progressCb) progressCb(pass + 1, maxPasses);
    }

    return deck;
}

// ---------------------------------------------------------------------------
// Algorithm: Beam Search
// ---------------------------------------------------------------------------

/**
 * Beam Search – keeps the top beamWidth partial decks at every step.
 */
export function beamSearch(comboDict, library, startCard, targetSize, settings,
                    beamWidth = 5, progressCb, cancelledCb) {
    const keyLookup  = buildKeyLookup(library);
    const nameMaxQty = buildNameMaxQty(library);

    let beams;
    if (keyLookup[startCard]) {
        beams = [[[startCard], 0.0]];
    } else {
        const first = nextSuggestion(comboDict, library, [], settings) || startCard;
        beams = [[[first], 0.0]];
    }

    let bestDeck = beams[0][0];
    let bestScore = 0.0;

    for (let step = 1; step < targetSize; step++) {
        if (cancelledCb && cancelledCb()) break;

        const candidates = [];

        for (const [partial] of beams) {
            const partialCounts = {};
            const partialNameCounts = {};
            for (const k of partial) {
                partialCounts[k] = (partialCounts[k] || 0) + 1;
                const name = (keyLookup[k] || {}).name;
                if (name) partialNameCounts[name] = (partialNameCounts[name] || 0) + 1;
            }

            for (const libCard of library) {
                const key = _ck(libCard);
                if ((partialCounts[key] || 0) >= libCard.quantity) continue;

                // Name cap
                if ((partialNameCounts[libCard.name] || 0) >= (nameMaxQty[libCard.name] || libCard.quantity)) continue;

                const newDeck = [...partial, key];
                const score = totalDeckScore(comboDict, newDeck, library, settings);
                candidates.push([newDeck, score]);

                if (score > bestScore) {
                    bestScore = score;
                    bestDeck = newDeck;
                }
            }
        }

        if (candidates.length === 0) break;

        candidates.sort((a, b) => b[1] - a[1]);
        beams = candidates.slice(0, beamWidth);

        if (progressCb) progressCb(step, targetSize - 1);
    }

    return bestDeck;
}

// ---------------------------------------------------------------------------
// Algorithm: Simulated Annealing
// ---------------------------------------------------------------------------

/**
 * Simulated Annealing – can escape local optima.
 */
export function simulatedAnnealing(comboDict, library, startDeck, settings,
                             iterations = 8000, initialTemp = 0.0,
                             coolingRate = 0.997, progressCb, cancelledCb) {
    const keyLookup  = buildKeyLookup(library);
    const nameMaxQty = buildNameMaxQty(library);
    const deck = [...startDeck];
    const nDeck = deck.length;

    let currentScore = totalDeckScore(comboDict, deck, library, settings);
    let bestDeck = [...deck];
    let bestScore = currentScore;

    // Auto-calibrate temperature
    if (initialTemp <= 0) {
        const sampleScores = [];
        const deckCards = deck.map(k => keyLookup[k]).filter(Boolean);
        for (const libCard of library.slice(0, 20)) {
            const sc = cardSuggestionScore(comboDict, libCard, deckCards, settings, 0);
            if (sc > 0) sampleScores.push(sc);
        }
        const avgContrib = sampleScores.length > 0
            ? sampleScores.reduce((a, b) => a + b, 0) / sampleScores.length
            : 100.0;
        initialTemp = avgContrib * 0.25;
    }

    let temp = initialTemp;
    const libKeys = library.map(c => _ck(c));

    for (let it = 0; it < iterations; it++) {
        if (cancelledCb && cancelledCb()) break;

        temp *= coolingRate;

        const pos = Math.floor(Math.random() * nDeck);
        const oldKey  = deck[pos];
        const oldName = (keyLookup[oldKey] || {}).name;

        const copyCount = {};
        const nameCopyCount = {};
        for (const k of deck) {
            copyCount[k] = (copyCount[k] || 0) + 1;
            const name = (keyLookup[k] || {}).name;
            if (name) nameCopyCount[name] = (nameCopyCount[name] || 0) + 1;
        }

        let newKey = null;
        for (let attempt = 0; attempt < 20; attempt++) {
            const candKey = libKeys[Math.floor(Math.random() * libKeys.length)];
            if (candKey === oldKey) continue;
            const libCard = keyLookup[candKey];
            if (!libCard) continue;
            const copiesAfter = copyCount[candKey] || 0;
            if (copiesAfter >= libCard.quantity) continue;

            // Name cap: count of same name excluding the slot being replaced
            const nameAfter = (nameCopyCount[libCard.name] || 0)
                - (oldName === libCard.name ? 1 : 0);
            if (nameAfter >= (nameMaxQty[libCard.name] || libCard.quantity)) continue;

            newKey = candKey;
            break;
        }

        if (!newKey) continue;

        deck[pos] = newKey;
        const proposedScore = totalDeckScore(comboDict, deck, library, settings);
        const delta = proposedScore - currentScore;

        if (delta >= 0) {
            currentScore = proposedScore;
        } else if (temp > 1e-9) {
            const prob = Math.exp(delta / temp);
            if (Math.random() < prob) {
                currentScore = proposedScore;
            } else {
                deck[pos] = oldKey;
            }
        } else {
            deck[pos] = oldKey;
        }

        if (currentScore > bestScore) {
            bestScore = currentScore;
            bestDeck = [...deck];
        }

        if (progressCb && it % 200 === 0) progressCb(it, iterations);
    }

    return bestDeck;
}

// ---------------------------------------------------------------------------
// Combined optimizer
// ---------------------------------------------------------------------------

/**
 * Unified entry point for all optimisation methods.
 * @param {string} method - "greedy" | "advanced" | "hillclimb" | "beam" | "sa"
 */
export function optimize(comboDict, library, startCard, targetSize, settings,
                  method = 'sa', beamWidth = 5, saIterations = 8000,
                  progressCb, cancelledCb) {
    if (method === 'greedy') {
        return fillDeck(comboDict, library, startCard, targetSize, settings, progressCb);
    }
    if (method === 'advanced') {
        return advancedFill(comboDict, library, startCard, targetSize, settings, progressCb);
    }
    if (method === 'beam') {
        return beamSearch(comboDict, library, startCard, targetSize, settings,
                          beamWidth, progressCb, cancelledCb);
    }
    if (method === 'hillclimb') {
        const seed = fillDeck(comboDict, library, startCard, targetSize, settings);
        return hillClimb(comboDict, library, seed, settings, progressCb, cancelledCb);
    }
    // Default: "sa" – greedy warm-start → Simulated Annealing
    const seed = fillDeck(comboDict, library, startCard, targetSize, settings);
    return simulatedAnnealing(comboDict, library, seed, settings,
                               saIterations, 0.0, 0.997, progressCb, cancelledCb);
}

// ---------------------------------------------------------------------------
// Try All Cards
// ---------------------------------------------------------------------------

/**
 * For every library card, run fillDeck with that card as start, record score.
 * @returns {Array} sorted by score descending: [{startCard, score, deck}, ...]
 */
export function tryAllCards(comboDict, library, targetSize, settings, progressCb, cancelledCb) {
    const results = [];
    const total = library.length;

    for (let i = 0; i < library.length; i++) {
        if (cancelledCb && cancelledCb()) break;

        const start = _ck(library[i]);
        const deck = fillDeck(comboDict, library, start, targetSize, settings);
        const score = totalDeckScore(comboDict, deck, library, settings);
        results.push({ startCard: start, score, deck });

        if (progressCb) progressCb(i + 1, total, library[i].name);
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Build a name → card object lookup from a library array. */
export function buildNameLookup(library) {
    const map = {};
    for (const card of library) map[card.name] = card;
    return map;
}

/** Build a composite-key → card lookup. Key = name|fused|onyx */
export function buildKeyLookup(library) {
    const map = {};
    for (const card of library) map[_ck(card)] = card;
    return map;
}

/**
 * Build a base-name → max quantity lookup.
 * The cap for any group of same-named variants in the deck equals the
 * highest individual quantity across all variants of that name.
 */
export function buildNameMaxQty(library) {
    const map = {};
    for (const card of library) {
        if (map[card.name] === undefined || card.quantity > map[card.name])
            map[card.name] = card.quantity;
    }
    return map;
}

/** Composite card key used in deck arrays. */
function _ck(c) { return c.name + '|' + (c.fused ? '1' : '0') + '|' + (c.onyx ? '1' : '0'); }

/** Default settings object. */
export function defaultSettings() {
    return {
        mode:    1,     // 1=Sum  2=Attack  3=Defence  4=Heroics
        lcwc:    35,    // Lowest Combo Worth Counting
        sv:      1.0,   // Step Value
        cr:      0.8,   // Copy Reduction
        fb:      2.0,   // Fusion Buff
        ab:      1.5,   // Heroic Attack Buff
        db:      0.5,   // Heroic Defence Buff
        n_cards: 35,    // Cards to fill automatically
    };
}
