/**
 * worker.js
 * Web Worker for running heavy deck-optimisation algorithms off the main thread,
 * so the UI stays responsive while algorithms run.
 *
 * Incoming message format:
 *   { type: 'run', job: 'fill'|'advanced'|'hillclimb'|'beam'|'sa'|'try_all',
 *     comboDict, library, startCard, targetSize, settings,
 *     beamWidth?, saIterations? }
 *
 * Outgoing message format:
 *   { type: 'progress',  pct: 0-100, label?: string }
 *   { type: 'done',      result: deck[]  or  results[] }
 *   { type: 'error',     message: string }
 */

import { fillDeck, advancedFill, hillClimb, beamSearch, simulatedAnnealing, tryAllCards } from './engine.js';

let _cancelled = false;

self.onmessage = function (e) {
    const msg = e.data;

    if (msg.type === 'cancel') {
        _cancelled = true;
        return;
    }

    if (msg.type === 'run') {
        _cancelled = false;
        const { job, comboDict, library, startCard, targetSize, settings,
                beamWidth, saIterations } = msg;

        function progressCb(current, total, label) {
            const pct = total > 0 ? Math.round(current / total * 100) : 0;
            self.postMessage({ type: 'progress', pct, label: label || '' });
        }

        function cancelledCb() { return _cancelled; }

        try {
            let result;

            if (job === 'fill') {
                result = fillDeck(comboDict, library, startCard, targetSize, settings, progressCb);
            } else if (job === 'advanced') {
                result = advancedFill(comboDict, library, startCard, targetSize, settings, progressCb);
            } else if (job === 'hillclimb') {
                const seed = fillDeck(comboDict, library, startCard, targetSize, settings);
                result = hillClimb(comboDict, library, seed, settings, progressCb, cancelledCb);
            } else if (job === 'beam') {
                result = beamSearch(comboDict, library, startCard, targetSize, settings,
                                    beamWidth || 5, progressCb, cancelledCb);
            } else if (job === 'sa') {
                const seed = fillDeck(comboDict, library, startCard, targetSize, settings);
                result = simulatedAnnealing(comboDict, library, seed, settings,
                                            saIterations || 8000, 0.0, 0.997,
                                            progressCb, cancelledCb);
            } else if (job === 'try_all') {
                result = tryAllCards(comboDict, library, targetSize, settings,
                                     progressCb, cancelledCb);
            } else {
                throw new Error(`Unknown job type: ${job}`);
            }

            self.postMessage({ type: 'done', result });
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    }
};
