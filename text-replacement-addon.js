(() => {
    'use strict';
    console.log('TEXT REPLACEMENT ADDON LOADED');

    // Basic settings and debug gates
    const SETTINGS = {
        debug: {
            log: true,            // high-level logs
            diagnostics: true,   // verbose diagnostics
        },
        // Experimental features. Disabled by default.
        // NOTE: PIXI text hooks are entirely untested.
        experimental: {
            pixiTextHooks: true, // intercept PIXI.Text/BitmapText setters (EXPERIMENTAL)
            helpWindowHooks: true, // intercept Window_Help.setText
            bitmapTextHooks: true, // intercept Bitmap.drawText (may receive fragments)
        },
        redraw: {
            extraPadding: 0,      // pixels added around outline (reduced for tighter clears)
            defaultOutline: 0,     // fallback outline width if not found on contents
        }
    };

    // Back to the original working approach but with throttling to prevent slowdown
    const originalConsoleLog = console.log.bind(console);
    
    // Throttle logging to prevent the progressive slowdown
    let logThrottle = 0;
    const maxLogsPerFrame = 5; // Limit logs per animation frame
    
    function forceLog(...args) {
        // Reset throttle counter every animation frame
        if (logThrottle === 0) {
            requestAnimationFrame(() => { logThrottle = 0; });
        }
        
        // Skip if we've hit the limit for this frame
        if (logThrottle >= maxLogsPerFrame) {
            return;
        }
        
        logThrottle++;
        
        try {
            originalConsoleLog(...args);
        } catch (e) {
            // Fallback if console fails
            try { 
                if (window.alert) window.alert(args.join(' ')); 
            } catch (_) {}
        }
    }
    
    // Fast timestamp generation - reuse and update every second
    let fastTimestamp = '';
    let lastTimestampUpdate = 0;
    function getFastTimestamp() {
        const now = Date.now();
        if (now - lastTimestampUpdate > 1000) {
            fastTimestamp = new Date().toISOString().split('T')[1].substring(0, 8); // HH:MM:SS only
            lastTimestampUpdate = now;
        }
        return fastTimestamp;
    }
    
    function dbg(...args) {
        if (SETTINGS.debug.log) {
            forceLog('[DBG]', ...args);
        }
    }
    function diag(...args) {
        if (SETTINGS.debug.diagnostics) {
            forceLog('[DIAG]', ...args);
        }
    }

    // loudCandidate was used during discovery; now disabled
    function loudCandidate(tag, text, info = {}) { /* no-op */ }

    // Global helper to suppress overlapping Bitmap.drawText shortly after a manual redraw
    function addBitmapSuppressionRect(bitmap, x1, y1, x2, y2, durationMs = 200, content = null) {
        try {
            if (!bitmap) return;
            const now = Date.now();
            const rect = { x1: Math.max(0, x1|0), y1: Math.max(0, y1|0), x2: x2|0, y2: y2|0, exp: now + durationMs, content: content ? String(content) : null };
            if (!Array.isArray(bitmap._trSuppressRects)) bitmap._trSuppressRects = [];
            bitmap._trSuppressRects.push(rect);
        } catch (_) {}
    }

    // Robustly remove RPGM escape/control sequences from a resolved string
    function stripRpgmEscapes(str) {
        const s = String(str || '');
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch !== '\x1b') { // not ESC, keep
                out += ch;
                continue;
            }
            // Control code begins: ESC + codeChar
            const code = s[i + 1] || '';
            if (!code) break;
            i++; // consume code char
            // Codes that use bracketed params: C, c, I, i, V, v, N, n, G, g, P, p, S, s, W, w, or any letter followed by [
            if (s[i + 1] === '[') {
                i++; // now at '['
                // skip until matching ']' or end
                while (i + 1 < s.length) {
                    i++;
                    if (s[i] === ']') break;
                }
                continue; // skip the whole escape sequence
            }
            // Single-char escapes (e.g., { } ! | > < ^ $ etc.) — already consumed code; just skip
            // do nothing (skip adding anything)
        }
        return out;
    }

    // Control-code placeholder utilities for drawTextEx
    function prepareTextForTranslation(input) {
        const str = String(input || '');
        const placeholders = [];
        let idx = 0;
        // Match RPGM control codes encoded as ESC + letter + optional [params]
        // Examples: \x1bC[16], \x1bi[1], \x1b{, \x1b}
        const re = /\x1b(?:[A-Za-z{}]|[\$!><\^\|\{\}])(?:\[[^\]]*\])?/g;
        const textForTranslation = str.replace(re, () => {
            const token = `⟦TAG${idx++}⟧`;
            placeholders.push(token);
            return token;
        });
        return { textForTranslation, placeholders };
    }

    function restoreControlCodes(translated, placeholders, original) {
        if (!placeholders || placeholders.length === 0) return translated;
        // Re-scan original for the actual control codes in order
        const codes = [];
        const re = /\x1b(?:[A-Za-z{}]|[\$!><\^\|\{\}])(?:\[[^\]]*\])?/g;
        let m; const src = String(original || '');
        while ((m = re.exec(src)) !== null) {
            codes.push(m[0]);
        }
        let out = String(translated || '');
        placeholders.forEach((token, i) => {
            out = out.replace(token, codes[i] || '');
        });
        return out;
    }

    // Enhanced diagnostics system
    const diagnostics = {
        textDetected: 0,
        textTranslated: 0,
        textDrawn: 0,
        translationRequests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errors: 0,
        startTime: Date.now(),

        // Log text detection with detailed context
        logTextDetected(source, text, x, y, extraInfo = {}) {
            this.textDetected++;
            const timestamp = getFastTimestamp();
            forceLog(`[DETECT|${timestamp}] ${source} at (${x},${y}): "${preview(text)}"`, extraInfo.windowType ? `[${extraInfo.windowType}]` : '');
            if (extraInfo.converted && extraInfo.converted !== text) {
                forceLog(`  └─ Converted: "${preview(extraInfo.converted)}"`);
            }
        },

        // Log translation pipeline events
        logTranslation(event, text, result = null, timing = null) {
            const timestamp = getFastTimestamp();
            switch (event) {
                case 'request':
                    this.translationRequests++;
                    forceLog(`[TRANSLATE|${timestamp}] REQUEST: "${preview(text)}"`);
                    break;
                case 'cache_hit':
                    this.cacheHits++;
                    forceLog(`[TRANSLATE|${timestamp}] CACHE HIT: "${preview(text)}" → "${preview(result)}"`);
                    break;
                case 'cache_miss':
                    this.cacheMisses++;
                    forceLog(`[TRANSLATE|${timestamp}] CACHE MISS: "${preview(text)}" (starting translation...)`);
                    break;
                case 'completed':
                    this.textTranslated++;
                    const timeStr = timing ? ` (${timing}ms)` : '';
                    forceLog(`[TRANSLATE|${timestamp}] COMPLETED${timeStr}: "${preview(text)}" → "${preview(result)}"`);
                    break;
                case 'error':
                    this.errors++;
                    forceLog(`[TRANSLATE|${timestamp}] ERROR: "${preview(text)}" - ${result}`);
                    break;
                case 'skip':
                    forceLog(`[TRANSLATE|${timestamp}] SKIP: "${preview(text)}" - ${result}`);
                    break;
            }
        },

        // Log drawing/redrawing events
        logDraw(event, text, x, y, extraInfo = {}) {
            const timestamp = getFastTimestamp();
            switch (event) {
                case 'original':
                    forceLog(`[DRAW|${timestamp}] ORIGINAL at (${x},${y}): "${preview(text)}"`);
                    break;
                case 'redraw':
                    this.textDrawn++;
                    forceLog(`[DRAW|${timestamp}] REDRAW at (${x},${y}): "${preview(text)}" [${extraInfo.windowType || 'unknown'}]`);
                    if (extraInfo.clearArea) {
                        forceLog(`  └─ Clear: (${extraInfo.clearArea.x},${extraInfo.clearArea.y}) ${extraInfo.clearArea.w}×${extraInfo.clearArea.h}`);
                    }
                    break;
                case 'bypass':
                    forceLog(`[DRAW|${timestamp}] BYPASS at (${x},${y}): "${preview(text)}" (signature detected)`);
                    break;
                case 'queue':
                    forceLog(`[DRAW|${timestamp}] QUEUED at (${x},${y}): "${preview(text)}" (window not ready)`);
                    break;
                case 'skip_same':
                    forceLog(`[DRAW|${timestamp}] SKIP at (${x},${y}): "${preview(text)}" (identical to original)`);
                    break;
            }
        },

        // Show comprehensive stats
        showStats() {
            const runtime = Math.floor((Date.now() - this.startTime) / 1000);
            const cacheTotal = this.cacheHits + this.cacheMisses;
            const hitRate = cacheTotal > 0 ? Math.round((this.cacheHits / cacheTotal) * 100) : 0;
            
            forceLog('═══ TRANSLATION ADDON STATISTICS ═══');
            forceLog(`Runtime: ${runtime}s | Detected: ${this.textDetected} | Translated: ${this.textTranslated} | Drawn: ${this.textDrawn}`);
            forceLog(`Translation Requests: ${this.translationRequests} | Cache Hit Rate: ${hitRate}% (${this.cacheHits}/${cacheTotal})`);
            forceLog(`Errors: ${this.errors} | Active Windows: ${registeredWindows.size} | Cache Size: ${translationCache.completed.size}`);
            if (this.errors > 0 || this.textDetected === 0) {
                forceLog('⚠️  Check for issues if no text detected or high error count');
            }
        }
    };

    // Test debug functions
    console.log('Debug settings:', SETTINGS.debug);
    dbg('DBG function test - this should appear if debug.log is true');
    diag('DIAG function test - this should appear if debug.diagnostics is true');

    // Periodic stats logging
    if (SETTINGS.debug.diagnostics) {
        setInterval(() => {
            diagnostics.showStats();
        }, 30000); // Every 30 seconds
    }

    // Make diagnostics globally accessible for manual inspection
    if (typeof window !== 'undefined') {
        window.translationDiagnostics = diagnostics;
        forceLog('[DIAGNOSTICS] Access stats anytime with: window.translationDiagnostics.showStats()');
    }

    // Helper to create short, single-line previews for logs
    function preview(text, max = 48) {
        const s = String(text).replace(/\s+/g, ' ').trim();
        if (s.length <= max) return s;
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    // Import translator (DeepL helper)
    let textProcessor = null;
    try {
        textProcessor = (typeof window !== 'undefined' && window.TextProcessor)
            ? window.TextProcessor
            : require('./translator.js');
    } catch (e) {
        // Try alternative paths for translator.js
        console.log('Translator script not found at ./translator.js, trying alternative paths...');
        try {
            // Try relative to game root (for www/js/plugins structure)
            textProcessor = require('../../../translator.js');
        } catch (e2) {
            try {
                // Try relative to js root (for js/plugins structure)
                textProcessor = require('../../translator.js');
            } catch (e3) {
                try {
                    // Try absolute path from process working directory
                    const path = require('path');
                    const fs = require('fs');
                    const cwd = process.cwd();
                    const translatorPath = path.join(cwd, 'translator.js');
                    if (fs.existsSync(translatorPath)) {
                        textProcessor = require(translatorPath);
                    } else {
                        throw new Error('translator.js not found in any expected location');
                    }
                } catch (e4) {
                    console.log('Translator script not found in any expected location. Falling back to no-op translation.');
                    console.log('Tried paths: ./translator.js, ../../../translator.js, ../../translator.js, and process.cwd()/translator.js');
                }
            }
        }
    }


    function initializeTextReplacement() {
        console.log('[INIT] Starting text replacement initialization...');
        console.log('[INIT] Window_Base available:', typeof Window_Base !== 'undefined');
        console.log('[INIT] Window_Base.prototype.drawText available:', typeof Window_Base !== 'undefined' && typeof Window_Base.prototype.drawText === 'function');
        
        trackWindowState()
        console.log('[INIT] trackWindowState completed');
        
        trackWindowDrawText()
        console.log('[INIT] trackWindowDrawText completed');
        
        trackGameMessage()
        console.log('[INIT] trackGameMessage completed');
        
        trackChoiceList()
        console.log('[INIT] trackChoiceList completed');

        if (SETTINGS.experimental && SETTINGS.experimental.helpWindowHooks) {
            trackHelpWindow()
        } else {
            diag('[Help] Window_Help.setText hook disabled (experimental flag off)')
        }
        if (SETTINGS.experimental && SETTINGS.experimental.bitmapTextHooks) {
            trackBitmapDrawText()
        } else {
            diag('[Bitmap] drawText hook disabled (experimental flag off)')
        }
        if (SETTINGS.experimental && SETTINGS.experimental.pixiTextHooks) {
            trackPixiText()
        } else {
            diag('[PIXI] text hooks disabled (experimental flag off)')
        }
        
        console.log('[INIT] Text replacement initialization completed');
        
        // Show initial stats
        setTimeout(() => {
            forceLog('═══ TEXT REPLACEMENT ADDON INITIALIZED ═══');
            forceLog('Hooks installed: drawText, drawTextEx, Game_Message.clear, Window_Base.open/close/update');
            if (SETTINGS.experimental.helpWindowHooks) forceLog('Experimental: Window_Help.setText enabled');
            if (SETTINGS.experimental.bitmapTextHooks) forceLog('Experimental: Bitmap.drawText enabled');  
            if (SETTINGS.experimental.pixiTextHooks) forceLog('Experimental: PIXI text hooks enabled');
            // Translation target is determined by translator.js
            forceLog(`Disk cache: ${diskCache.enabled ? 'enabled' : 'disabled'}`);
            diagnostics.showStats();
        }, 1000);
    }

    // contains all windows that are in memory
    // automatically deleted when window is garbage collected
    const windowRegistry = new WeakMap();
    // Store all registered windows for diagnostics purpose only
    const registeredWindows = new Set();
    // Map a contents Bitmap back to its owning Window (used to scope hooks)
    const contentsOwners = new WeakMap();

    // Invisible unicode signature to detect our own redraws
    const REDRAW_SIGNATURE = '\u200B\u200C\u200D\u200B\u200C\u200D\uFEFF\u200B'; // Zero-width chars pattern
    // Additional invisible mark to insert between every translated character to help
    // downstream hooks (e.g., Bitmap) ignore already-translated fragments.
    const PER_CHAR_MARK = '\u2060'; // WORD JOINER

    function markPerChar(text) {
        try {
            const s = String(text);
            if (!s) return s;
            const reCtrl = /(\x1b(?:[A-Za-z{}]|[\$!><\^\|\{\}])(?:\[[^\]]*\])?)/g;
            let out = '';
            let last = 0;
            let m;
            while ((m = reCtrl.exec(s)) !== null) {
                const plain = s.slice(last, m.index);
                if (plain) out += plain.split('').join(PER_CHAR_MARK);
                out += m[0]; // keep control code intact
                last = reCtrl.lastIndex;
            }
            const rest = s.slice(last);
            if (rest) out += rest.split('').join(PER_CHAR_MARK);
            return out;
        } catch (_) { return text; }
    }

    // Disk-backed cache (append-only journal) for translations
    const diskCache = (() => {
        let fs = null, path = null;
        try {
            if (typeof require === 'function') {
                fs = require('fs');
                path = require('path');
            }
        } catch (_) {}

        // Resolve a safe directory for the cache file
        function resolveCacheDir() {
            try { if (typeof __dirname === 'string' && __dirname) return __dirname; } catch (_) {}
            try { if (typeof process !== 'undefined' && process.cwd) return process.cwd(); } catch (_) {}
            try {
                if (typeof document !== 'undefined') {
                    const scripts = document.getElementsByTagName('script');
                    const current = scripts && scripts.length ? scripts[scripts.length - 1] : null;
                    const src = current && current.src;
                    if (src && (src.startsWith('file:') || src.startsWith('http'))) {
                        const u = new URL(src);
                        if (u && u.pathname) {
                            // path may be URL-encoded; decode
                            const p = decodeURIComponent(u.pathname);
                            if (path && typeof path.dirname === 'function') {
                                return path.dirname(p);
                            }
                            return p;
                        }
                    }
                }
            } catch (_) {}
            return null;
        }

        const dir = (fs && path) ? resolveCacheDir() : null;
        const enabled = !!(fs && path && dir && typeof dir === 'string');
        const file = enabled ? path.join(dir, 'translation-cache.log') : null;

        // Serialize appends to avoid interleaving writes
        let queue = Promise.resolve();

        function safeParseLine(line) {
            const t = line && line.trim();
            if (!t) return null;
            try {
                const obj = JSON.parse(t);
                if (obj && typeof obj.in === 'string' && typeof obj.out === 'string') {
                    return obj;
                }
            } catch (_) {}
            return null;
        }

        async function appendRecord(input, output) {
            if (!enabled) return;
            const rec = JSON.stringify({ in: String(input), out: String(output) }) + '\n';
            queue = queue.then(async () => {
                let handle;
                try {
                    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (_) {}
                    handle = await fs.promises.open(file, 'a');
                    await handle.write(rec);
                    try { await handle.sync(); } catch (_) {}
                } finally {
                    try { if (handle) await handle.close(); } catch (_) {}
                }
            }).catch(() => {});
            return queue;
        }

        async function loadAll() {
            if (!enabled) return [];
            try {
                const exists = fs.existsSync(file);
                if (!exists) return [];
                const data = await fs.promises.readFile(file, 'utf8');
                const lines = data.split(/\r?\n/);
                const out = [];
                for (const line of lines) {
                    const obj = safeParseLine(line);
                    if (obj) out.push(obj);
                }
                return out;
            } catch (e) {
                console.error('[DiskCache Load Error]', e);
                return [];
            }
        }

        return { enabled, appendRecord, loadAll };
    })();

    // Global translation cache system
    const translationCache = {
        // Completed translations: text -> translatedText
        completed: new Map(),
        maxCacheSize: 1000, // Prevent unbounded growth
        
        // Ongoing translations: text -> Promise
        // Multiple text entries can share the same promise for the same text
        ongoing: new Map(),

        // Request translation for a text, returns a promise
        requestTranslation(text) {
            const normalizedText = text.trim();
            
            diagnostics.logTranslation('request', normalizedText);
            
            // Check if already translated (cache hit)
            if (this.completed.has(normalizedText)) {
                const translatedText = this.completed.get(normalizedText);
                diagnostics.logTranslation('cache_hit', normalizedText, translatedText);
                return Promise.resolve(translatedText);
            }
            
            // If translation already in progress, return existing promise
            if (this.ongoing.has(normalizedText)) {
                // diag(`[Cache PENDING] "${normalizedText}" - sharing existing request`);
                return this.ongoing.get(normalizedText);
            }
            
            // Start new translation
            diagnostics.logTranslation('cache_miss', normalizedText);
            const translationPromise = this.performTranslation(normalizedText);
            this.ongoing.set(normalizedText, translationPromise);
            
            translationPromise
                .then(translatedText => {
                    // Move from ongoing to completed with size limit
                    this.ongoing.delete(normalizedText);
                    
                    // Prevent unbounded cache growth
                    if (this.completed.size >= this.maxCacheSize) {
                        // Remove oldest entries (simple FIFO)
                        const oldestKeys = Array.from(this.completed.keys()).slice(0, 100);
                        oldestKeys.forEach(key => this.completed.delete(key));
                    }
                    
                    this.completed.set(normalizedText, translatedText);
                    diagnostics.logTranslation('completed', normalizedText, translatedText);
                    try { if (diskCache.enabled) diskCache.appendRecord(normalizedText, translatedText); } catch (_) {}
                    return translatedText;
                })
                .catch(error => {
                    const errorMsg = error && error.message ? error.message : 'unknown error';
                    diagnostics.logTranslation('error', normalizedText, errorMsg);
                    this.ongoing.delete(normalizedText);
                    throw error;
                });
            
            return translationPromise;
        },

        // Should skip translation? True if only whitespace/numbers/symbols
        shouldSkip(text) {
            if (!text) return true;
            const trimmed = String(text).trim();
            if (!trimmed) return true;
            // If there are no Unicode letters in the string, it's trivial
            const hasLetter = /\p{L}/u.test(trimmed);
            if (!hasLetter) return true;
            
            // Check for Korean Hangul characters - skip if found
            const hasKorean = /[\uAC00-\uD7AF]/u.test(trimmed);
            if (hasKorean) {
                return true; // Skip Korean text
            }
            
            // Additional check: only proceed if text contains Japanese or Chinese characters
            // Japanese: Hiragana, Katakana, Kanji (CJK Unified Ideographs)
            // Chinese: CJK Unified Ideographs
            const hasJapaneseOrChinese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/u.test(trimmed);
            return !hasJapaneseOrChinese;
        },

        // Perform actual translation using translator.js (DeepL)
        async performTranslation(text) {
            const normalized = String(text);
            if (this.shouldSkip(normalized)) {
                diagnostics.logTranslation('skip', normalized, 'trivial text (no letters/already translated)');
                return normalized;
            }

            if (textProcessor && (typeof textProcessor.translateText === 'function' || typeof textProcessor.translateMany === 'function')) {
                try {
                    const t0 = performance.now();
                    diag(`[DeepL] Request | in="${preview(normalized)}"`);
                    // Batch-aware request: this queues with other pending texts into a single DeepL call.
                    const out = await deepLBatcher.request(normalized);
                    const t1 = performance.now();
                    const timing = Math.round(t1 - t0);
                    diag(`[DeepL] OK ${timing}ms | out="${preview(out)}"`);
                    return out || normalized;
                } catch (err) {
                    console.error('[DeepL Translation Failure]', err);
                    diag('[DeepL] Failed');
                    // Important: propagate error so callers do NOT cache original
                    throw err;
                }
            }
            // Fallback: no translator available
            const err = new Error('Translator unavailable');
            console.error('[Translation] translator unavailable');
            throw err;
        }
    };

    // Simple adaptive rate limiter with backoff for DeepL requests.
    // Goals:
    // - Do not delay the first request (initial interval=0)
    // - Space subsequent requests (baseIntervalMs)
    // - On 429 or explicit Retry-After, back off adaptively with jitter
    const rateLimiter = (() => {
        const state = {
            baseIntervalMs: 250,     // ~4 req/sec by default
            maxIntervalMs: 5000,     // cap backoff to 5s
            intervalMs: 0,           // start with 0 so first call is immediate
            cooldownUntil: 0,
            lastRunAt: 0,
            queue: [],
            running: false,
        };

        function sleep(ms) {
            return new Promise(r => setTimeout(r, ms));
        }

        async function processQueue() {
            if (state.running) return;
            state.running = true;
            try {
                while (state.queue.length) {
                    const { task, resolve, reject } = state.queue.shift();
                    // Respect spacing and cooldown
                    const now = Date.now();
                    const timeSinceLast = now - (state.lastRunAt || 0);
                    const waitForInterval = Math.max(0, state.intervalMs - timeSinceLast);
                    const waitForCooldown = Math.max(0, state.cooldownUntil - now);
                    const waitMs = Math.max(waitForInterval, waitForCooldown);
                    if (waitMs > 0) await sleep(waitMs);
                    try {
                        state.lastRunAt = Date.now();
                        const res = await task();
                        // On success, lightly decay toward base interval
                        if (state.intervalMs === 0) state.intervalMs = state.baseIntervalMs;
                        else state.intervalMs = Math.max(state.baseIntervalMs, Math.floor(state.intervalMs * 0.75));
                        state.cooldownUntil = 0;
                        resolve(res);
                    } catch (err) {
                        try {
                            // Detect 429 and apply backoff, honoring Retry-After when present
                            const is429 = (err && (err.status === 429 || /\b429\b/.test(String(err && err.message))))
                            if (is429) {
                                const retryAfterSec = (err && typeof err.retryAfter !== 'undefined') ? Number(err.retryAfter) : NaN;
                                const retryMs = !isNaN(retryAfterSec) && retryAfterSec > 0
                                    ? Math.min(state.maxIntervalMs, Math.floor(retryAfterSec * 1000))
                                    : Math.min(state.maxIntervalMs, state.intervalMs ? state.intervalMs * 2 : 1000);
                                const jitter = Math.floor(Math.random() * 250);
                                state.intervalMs = Math.max(state.baseIntervalMs, retryMs);
                                state.cooldownUntil = Date.now() + state.intervalMs + jitter;
                                dbg(`[DeepL] 429 received. Backing off ~${state.intervalMs}ms`);
                            }
                        } catch (_) {}
                        reject(err);
                    }
                }
            } finally {
                state.running = false;
            }
        }

        function enqueue(task) {
            return new Promise((resolve, reject) => {
                state.queue.push({ task, resolve, reject });
                processQueue();
            });
        }

        return { enqueue };
    })();

    // Batch DeepL requests: coalesce multiple texts into one API call using translateMany.
    const deepLBatcher = (() => {
        const groups = new Map(); // key -> { queue: [{ text, resolve, reject }], timer }
        const batchIntervalMs = 30; // short window to collect concurrent requests
        const maxBatchSize = 25;    // conservative per-request batch size

        function keyFor() { return 'default'; }

        function schedule(group) {
            if (group.timer) return;
            group.timer = setTimeout(() => flush(group), batchIntervalMs);
        }

        async function flush(group) {
            group.timer = null;
            if (!group.queue.length) return;
            const items = group.queue.splice(0, maxBatchSize);
            const texts = items.map(i => i.text);
            try {
                const outputs = await rateLimiter.enqueue(() =>
                    (typeof textProcessor.translateMany === 'function'
                        ? textProcessor.translateMany(texts)
                        : textProcessor.translateText(texts[0]).then(t => [t])
                    )
                );
                for (let i = 0; i < items.length; i++) {
                    const out = outputs && typeof outputs[i] === 'string' ? outputs[i] : '';
                    items[i].resolve(out);
                }
            } catch (err) {
                for (const it of items) it.reject(err);
            }
            // If more remain, schedule next flush immediately
            if (group.queue.length) schedule(group);
        }

        function request(text) {
            return new Promise((resolve, reject) => {
                const k = keyFor();
                let g = groups.get(k);
                if (!g) { g = { queue: [], timer: null }; groups.set(k, g); }
                g.queue.push({ text: String(text), resolve, reject });
                if (g.queue.length >= maxBatchSize) {
                    // Flush immediately when reaching max size
                    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
                    // Fire and forget; do not await
                    flush(g);
                } else {
                    schedule(g);
                }
            });
        }

        return { request };
    })();

    function generateKey(type, x, y, windowType = null, text = null) {
        // For choice lists, always include text content to prevent key collisions
        // when multiple items are drawn at same coordinates during layout
        if (windowType === 'Window_ChoiceList' && text) {
            // Use a hash of the text content to keep keys reasonably short
            const textHash = String(text).split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a; // Convert to 32-bit integer
            }, 0);
            return `${type},${x},${y},${Math.abs(textHash)}`;
        }
        return `${type},${x},${y}`;
    }

    function addWindowToRegistry(window, windowData) {
        // Enhanced window data with type information
        windowData.windowType = window.constructor.name;
        windowData.registrationTime = Date.now();
        if (!windowData.recentlyRedrawn) windowData.recentlyRedrawn = new Map();
        windowRegistry.set(window, windowData);
        registeredWindows.add(window);
        try { if (window && window.contents) contentsOwners.set(window.contents, window); } catch (_) {}
        // Remove spammy diagnostic - this gets called constantly
        // diag(`[Window Registry] Added ${windowData.windowType} (${window._uniqueId})`);
    }

    function ensureWindowRegistered(window) {
        let windowData = windowRegistry.get(window);
        
        // Auto-register window if not already registered
        if (!windowData) {
            window._uniqueId = window._uniqueId || Math.random().toString(36).substring(2, 11);
            windowData = { texts: new Map(), isOpen: true, pendingRedraws: new Map(), recentlyRedrawn: new Map() };
            addWindowToRegistry(window, windowData);
        } else if (!windowData.pendingRedraws) {
            // Ensure structure has pendingRedraws for older entries
            windowData.pendingRedraws = new Map();
            if (!windowData.recentlyRedrawn) windowData.recentlyRedrawn = new Map();
        }
        try { if (window && window.contents) contentsOwners.set(window.contents, window); } catch (_) {}
    }

    function addTextToWindowData(windowData, text, x, y, type = null, convertedText = null, originalParams = null) {
        const textToTranslate = convertedText || text;
        const textKey = generateKey(type, x, y, windowData.windowType, textToTranslate);

        // Heuristic: skip trivial stats/counters to avoid infinite detection
        const trimmed = String(textToTranslate || '').trim();
        const nonSpace = trimmed.replace(/\s+/g, '');
        const cjkMatch = trimmed.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g);
        const cjkCount = cjkMatch ? cjkMatch.length : 0;
        const hasDigit = /\d/.test(trimmed);
        const onlyNumPunct = /^[0-9()\[\]\-+/*.,:;!?％%]+$/u.test(nonSpace);
        const looksLikeCounter = (
            hasDigit && (cjkCount <= 1) && nonSpace.length <= 10
        ) || onlyNumPunct || /\d+\s*[\u3040-\u30FF\u4E00-\u9FFF]\s*\(\d+\)/u.test(trimmed);

        if (!trimmed || looksLikeCounter || translationCache.shouldSkip(trimmed)) {
            return; // do not track or translate trivial/noisy text
        }

        // If we already have an entry for this position/type and the text hasn't changed, skip
        const existing = windowData.texts.get(textKey);
        if (existing && existing.rawText === text && existing.convertedText === trimmed) {
            return; // unchanged; avoid re-logging and re-queuing
        }

        // Log text detection only for new/changed text
        diagnostics.logTextDetected(type, trimmed, x, y, {
            converted: convertedText,
            windowType: windowData.windowType || 'unknown'
        });
        
        // At this point, either no entry or text has changed

        // For drawTextEx, pre-process control codes so translator sees only visible text
        let translationSource = textToTranslate;
        let placeholderInfo = null;
        if (type === 'drawTextEx' && convertedText) {
            const prep = prepareTextForTranslation(textToTranslate);
            translationSource = prep.textForTranslation;
            placeholderInfo = { placeholders: prep.placeholders, original: textToTranslate };
        }

        const textEntry = {
            type: type,
            rawText: text,
            convertedText: trimmed,
            translatedText: null,
            translationStatus: "pending", // "pending" | "translating" | "completed" | "error"
            translationPromise: null,
            position: { x, y },
            originalParams: originalParams || {}, // Store original drawing parameters
            timestamp: Date.now(),
            translationSource: translationSource,
            placeholderInfo: placeholderInfo,
        };
        
        windowData.texts.set(textKey, textEntry);
        // Clear any pending redraw queued for an older entry at this position
        try {
            if (!windowData.pendingRedraws) windowData.pendingRedraws = new Map();
            windowData.pendingRedraws.delete(textKey);
        } catch (_) {}
        
        // If we already have this translation cached, mark completed and avoid async redraws
        try {
            const normForCache = String((type === 'drawTextEx' && translationSource) ? translationSource : trimmed).trim();
            if (normForCache && translationCache.completed.has(normForCache)) {
                let trans = translationCache.completed.get(normForCache);
                if (type === 'drawTextEx' && placeholderInfo) {
                    trans = restoreControlCodes(trans, placeholderInfo.placeholders, textToTranslate);
                }
                textEntry.translatedText = trans;
                textEntry.translationStatus = "completed";
                // Do not trigger async redraw here; draw hooks already handle inline drawing on cache hit
                return;
            }
        } catch (_) {}

        // Start translation asynchronously when not cached
        requestTranslationForText(textEntry, translationSource, windowData);
    }

    function requestTranslationForText(textEntry, text, windowData) {
        if (!text || !text.trim()) return;
        
        textEntry.translationStatus = "translating";
        textEntry.translationPromise = translationCache.requestTranslation(text);
        
        textEntry.translationPromise
            .then(translatedText => {
                // Restore control codes if placeholders were used
                const restored = textEntry.placeholderInfo
                    ? restoreControlCodes(translatedText, textEntry.placeholderInfo.placeholders, textEntry.placeholderInfo.original)
                    : translatedText;
                textEntry.translatedText = restored;
                textEntry.translationStatus = "completed";
                textEntry.translationTimestamp = Date.now();
                dbg(`[Text Updated] "${text}" -> "${restored}"`);
                
                // Skip redraw if original and translated text are the same
                if (text.trim() === translatedText) {
                    dbg(`[Translation Skip] Original and translated text are identical: "${preview(text)}"`);
                    return;
                }
                
                // Find the window object and redraw
                redrawTranslatedText(textEntry, windowData);
            })
            .catch(error => {
                console.error(`[Text Translation Error] for "${text}":`, error);
                // Mark error but do NOT set translatedText to original to avoid cache/display contamination
                textEntry.translationStatus = "error";
            });
    }

    function redrawTranslatedText(textEntry, windowData) {
        try {
            // Find the window object that owns this windowData
            let targetWindow = null;
            registeredWindows.forEach(window => {
                if (windowRegistry.get(window) === windowData) {
                    targetWindow = window;
                }
            });

            if (!targetWindow) {
                diag(`[Redraw Skip] Window not found for entry at (${textEntry.position.x},${textEntry.position.y})`);
                return;
            }

            // Consider window 'ready' when visible, has contents, and either isOpen() or fully open
            const hasContents = !!targetWindow.contents;
            const isVisible = !!targetWindow.visible;
            const isOpenFn = (typeof targetWindow.isOpen === 'function') ? targetWindow.isOpen() : true;
            const fullyOpen = typeof targetWindow.openness === 'number' ? targetWindow.openness >= 255 : true;
            const windowReady = isVisible && hasContents && (isOpenFn || fullyOpen);

            if (!windowReady) {
                const textKey = generateKey(textEntry.type, textEntry.position.x, textEntry.position.y, windowData.windowType, textEntry.convertedText);
                const data = windowRegistry.get(targetWindow);
                if (data) {
                    if (!data.pendingRedraws) data.pendingRedraws = new Map();
                    data.pendingRedraws.set(textKey, textEntry);
                    // Log queue only once per entry to avoid spam
                    if (!textEntry._queueLogged) {
                        diagnostics.logDraw('queue', textEntry.translatedText || textEntry.convertedText,
                                          textEntry.position.x, textEntry.position.y,
                                          { windowType: targetWindow.constructor.name });
                        textEntry._queueLogged = true;
                    }
                }
                return;
            }


            // Check if this entry is still the active one for this position
            const textKey = generateKey(textEntry.type, textEntry.position.x, textEntry.position.y, windowData.windowType, textEntry.convertedText);
            const currentEntry = windowData.texts.get(textKey);
            if (!currentEntry) {
                console.log(`[Redraw Skip] Text was already cleared by game`);
                return;
            }
            if (currentEntry !== textEntry) {
                dbg(`[Redraw Skip] Outdated entry at (${textEntry.position.x},${textEntry.position.y})`);
                return;
            }

            const { x, y } = textEntry.position;
            const originalText = textEntry.convertedText;
            const translatedText = textEntry.translatedText || textEntry.convertedText;
            
            // Skip replacement if original and translated text are the same
            if (originalText === translatedText) {
                diagnostics.logDraw('skip_same', originalText, x, y, { windowType: targetWindow.constructor.name });
                return;
            }
            
            // Skip redraw for choice lists - they're handled at a higher level via makeCommandList hook
            if (windowData.windowType === 'Window_ChoiceList') {
                // Log once per window instance to avoid spam
                if (!windowData._choiceSkipLogged) {
                    dbg(`[Choice] Skipping low-level redraw for choice list - handled by makeCommandList hook`);
                    windowData._choiceSkipLogged = true;
                }
                return;
            }

            // Add our invisible signature to prevent reprocessing (no per-char marks to avoid layout issues)
            const signedText = REDRAW_SIGNATURE + translatedText;

            // Track cleared rectangle for diagnostics (used in logs below)
            let clearArea = null;

            // Normal window clear logic
            if (targetWindow.contents) {
                const outline = Math.max(0, (targetWindow.contents && typeof targetWindow.contents.outlineWidth === 'number'
                    ? targetWindow.contents.outlineWidth
                    : SETTINGS.redraw.defaultOutline));

                let clearX = x;
                let clearY = y;
                let clearW = 0;
                let clearH = targetWindow.lineHeight();

                if (textEntry.type === 'drawText') {
                    // Clear only the union of original and translated text glyph bounds per alignment
                    const params = textEntry.originalParams || {};
                    const align = params.align || 'left';
                    const contentsWidth = (typeof targetWindow.contentsWidth === 'function')
                        ? targetWindow.contentsWidth()
                        : (targetWindow.contents ? targetWindow.contents.width : 0);
                    const avail = Math.max(0, (params.maxWidth && params.maxWidth > 0) ? params.maxWidth : (contentsWidth - x));

                    const widthOf = (t) => Math.ceil(targetWindow.textWidth(String(t)));
                    const wOrig = widthOf(originalText);
                    const wNew  = widthOf(translatedText);

                    const startFor = (w) => {
                        if (align === 'center') return x + Math.max(0, Math.floor((avail - w) / 2));
                        if (align === 'right')  return x + Math.max(0, (avail - w));
                        return x; // left
                    };

                    const sxOrig = startFor(wOrig);
                    const exOrig = sxOrig + wOrig;
                    const sxNew  = startFor(wNew);
                    const exNew  = sxNew + wNew;

                    const sx = Math.min(sxOrig, sxNew);
                    const ex = Math.max(exOrig, exNew);

                    clearX = sx;
                    clearW = Math.max(0, ex - sx);

                    // Use a tighter height based on font size rather than full lineHeight
                    const fontSize = (targetWindow.contents && typeof targetWindow.contents.fontSize === 'number' && targetWindow.contents.fontSize > 0)
                        ? Math.ceil(targetWindow.contents.fontSize)
                        : (typeof targetWindow.standardFontSize === 'function' ? Math.ceil(targetWindow.standardFontSize()) : targetWindow.lineHeight());
                    const hBase = Math.min(targetWindow.lineHeight(), fontSize);
                    const yOffset = Math.max(0, Math.floor((targetWindow.lineHeight() - hBase) / 2));
                    clearY = y + yOffset;
                    clearH = hBase;

                } else if (textEntry.type === 'drawTextEx') {
                    // Measure both original and translated text extents to clear sufficiently
                    const sizeFor = (txt) => {
                        try {
                            if (typeof targetWindow.textSizeEx === 'function') {
                                const sz = targetWindow.textSizeEx(String(txt));
                                return { w: Math.ceil(sz.width || 0), h: Math.ceil(sz.height || targetWindow.lineHeight()) };
                            }
                        } catch (e) { /* ignore measure errors */ }
                        // Fallback approximate
                        return { w: Math.ceil(targetWindow.textWidth(String(txt))), h: targetWindow.lineHeight() };
                    };

                    // Use raw text for original (so control codes are considered), translated has no control codes
                    const origSize = sizeFor(textEntry.rawText || originalText);
                    const transSize = sizeFor(translatedText);
                    clearW = Math.max(origSize.w, transSize.w);
                    // Use measured height; avoid inflating to full lineHeight when not necessary
                    clearH = Math.max(origSize.h, transSize.h);
                }

                // Add padding to cover outlines/shadows and fractional positions
                clearX = Math.floor(clearX - outline - SETTINGS.redraw.extraPadding);
                clearY = Math.floor(clearY - outline - SETTINGS.redraw.extraPadding);
                clearW = Math.ceil(clearW + outline * 2 + SETTINGS.redraw.extraPadding * 2);
                clearH = Math.ceil(clearH + outline * 2 + SETTINGS.redraw.extraPadding * 2);

                // Clamp to contents bounds
                const maxW = targetWindow.contents ? targetWindow.contents.width : clearW;
                const maxH = targetWindow.contents ? targetWindow.contents.height : clearH;
                const clampedX = Math.max(0, clearX);
                const clampedY = Math.max(0, clearY);
                const clampedW = Math.max(0, Math.min(clearW, maxW - clampedX));
                const clampedH = Math.max(0, Math.min(clearH, maxH - clampedY));

                targetWindow.contents.clearRect(clampedX, clampedY, clampedW, clampedH);
                clearArea = { x: clampedX, y: clampedY, w: clampedW, h: clampedH };
            }
            
            // Log the successful redraw with all context
            diagnostics.logDraw('redraw', translatedText, x, y, {
                windowType: targetWindow.constructor.name,
                clearArea: clearArea
            });
            
            // Remove pending marker if present
            try {
                const data = windowRegistry.get(targetWindow);
                if (data && data.pendingRedraws) data.pendingRedraws.delete(textKey);
            } catch (_) {}

            // Call the appropriate draw method with signed translated text using original parameters
            if (textEntry.type === 'drawText') {
                const params = textEntry.originalParams;
                const maxWidth = params.maxWidth !== undefined ? params.maxWidth : 0;
                const align = params.align !== undefined ? params.align : 'left';
                targetWindow.drawText(signedText, x, y, maxWidth, align);
            } else if (textEntry.type === 'drawTextEx') {
                targetWindow.drawTextEx(signedText, x, y);
            }

            // After drawing, install a suppression rect on the contents bitmap
            try {
                const bmp = targetWindow.contents;
                if (bmp && clearArea && clearArea.w > 0 && clearArea.h > 0) {
                    addBitmapSuppressionRect(bmp, clearArea.x, clearArea.y, clearArea.x + clearArea.w, clearArea.y + clearArea.h, 120, translatedText);
                }
            } catch (_) {}

            // Mark recently redrawn to avoid immediate duplicate inline draws for this slot
            try {
                const rrKey = generateKey(textEntry.type, x, y, windowData.windowType, textEntry.convertedText);
                const data = windowRegistry.get(targetWindow);
                if (data) {
                    if (!data.recentlyRedrawn) data.recentlyRedrawn = new Map();
                    data.recentlyRedrawn.set(rrKey, Date.now());
                }
            } catch (_) {}
            
        } catch (error) {
            console.error(`[Redraw Error]`, error);
        }
    }

    function trackWindowState() {
        const originalWindowOpen = Window_Base.prototype.open;
        const originalWindowClose = Window_Base.prototype.close;

        Window_Base.prototype.open = function () {
            this._uniqueId = this._uniqueId || Math.random().toString(36).substring(2, 11);
            // Preserve existing data if any, but mark as open
            const existing = windowRegistry.get(this);
            const data = existing || { texts: new Map(), isOpen: true, pendingRedraws: new Map() };
            data.isOpen = true;
            if (!data.pendingRedraws) data.pendingRedraws = new Map();
            addWindowToRegistry(this, data);
            return originalWindowOpen.call(this);
        };

        Window_Base.prototype.close = function () {
            const existing = windowRegistry.get(this);
            const data = existing || { texts: new Map(), isOpen: false, pendingRedraws: new Map() };
            data.isOpen = false;
            if (!data.pendingRedraws) data.pendingRedraws = new Map();
            windowRegistry.set(this, data);
            return originalWindowClose.call(this);
        };

        // Apply pending redraws once window becomes visible/open again
        const originalWindowUpdate = Window_Base.prototype.update;
        Window_Base.prototype.update = function() {
            const res = originalWindowUpdate.call(this);
            try {
                const data = windowRegistry.get(this);
                if (!data || !data.pendingRedraws || data.pendingRedraws.size === 0) return res;
                const ready = this.visible && this.isOpen() && this.contents;
                if (!ready) return res;


                // Normal window processing
                const keys = Array.from(data.pendingRedraws.keys());
                for (const key of keys) {
                    const entry = data.pendingRedraws.get(key);
                    if (!entry) { data.pendingRedraws.delete(key); continue; }
                    // Drop if a newer entry replaced it
                    const current = data.texts.get(key);
                    if (current !== entry) { data.pendingRedraws.delete(key); dbg(`[Redraw Queue Drop] replaced at ${key}`); continue; }
                    if (entry.translationStatus === 'completed' && entry.translatedText) {
                        redrawTranslatedText(entry, data);
                    } else {
                        // Not completed anymore (e.g., superseded); drop
                        data.pendingRedraws.delete(key); dbg(`[Redraw Queue Drop] not completed at ${key}`);
                    }
                }
            } catch (e) {
                console.error('[Window_Base.update Hook Error]', e);
            }
            return res;
        };

    }

    // Apply pending GameMessage redraw once window becomes ready
    try {
        if (typeof Window_Message !== 'undefined') {
            const _origMsgUpdate = Window_Message.prototype.update;
            Window_Message.prototype.update = function() {
                const r = _origMsgUpdate.call(this);
                try {
                    const pending = this._trPendingRedraw;
                    if (pending && this.visible && this.isOpen() && this.contents) {
                        if (this._trSessionId === pending.sessionId) {
                            try { this.contents.clear(); } catch (e) {}
                            if (typeof this.resetFontSettings === 'function') this.resetFontSettings();
                            let startX = 0;
                            try {
                                if (typeof this.newLineX === 'function') startX = this.newLineX();
                                else if (typeof this.textPadding === 'function') startX = this.textPadding();
                            } catch (e) { startX = (typeof this.textPadding === 'function') ? this.textPadding() : 0; }
                            const signed = REDRAW_SIGNATURE + pending.text;
                            this._trBypassProcessCharacter = (this._trBypassProcessCharacter || 0) + 1;
                            try {
                                this.drawTextEx(signed, startX, 0);
                                if (this._textState) this._textState.index = this._textState.text.length;
                                this._showFast = true;
                                this._lineShowFast = true;
                            } finally {
                                this._trBypassProcessCharacter = Math.max(0, (this._trBypassProcessCharacter || 1) - 1);
                            }
                        }
                        this._trPendingRedraw = null;
                    }
                } catch (e) { console.warn('[Window_Message.update pending redraw error]', e); }
                return r;
            };
        }
    } catch (e) { console.warn('[Init] Window_Message update hook error', e); }

    function trackWindowDrawText() {
        console.log('[HOOK INSTALL] Installing drawText hooks...');
        console.log('[HOOK INSTALL] Window_Base:', typeof Window_Base);
        console.log('[HOOK INSTALL] Window_Base.prototype:', typeof Window_Base !== 'undefined' ? typeof Window_Base.prototype : 'undefined');
        console.log('[HOOK INSTALL] drawText method:', typeof Window_Base !== 'undefined' && Window_Base.prototype ? typeof Window_Base.prototype.drawText : 'undefined');
        
        // DrawText
        const originalDrawText = Window_Base.prototype.drawText;
        console.log('[HOOK INSTALL] Original drawText saved:', typeof originalDrawText);

        Window_Base.prototype.drawText = function (text, x, y, maxWidth, align) {
            // Convert text to string if it isn't already (numbers, etc.)
            const textStr = String(text);
            
            // Check if this is our own redraw - if so, skip tracking and strip signature
            if (textStr.startsWith(REDRAW_SIGNATURE)) {
                const cleanText = textStr.substring(REDRAW_SIGNATURE.length);
                diagnostics.logDraw('bypass', cleanText, x, y, { windowType: this.constructor.name });
                return originalDrawText.call(this, cleanText, x, y, maxWidth, align);
            }

            // Early skip for trivial counters to reduce noise
            const trimmed = textStr.trim();
            const nonSpace = trimmed.replace(/\s+/g, '');
            const cjkMatch = trimmed.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g);
            const cjkCount = cjkMatch ? cjkMatch.length : 0;
            const hasDigit = /\d/.test(trimmed);
            const onlyNumPunct = /^[0-9()\[\]\-+/*.,:;!?％%]+$/u.test(nonSpace);
            const looksLikeCounter = (
                hasDigit && (cjkCount <= 1) && nonSpace.length <= 10
            ) || onlyNumPunct || /\d+\s*[\u3040-\u30FF\u4E00-\u9FFF]\s*\(\d+\)/u.test(trimmed);
            ensureWindowRegistered(this);
            let windowData = windowRegistry.get(this);

            // If this is a duplicate of the last seen at this slot, avoid logging/queueing
            if (trimmed) {
                const dupKey = generateKey('drawText', x, y, windowData.windowType, trimmed);
                const existing = windowData.texts.get(dupKey);
                if (existing && existing.rawText === textStr && existing.convertedText === trimmed) {
                    // If we already have a completed translation, opportunistically redraw
                    if (existing.translationStatus === 'completed' && existing.translatedText) {
                        try { redrawTranslatedText(existing, windowData); } catch (_) {}
                    }
                    return originalDrawText.call(this, text, x, y, maxWidth, align);
                }
            }

            if (!trimmed || looksLikeCounter || translationCache.shouldSkip(trimmed)) {
                return originalDrawText.call(this, text, x, y, maxWidth, align);
            }

            // Log original text being drawn
            diagnostics.logDraw('original', trimmed, x, y, { 
                windowType: this.constructor.name,
                method: 'drawText',
                maxWidth: maxWidth,
                align: align
            });

            // Save original parameters for redraw
            const originalParams = { maxWidth, align };
            addTextToWindowData(windowData, trimmed, x, y, "drawText", null, originalParams)
            // If translation already cached, draw translated inline unless we just redrew this slot
            try {
                const norm = trimmed;
                if (translationCache.completed.has(norm)) {
                    const translated = translationCache.completed.get(norm);
                    const key = generateKey('drawText', x, y, windowData.windowType, trimmed);
                    const rr = windowData.recentlyRedrawn && windowData.recentlyRedrawn.get ? windowData.recentlyRedrawn.get(key) : null;
                    if (rr && Date.now() - rr < 200) {
                        // Recently redrawn by us; avoid immediate duplicate inline draw
                        return originalDrawText.call(this, textStr, x, y, maxWidth, align);
                    }
                    // Skip replacement if original and translated text are the same
                    if (norm === translated) {
                        dbg(`[DrawText Skip] Original and translated text are identical: "${preview(norm)}"`);
                        return originalDrawText.call(this, textStr, x, y, maxWidth, align);
                    }
                    const signed = REDRAW_SIGNATURE + translated;
                    return originalDrawText.call(this, signed, x, y, maxWidth, align);
                }
            } catch (_) {}
            // If translation exists in our entry (e.g., after reopen), apply via redraw
            try {
                const key = generateKey('drawText', x, y, windowData.windowType, trimmed);
                const entry = windowData.texts.get(key);
                if (entry && entry.translationStatus === 'completed' && entry.translatedText) {
                    redrawTranslatedText(entry, windowData);
                }
            } catch (_) {}
            // Remove expensive diagnostic call from every draw
            // showTextDiagnostics();

            return originalDrawText.call(this, text, x, y, maxWidth, align);
        };

        // DrawTextEx
        const originalDrawTextEx = Window_Base.prototype.drawTextEx;

        Window_Base.prototype.drawTextEx = function (text, x, y) {
            // Convert text to string if it isn't already (numbers, etc.)
            const textStr = String(text);
            
            // Check if this is our own redraw - if so, skip tracking and strip signature
            if (textStr.startsWith(REDRAW_SIGNATURE)) {
                const cleanText = textStr.substring(REDRAW_SIGNATURE.length);
                diagnostics.logDraw('bypass', cleanText, x, y, { windowType: this.constructor.name });
                // Set a re-entrancy bypass so createTextState doesn't re-trigger translation
                this._trBypassCreateTextState = (this._trBypassCreateTextState || 0) + 1;
                try {
                    return originalDrawTextEx.call(this, cleanText, x, y);
                } finally {
                    this._trBypassCreateTextState = Math.max(0, (this._trBypassCreateTextState || 1) - 1);
                }
            }

            // Early skip for trivial counters to reduce noise
            const trimmed = textStr.trim();
            const nonSpace = trimmed.replace(/\s+/g, '');
            const cjkMatch = trimmed.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g);
            const cjkCount = cjkMatch ? cjkMatch.length : 0;
            const hasDigit = /\d/.test(trimmed);
            const onlyNumPunct = /^[0-9()\[\]\-+/*.,:;!?％%]+$/u.test(nonSpace);
            const looksLikeCounter = (
                hasDigit && (cjkCount <= 1) && nonSpace.length <= 10
            ) || onlyNumPunct || /\d+\s*[\u3040-\u30FF\u4E00-\u9FFF]\s*\(\d+\)/u.test(trimmed);
            ensureWindowRegistered(this);
            let windowData = windowRegistry.get(this);

            // If duplicate at this slot, avoid re-logging/queueing
            if (trimmed) {
                const dupKey = generateKey('drawTextEx', x, y, windowData.windowType, trimmed);
                const existing = windowData.texts.get(dupKey);
                if (existing && existing.rawText === textStr && existing.convertedText === trimmed) {
                    if (existing.translationStatus === 'completed' && existing.translatedText) {
                        try { redrawTranslatedText(existing, windowData); } catch (_) {}
                    }
                    return originalDrawTextEx.call(this, text, x, y);
                }
            }

            if (!trimmed || looksLikeCounter || translationCache.shouldSkip(trimmed)) {
                return originalDrawTextEx.call(this, text, x, y);
            }

            // Log original text being drawn
            diagnostics.logDraw('original', trimmed, x, y, { 
                windowType: this.constructor.name,
                method: 'drawTextEx'
            });

            // Convert escape characters to get the final display text
            const convertedText = this.convertEscapeCharacters(trimmed);
            // Prepare a control-code-free string for translation/cache lookups
            const prep = prepareTextForTranslation(convertedText);
            // DrawTextEx doesn't have additional parameters like maxWidth/align
            const originalParams = {};
            addTextToWindowData(windowData, trimmed, x, y, "drawTextEx", convertedText, originalParams)
            // If translation already cached (using control-code-free text), draw translated inline
            try {
                const norm = String(prep.textForTranslation || trimmed).trim();
                if (translationCache.completed.has(norm)) {
                    const translated = translationCache.completed.get(norm);
                    const restored = restoreControlCodes(translated, prep.placeholders, convertedText);
                    const key = generateKey('drawTextEx', x, y, windowData.windowType, convertedText || trimmed);
                    const rr = windowData.recentlyRedrawn && windowData.recentlyRedrawn.get ? windowData.recentlyRedrawn.get(key) : null;
                    if (rr && Date.now() - rr < 200) {
                        // Recently redrawn by us; avoid immediate duplicate inline draw
                        return originalDrawTextEx.call(this, textStr, x, y);
                    }
                    // Skip replacement if original and translated text are the same
                    if (convertedText === restored) {
                        dbg(`[DrawTextEx Skip] Original and translated text are identical: "${preview(norm)}"`);
                        return originalDrawTextEx.call(this, textStr, x, y);
                    }
                    const signed = REDRAW_SIGNATURE + restored;
                    return originalDrawTextEx.call(this, signed, x, y);
                }
            } catch (_) {}
            // If translation exists in our entry (e.g., after reopen), apply via redraw
            try {
                const key = generateKey('drawTextEx', x, y, windowData.windowType, convertedText || trimmed);
                const entry = windowData.texts.get(key);
                if (entry && entry.translationStatus === 'completed' && entry.translatedText) {
                    redrawTranslatedText(entry, windowData);
                }
            } catch (_) {}
            // Remove expensive diagnostic call from every draw
            // showTextDiagnostics();

            return originalDrawTextEx.call(this, text, x, y);
        };
        
        console.log('[HOOK INSTALL] drawText and drawTextEx hooks installed successfully');
    }

    function trackChoiceList() {
        try {
            if (typeof Window_ChoiceList === 'undefined' || !Window_ChoiceList || !Window_ChoiceList.prototype) {
                diag('[Choice] Window_ChoiceList not found, skipping choice list hooks');
                return;
            }

            // Hook makeCommandList to capture and translate choice texts before rendering
            const originalMakeCommandList = Window_ChoiceList.prototype.makeCommandList;
            Window_ChoiceList.prototype.makeCommandList = function() {
                // Call original to populate choices
                const result = originalMakeCommandList.call(this);

                try {
                    // Capture and translate choice texts
                    if (this._list && Array.isArray(this._list)) {
                        for (let i = 0; i < this._list.length; i++) {
                            const choice = this._list[i];
                            if (choice && choice.name && typeof choice.name === 'string') {
                                const originalText = choice.name;
                                const norm = originalText.trim();

                                // Skip if trivial or already translated
                                if (translationCache.shouldSkip(norm)) continue;

                                // Use cached translation if available
                                if (translationCache.completed.has(norm)) {
                                    const translated = translationCache.completed.get(norm);
                                    if (norm !== translated) {
                                        choice.name = translated;
                                        diagnostics.logTranslation('cache_hit', norm, translated);
                                        dbg(`[Choice] Applied cached translation: "${norm}" → "${translated}"`);
                                    }
                                    continue;
                                }

                                // Start async translation for uncached items
                                translationCache.requestTranslation(norm)
                                    .then(translated => {
                                        if (norm !== translated && this._list && this._list[i] && this._list[i].name === originalText) {
                                            this._list[i].name = translated;
                                            dbg(`[Choice] Applied async translation: "${norm}" → "${translated}"`);
                                            // Refresh the choice list to show translation
                                            if (this.visible && this.isOpen() && typeof this.refresh === 'function') {
                                                this.refresh();
                                            }
                                        }
                                    })
                                    .catch(err => {
                                        dbg(`[Choice] Translation failed for: "${norm}"`, err);
                                    });
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Choice makeCommandList Hook Error]', e);
                }

                return result;
            };

            dbg('[Choice] Hooked Window_ChoiceList.makeCommandList');
        } catch (e) {
            console.error('[Choice Hook Error]', e);
        }
    }

    function trackGameMessage() {
        // Custom $gameMessage state tracker - independent of window lifecycle
        const gameMessageState = {
            currentText: '',
            isActive: false,
            lastUpdate: 0,
            session: 0 // increments to invalidate pending translations
        };

        // Prefer hooking startMessage to get full resolved text once
        const originalStartMessage = Window_Message.prototype.startMessage;
        Window_Message.prototype.startMessage = function() {
            try {
                // Begin a new session
                gameMessageState.session++;
                gameMessageState.isActive = true;
                gameMessageState.lastUpdate = Date.now();
                this._trMessageSession = gameMessageState.session;
                this._trStartedThisSession = true;
                this._trSentTranslateThisSession = false;

                // Resolve message into final renderable string then strip control codes
                const rawAll = $gameMessage && $gameMessage.allText ? $gameMessage.allText() : '';
                const resolved = typeof this.convertEscapeCharacters === 'function' ? this.convertEscapeCharacters(String(rawAll)) : String(rawAll);
                const visible = stripRpgmEscapes(resolved);

                const finalText = visible.trim();
                if (finalText && finalText !== gameMessageState.currentText) {
                    gameMessageState.currentText = finalText;
                    diag(`[GameMessage] Final rendered text: "${preview(finalText)}"`);
                    // Kick off translation once per message
                    if (!this._trSentTranslateThisSession) {
                        this._trSentTranslateThisSession = true;
                        this.processCompleteMessage(finalText, gameMessageState.session);
                    }
                }
            } catch (e) { console.warn('[GameMessage startMessage hook error]', e); }
            return originalStartMessage.call(this);
        };

        // Hook Window_Message.prototype.processCharacter only as a fallback
        const originalProcessCharacter = Window_Message.prototype.processCharacter;
        Window_Message.prototype.processCharacter = function(textState) {
            // If we're drawing our own translated text, bypass translation logic
            if (this._trBypassProcessCharacter && this._trBypassProcessCharacter > 0) {
                return originalProcessCharacter.call(this, textState);
            }

            // If startMessage already handled this session, skip accumulation to avoid truncation issues
            if (gameMessageState.isActive && this._trStartedThisSession && this._trMessageSession === gameMessageState.session) {
                return originalProcessCharacter.call(this, textState);
            }

            // Get the current character being processed
            const char = textState.text[textState.index];
            if (!char) {
                return originalProcessCharacter.call(this, textState);
            }

            // Build up the full text as it's being processed
            if (!this._trCurrentMessageText) {
                this._trCurrentMessageText = '';
                this._trMessageSession = ++gameMessageState.session;
                gameMessageState.isActive = true;
                gameMessageState.lastUpdate = Date.now();
            }

            // Add this character to our accumulated text
            if (char !== '\x1b') { // Ignore escape character sequences
                this._trCurrentMessageText += char;
            }

            const result = originalProcessCharacter.call(this, textState);

            // If this is the last character or we've reached a good stopping point
            if (textState.index >= textState.text.length - 1) {
                const finalText = this._trCurrentMessageText.trim();
                if (finalText && finalText !== gameMessageState.currentText) {
                    gameMessageState.currentText = finalText;
                    diag(`[GameMessage] Final rendered text: "${preview(finalText)}"`);
                    
                    // Start translation for the complete text
                    this.processCompleteMessage(finalText, this._trMessageSession);
                }
                // Reset for next message
                this._trCurrentMessageText = '';
            }

            return result;
        };

        // Process complete message text for translation
        Window_Message.prototype.processCompleteMessage = function(text, sessionId) {
            if (!text || translationCache.shouldSkip(text)) {
                diag(`[GameMessage] Skipping translation: "${preview(text)}"`);
                return;
            }

            this._trSessionId = sessionId;
            
            translationCache.requestTranslation(text)
                .then(translated => {
                    // Check if session is still valid
                    if (this._trSessionId !== sessionId || !gameMessageState.isActive) {
                        diag(`[GameMessage] Session expired for: "${preview(text)}"`);
                        return;
                    }

                    if (text === translated) {
                        dbg(`[GameMessage Skip] Original and translated text are identical: "${preview(text)}"`);
                        return;
                    }

                    dbg(`[GameMessage] Translation: "${preview(text)}" -> "${preview(translated)}"`);

                    // Clear and redraw with translation, or queue until window is ready
                    const ready = this.contents && this.visible && this.isOpen();
                    if (!ready) {
                        this._trPendingRedraw = { text: translated, sessionId };
                        return;
                    }

                    try { this.contents.clear(); } catch (e) {}
                    if (typeof this.resetFontSettings === 'function') this.resetFontSettings();

                    let startX = 0;
                    try {
                        if (typeof this.newLineX === 'function') {
                            startX = this.newLineX();
                        } else if (typeof this.textPadding === 'function') {
                            startX = this.textPadding();
                        }
                    } catch (e) {
                        // Fallback if newLineX() fails due to uninitialized state
                        console.warn('[GameMessage] newLineX() failed, using fallback:', e);
                        startX = (typeof this.textPadding === 'function') ? this.textPadding() : 0;
                    }

                    // Use signature to prevent re-processing
                        const signed = REDRAW_SIGNATURE + translated;
                        this._trBypassProcessCharacter = (this._trBypassProcessCharacter || 0) + 1;
                        try {
                            this.drawTextEx(signed, startX, 0);
                        // Force completion
                        if (this._textState) {
                            this._textState.index = this._textState.text.length;
                        }
                        this._showFast = true;
                        this._lineShowFast = true;
                    } finally {
                        this._trBypassProcessCharacter = Math.max(0, (this._trBypassProcessCharacter || 1) - 1);
                    }
                })
                .catch(err => {
                    console.error('[GameMessage Translation Error]', err);
                });
        };

        // Hook $gameMessage.clear() - when message is cleared/becomes invisible
        const originalClear = Game_Message.prototype.clear;
        Game_Message.prototype.clear = function() {
            const result = originalClear.call(this);
            
            // Update our state tracker
            gameMessageState.currentText = '';
            gameMessageState.isActive = false;
            gameMessageState.lastUpdate = Date.now();
            gameMessageState.session++; // invalidate pending translations
            try {
                const wm = SceneManager && SceneManager._scene && SceneManager._scene._messageWindow;
                if (wm) {
                    wm._trStartedThisSession = false;
                    wm._trSentTranslateThisSession = false;
                }
            } catch (_) {}
            
            diag('$gameMessage.clear() - Message cleared');
            showGameMessageDiagnostics();
            
            return result;
        };

        function showGameMessageDiagnostics() {
            if (!SETTINGS.debug.diagnostics) return;
            console.log('=== GAME MESSAGE DIAGNOSTICS ===');
            const status = gameMessageState.isActive ? 'ACTIVE' : 'CLEARED';
            const timestamp = new Date(gameMessageState.lastUpdate).toLocaleTimeString();
            
            console.log(`GameMessage [${status}|${timestamp}]`);
            if (gameMessageState.currentText) {
                console.log(`   Final text: "${gameMessageState.currentText}"`);
            } else {
                console.log('   (No text)');
            }
        }
    }

    function showTextDiagnostics() {
        // let disable = true; // implement global settings later
        // if (disable) return;

        if (!SETTINGS.debug.diagnostics) return;
        console.log('=== SCREEN TEXT DIAGNOSTICS ===');
        
        let totalTexts = 0;
        let displayedWindows = 0;
        
        // Clean up stale window references (garbage collected objects)
        registeredWindows.forEach(window => {
            if (!windowRegistry.has(window)) {
                registeredWindows.delete(window);
            }
        });
        
        registeredWindows.forEach((window) => {
            const windowData = windowRegistry.get(window);
            
            if (!windowData || !windowData.isOpen || windowData.texts.size === 0) {
                return;
            }
            
            displayedWindows++;
            const texts = [];
            const textTypes = [];
            const positions = [];
            const timestamps = [];
            
            windowData.texts.forEach((textData) => {
                texts.push(textData.rawText);
                textTypes.push(textData.type);
                positions.push(`(${textData.position.x},${textData.position.y})`);
                timestamps.push(new Date(textData.timestamp).toLocaleTimeString());
                totalTexts++;
            });
            
            // First line: Window info with metadata including latest timestamp
            const status = windowData.isOpen ? 'OPEN' : 'CLOSED';
            const visible = window.visible ? 'VIS' : 'HID';
            const textCount = windowData.texts.size;
            const types = [...new Set(textTypes)].join(',');
            const latestTimestamp = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 'N/A';
            
            console.log(`${displayedWindows}: ${window.constructor.name} [${status}|${visible}|${textCount}txt|${types}|${latestTimestamp}] (obj#${window._uniqueId || 'no-id'})`);
            
            // Second line: Texts
            console.log(`   ${texts.join(' | ')}`);
            
            // Third line: Show converted text if any differ from raw text
            const convertedTexts = [];
            let hasConversions = false;
            windowData.texts.forEach((textData) => {
                if (textData.convertedText !== textData.rawText) {
                    convertedTexts.push(textData.convertedText);
                    hasConversions = true;
                } else {
                    convertedTexts.push(''); // placeholder for alignment
                }
            });
            
            if (hasConversions) {
                console.log(`   [Converted: ${convertedTexts.filter(t => t).join(' | ')}]`);
            }

            // Fourth line: Show translation status and results
            const translationInfo = [];
            let hasTranslations = false;
            windowData.texts.forEach((textData) => {
                const status = textData.translationStatus || 'none';
                if (status !== 'none' && status !== 'pending') {
                    hasTranslations = true;
                    if (status === 'completed' && textData.translatedText) {
                        translationInfo.push(`${status}:"${textData.translatedText}"`);
                    } else {
                        translationInfo.push(status);
                    }
                } else {
                    translationInfo.push(''); // placeholder for alignment
                }
            });
            
            if (hasTranslations) {
                console.log(`   [Translation: ${translationInfo.filter(t => t).join(' | ')}]`);
            }
        });
        
        console.log(`Total windows: ${displayedWindows}, Total texts: ${totalTexts}`);
    }

    // Hook PIXI.Text and PIXI.BitmapText to capture whole-string text assignments
    // NOTE: This is EXPERIMENTAL and currently UNTESTED. Hidden behind a flag.
    function trackPixiText() {
        try {
            const PIXIObj = (typeof window !== 'undefined') ? (window.PIXI || window.Pixi || window.pixi) : null;
            if (!PIXIObj) { diag('[PIXI] Not found, skipping PIXI text hooks'); return; }

            const safeFindDescriptor = (proto, prop) => {
                let obj = proto;
                while (obj && obj !== Object.prototype) {
                    const d = Object.getOwnPropertyDescriptor(obj, prop);
                    if (d) return { owner: obj, desc: d };
                    obj = Object.getPrototypeOf(obj);
                }
                return null;
            };

            const installSetterHook = (Ctor, label) => {
                if (!Ctor || !Ctor.prototype) return false;
                const found = safeFindDescriptor(Ctor.prototype, 'text');
                if (!found || typeof found.desc.set !== 'function') {
                    diag(`[PIXI] ${label}.text setter not found; skipping`);
                    return false;
                }

                const originalSetter = found.desc.set;
                const originalGetter = found.desc.get || function() { return this._text; };

                // Avoid double-installation
                if (found.desc && found.desc._trWrapped) return true;

                Object.defineProperty(found.owner, 'text', {
                    configurable: true,
                    enumerable: found.desc.enumerable,
                    get: originalGetter,
                    set: function(v) {
                        // candidate logging disabled
                        try {
                            const textStr = String(v);

                            // Bypass when our signature is present
                            if (textStr.startsWith(REDRAW_SIGNATURE)) {
                                const clean = textStr.substring(REDRAW_SIGNATURE.length);
                                return originalSetter.call(this, clean);
                            }

                            // Skip trivial strings (numbers, whitespace, symbols only)
                            if (translationCache.shouldSkip(textStr)) {
                                return originalSetter.call(this, textStr);
                            }

                            const norm = textStr.trim();

                            // Synchronous cache hit path
                            try {
                                if (translationCache.completed.has(norm)) {
                                    const translated = translationCache.completed.get(norm);
                                    // Skip replacement if original and translated text are the same
                                    if (norm === translated) {
                                        dbg(`[PIXI Skip] Original and translated text are identical: "${preview(norm)}"`);
                                        return originalSetter.call(this, textStr);
                                    }
                            const signed = REDRAW_SIGNATURE + translated;
                            return originalSetter.call(this, signed);
                                }
                            } catch (_) {}

                            // Async path: set original now; when translation completes and still current, update
                            this._trTextVersion = (this._trTextVersion | 0) + 1;
                            const version = this._trTextVersion;
                            originalSetter.call(this, textStr);
                            translationCache.requestTranslation(norm)
                                .then(translated => {
                                    try {
                                        if (this._trTextVersion !== version) return; // superseded
                                        // Skip replacement if original and translated text are the same
                                        if (norm === translated) {
                                            dbg(`[PIXI Async Skip] Original and translated text are identical: "${preview(norm)}"`);
                                            return;
                                        }
                                        const signed = REDRAW_SIGNATURE + translated;
                                        originalSetter.call(this, signed);
                                    } catch (e) {
                                        // ignore update errors
                                    }
                                })
                                .catch(() => { /* keep original on failure */ });
                        } catch (e) {
                            try { return originalSetter.call(this, v); } catch (_) {}
                        }
                    }
                });

                // Mark wrapper for idempotency (stored on descriptor is not portable; keep a symbol on Ctor)
                try { Ctor.prototype.__trTextWrapped = true; } catch (_) {}
                dbg(`[PIXI] Hooked ${label}.text setter`);
                return true;
            };

            let hookedAny = false;
            try { hookedAny = installSetterHook(PIXIObj.Text, 'PIXI.Text') || hookedAny; } catch (_) {}
            try { hookedAny = installSetterHook(PIXIObj.BitmapText, 'PIXI.BitmapText') || hookedAny; } catch (_) {}
            if (!hookedAny) diag('[PIXI] No text classes hooked');
        } catch (e) {
            console.error('[PIXI Hook Error]', e);
        }
    }

    // EXPERIMENTAL: Hook Bitmap.drawText as a broad catch-all.
    // WARNING: This may receive character- or fragment-level strings from some engines/plugins.
    // Strategy: Only substitute when the translation cache already has a value; otherwise queue translation
    // and draw the original to avoid layout disruption. Hidden behind an experimental flag.
    function trackBitmapDrawText() {
        try {
            if (typeof Bitmap === 'undefined' || !Bitmap || !Bitmap.prototype) { diag('[Bitmap] not found'); return; }
            const original = Bitmap.prototype.drawText;
            if (typeof original !== 'function') return;

            // Aggregate short fragments drawn on the same bitmap line into a full string.
            const aggMap = new WeakMap(); // Bitmap -> { lines: Map<yKey, LineAgg> }
            const Y_TOL = 2; // pixels tolerance to treat as same line
            const JOIN_PAD = 3; // pixels allowed gap/overlap between glyphs
            const FLUSH_DELAY = 50; // ms to wait for more fragments before translating
            const supMap = new WeakMap(); // Bitmap -> Array<{x1,y1,x2,y2,exp}>
            const fullLineMap = new WeakMap(); // Bitmap -> Map<yKey, { x1, x2, content, exp }>

            function yKeyFor(y) { return String(Math.round(Number(y) || 0)); }

            function getAgg(bitmap) {
                let a = aggMap.get(bitmap);
                if (!a) { a = { lines: new Map() }; aggMap.set(bitmap, a); }
                return a;
            }

            function scheduleFlush(bitmap, key, line) {
                if (line.timer) clearTimeout(line.timer);
                line.timer = setTimeout(() => flushLine(bitmap, key, line), FLUSH_DELAY);
            }

            function flushLine(bitmap, key, line) {
                try {
                    if (!line || !line.items || line.items.length === 0) return;
                    // Order by x and build string
                    line.items.sort((a,b)=>a.x-b.x);
                    const text = line.items.map(it => it.text).join('');
                    const norm = text.trim();
                    if (!norm || translationCache.shouldSkip(norm)) { line.items = []; return; }

                    const minX = line.items[0].x;
                    const maxX = Math.max(...line.items.map(it => it.x + it.w));
                    const width = Math.max(0, maxX - minX);
                    const y = line.y;
                    const h = Math.max(Number(line.lineHeight) || 0, bitmap.fontSize || 24);

                    // Cache path: immediate substitute
                    if (translationCache.completed.has(norm)) {
                        const translated = translationCache.completed.get(norm);
                        if (translated && translated !== norm) {
                            try { bitmap.clearRect(Math.max(0,minX-1), Math.max(0,y-1), width+2, h+2); } catch (_) {}
                            const signed = REDRAW_SIGNATURE + translated;
                            try { 
                                const r = original.call(bitmap, signed, minX, y, width, h, 'left');
                                line.recentFlush = { x1: minX, x2: maxX, t: Date.now() };
                                // Install suppression rect to ignore overlapping residual fragments briefly
                                const rects = supMap.get(bitmap) || [];
                                rects.push({ x1: Math.max(0,minX-1), y1: Math.max(0,y-1), x2: maxX+1, y2: y + Math.max(1,h) - 1, exp: Date.now() + 120, content: String(translated) });
                                supMap.set(bitmap, rects);
                                return r;
                            } finally { line.items = []; }
                        }
                        line.items = []; return;
                    }

                    // Async path: draw original now (already drawn), request translation, then clear+redraw when ready
                    translationCache.requestTranslation(norm)
                        .then(translated => {
                            try {
                                if (!translated || translated === norm) { line.items = []; return; }
                                try { bitmap.clearRect(Math.max(0,minX-1), Math.max(0,y-1), width+2, h+2); } catch (_) {}
                                const signed = REDRAW_SIGNATURE + translated;
                                original.call(bitmap, signed, minX, y, width, h, 'left');
                                line.recentFlush = { x1: minX, x2: maxX, t: Date.now() };
                                const rects = supMap.get(bitmap) || [];
                                rects.push({ x1: Math.max(0,minX-1), y1: Math.max(0,y-1), x2: maxX+1, y2: y + Math.max(1,h) - 1, exp: Date.now() + 120, content: String(translated) });
                                supMap.set(bitmap, rects);
                            } catch (_) {}
                        })
                        .catch(()=>{})
                        .finally(()=>{ line.items = []; });
                } catch (_) {
                    try { line.items = []; } catch (_) {}
                }
            }

            Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
                try {
                    const textStr = String(text);
                    if (!textStr) return original.apply(this, arguments);

                    // candidate logging disabled

                    // Track full translated lines we just drew (signed) to suppress substring tails
                    if (textStr.startsWith(REDRAW_SIGNATURE)) {
                        const clean = textStr.substring(REDRAW_SIGNATURE.length);
                        try {
                            const yKey = yKeyFor(y);
                            let map = fullLineMap.get(this);
                            if (!map) { map = new Map(); fullLineMap.set(this, map); }
                            let w = 0; try { w = Math.ceil(this.measureTextWidth(clean)); } catch (_) { w = (clean.length * ((this.fontSize||24)*0.6))|0; }
                            const x1 = Number(x)||0;
                            const x2 = x1 + Math.max(1, w);
                            map.set(yKey, { x1, x2, content: clean, exp: Date.now() + 300 });
                        } catch (_) {}
                        // Proceed to draw clean signed text as usual below (fallthrough handled later)
                    } else {
                        // Before drawing any non-signed fragment, suppress if it is a substring of a recent full line on same y
                        try {
                            const yKey = yKeyFor(y);
                            const map = fullLineMap.get(this);
                            if (map && map.has(yKey)) {
                                const rec = map.get(yKey);
                                if (rec && rec.exp > Date.now()) {
                                    const t = (textStr.trim() || textStr);
                                    const isSub = rec.content && rec.content.indexOf(t) !== -1;
                                    if (isSub) {
                                        // Also ensure x overlap is plausible
                                        let w = 0; try { w = Math.ceil(this.measureTextWidth(t)); } catch (_) { w = (t.length * ((this.fontSize||24)*0.6))|0; }
                                        const rx1 = Number(x)||0, rx2 = rx1 + Math.max(1, w);
                                        const overlaps = !(rx2 < rec.x1 - JOIN_PAD || rx1 > rec.x2 + JOIN_PAD);
                                        if (overlaps) {
                                            return; // skip tail fragment
                                        }
                                    }
                                } else if (rec && rec.exp <= Date.now()) {
                                    map.delete(yKey);
                                }
                            }
                        } catch (_) {}
                    }

                    // Exclude message window contents: let Window_Message pipeline handle it exclusively
                    try {
                        const owner = contentsOwners.get(this);
                        if (owner && owner.constructor && owner.constructor.name === 'Window_Message') {
                            return original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                        }
                    } catch (_) {}

                    // Suppress overlapping draws right after a translated flush (avoid ABCDEFG tails)
                    if (!textStr.startsWith(REDRAW_SIGNATURE)) {
                        try {
                            // Collect suppression rects from local map and any window-level requests
                            let rects = supMap.get(this);
                            if (!Array.isArray(rects)) rects = [];
                            if (Array.isArray(this._trSuppressRects) && this._trSuppressRects.length) {
                                rects = rects.concat(this._trSuppressRects);
                            }
                            if (Array.isArray(rects) && rects.length) {
                                const now = Date.now();
                                // remove expired
                                for (let i = rects.length - 1; i >= 0; i--) {
                                    if (rects[i].exp <= now) rects.splice(i,1);
                                }
                                // also prune bitmap._trSuppressRects
                                if (Array.isArray(this._trSuppressRects)) {
                                    for (let i = this._trSuppressRects.length - 1; i >= 0; i--) {
                                        if (this._trSuppressRects[i].exp <= now) this._trSuppressRects.splice(i,1);
                                    }
                                }
                                // approximate width for overlap test
                                let wEst = 0;
                                try { wEst = Math.ceil(this.measureTextWidth(textStr.trim() || textStr)); } catch (_) { wEst = (textStr.length * ((this.fontSize||24)*0.6))|0; }
                                const x1 = Number(x)||0, y1 = Number(y)||0;
                                const x2 = x1 + Math.max(1, wEst);
                                const y2 = y1 + Math.max(1, Number(lineHeight)|| (this.fontSize||24));
                                for (const r of rects) {
                                    const overlaps = !(x2 < r.x1 || x1 > r.x2 || y2 < r.y1 || y1 > r.y2);
                                    if (!overlaps) continue;
                                    const ttrim = (textStr.trim() || textStr);
                                    const tlen = ttrim.length;
                                    // Suppress if very short, or if it looks like a suffix/subpart of the just-drawn line
                                    const content = r.content || '';
                                    const isSubpart = content && (content.indexOf(ttrim) !== -1);
                                    const relativeShort = content ? (tlen <= Math.max(4, Math.floor(content.length / 3))) : false;
                                    if (tlen <= 3 || isSubpart || relativeShort) {
                                        return; // skip overlapping residual draw
                                    }
                                }
                            }
                        } catch (_) {}
                    }

                    // Bypass our own signed strings
                    if (textStr.startsWith(REDRAW_SIGNATURE)) {
                        const clean = textStr.substring(REDRAW_SIGNATURE.length);
                        return original.call(this, clean, x, y, maxWidth, lineHeight, align);
                    }

                    // Ignore already-translated strings marked with per-character guard
                    if (textStr.indexOf(PER_CHAR_MARK) !== -1) {
                        return original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                    }

                    // Aggregate very short fragments drawn on same line (likely forming a word)
                    const trimmed = textStr.trim();
                    const isShort = trimmed.length <= 2;
                    const alignLefty = !align || align === 'left';
                    if (isShort && alignLefty) {
                        const agg = getAgg(this);
                        const key = yKeyFor(y);
                        let line = agg.lines.get(key);
                        if (!line) { line = { y: Math.round(Number(y)||0), items: [], lastX: Number(x)||0, lastW: 0, lineHeight: lineHeight||24, timer: null }; agg.lines.set(key, line); }

                        // Measure width to decide adjacency
                        let w = 0;
                        try { w = Math.ceil(this.measureTextWidth(trimmed)); } catch (_) { w = (trimmed.length * ((this.fontSize||24)*0.6))|0; }
                        const xi = Number(x)||0;

                        // If we've just flushed this line region, skip drawing overlapping leftover fragments
                        try {
                            if (line.recentFlush && Date.now() - line.recentFlush.t < 200) {
                                if (xi >= (line.recentFlush.x1 - JOIN_PAD) && xi <= (line.recentFlush.x2 + JOIN_PAD)) {
                                    return; // suppress duplicate fragment after flush
                                }
                            }
                        } catch (_) {}

                        // If gap is large (new run), flush existing line first
                        if (line.items.length>0) {
                            const expectedNextX = line.lastX + line.lastW;
                            if (Math.abs(xi - expectedNextX) > Math.max(JOIN_PAD, Math.floor(w*0.3))) {
                                // Different run; flush old then start new
                                if (line.timer) clearTimeout(line.timer);
                                flushLine(this, key, line);
                                line = { y: Math.round(Number(y)||0), items: [], lastX: xi, lastW: w, lineHeight: lineHeight||24, timer: null };
                                agg.lines.set(key, line);
                            }
                        }

                        line.items.push({ x: xi, text: trimmed, w });
                        line.lastX = xi;
                        line.lastW = w;
                        scheduleFlush(this, key, line);
                        // Draw original immediately; translation will clear/replace soon
                        return original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                    }

                    const norm = textStr.trim();
                    if (!norm || translationCache.shouldSkip(norm)) {
                        return original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                    }

                    // Cache hit path: safe to substitute synchronously
                    try {
                        if (translationCache.completed.has(norm)) {
                            const translated = translationCache.completed.get(norm);
                            // Skip replacement if original and translated text are the same
                            if (norm === translated) {
                                dbg(`[Bitmap Skip] Original and translated text are identical: "${preview(norm)}"`);
                                return original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                            }
                            const signed = REDRAW_SIGNATURE + translated;
                            return original.call(this, signed, x, y, maxWidth, lineHeight, align);
                        }
                    } catch (_) {}

                    // Miss: draw original, request translation for future draws
                    const res = original.call(this, textStr, x, y, maxWidth, lineHeight, align);
                    translationCache.requestTranslation(norm).catch(() => {});
                    return res;
                } catch (e) {
                    console.error('[Bitmap.drawText Hook Error]', e);
                    return original.apply(this, arguments);
                }
            };
            dbg('[Bitmap] Hooked Bitmap.drawText');
        } catch (e) {
            console.error('[Bitmap Hook Error]', e);
        }
    }

    

    // Hook Window_Help.setText to capture full descriptions (items, skills, etc.)
    // Very common and whole-string; integrates with cache and signature bypass.
    function trackHelpWindow() {
        try {
            if (typeof Window_Help === 'undefined' || !Window_Help || !Window_Help.prototype) return;
            const originalSetText = Window_Help.prototype.setText;
            if (typeof originalSetText !== 'function') return;

            Window_Help.prototype.setText = function(text) {
                try {
                    const textStr = String(text);

                    // Bypass if already signed
                    if (textStr.startsWith(REDRAW_SIGNATURE)) {
                        const clean = textStr.substring(REDRAW_SIGNATURE.length);
                        return originalSetText.call(this, clean);
                    }

                    // Prefer translating after escape conversion for better context
                    let converted = textStr;
                    try { converted = this.convertEscapeCharacters(textStr); } catch (_) {}

                    const norm = String(converted || textStr).trim();
                    if (!norm || translationCache.shouldSkip(norm)) {
                        return originalSetText.call(this, textStr);
                    }

                    // Cache hit: apply translated immediately
                    try {
                        if (translationCache.completed.has(norm)) {
                            const translated = translationCache.completed.get(norm);
                            // Skip replacement if original and translated text are the same
                            if (norm === translated) {
                                dbg(`[Help Skip] Original and translated text are identical: "${preview(norm)}"`);
                                return originalSetText.call(this, textStr);
                            }
                            const signed = REDRAW_SIGNATURE + translated;
                            return originalSetText.call(this, signed);
                        }
                    } catch (_) {}

                    // Async path: set original now, then update when ready if unchanged
                    this._trHelpVersion = (this._trHelpVersion | 0) + 1;
                    const version = this._trHelpVersion;
                    const self = this;
                    const res = originalSetText.call(this, textStr);
                    translationCache.requestTranslation(norm)
                        .then(translated => {
                            try {
                                if (self._trHelpVersion !== version) return; // superseded by newer setText
                                // Skip replacement if original and translated text are the same
                                if (norm === translated) {
                                    dbg(`[Help Async Skip] Original and translated text are identical: "${preview(norm)}"`);
                                    return;
                                }
                                const signed = REDRAW_SIGNATURE + translated;
                                originalSetText.call(self, signed);
                            } catch (_) { /* ignore */ }
                        })
                        .catch(() => { /* keep original on failure */ });
                    return res;
                } catch (e) {
                    console.error('[Window_Help.setText Hook Error]', e);
                    return originalSetText.call(this, text);
                }
            };
            dbg('[Help] Hooked Window_Help.setText');
        } catch (e) {
            console.error('[Help Hook Error]', e);
        }
    }

    // Initialize after game engine loads
    window.addEventListener('load', () => {
        const hydrateFromDisk = async () => {
            try {
                if (!diskCache.enabled) return;
                const records = await diskCache.loadAll();
                for (const rec of records) {
                    if (rec && typeof rec.in === 'string' && typeof rec.out === 'string') {
                        translationCache.completed.set(rec.in.trim(), rec.out);
                    }
                }
                dbg(`[DiskCache] Loaded ${records.length} records`);
            } catch (e) {
                console.error('[DiskCache Hydrate Error]', e);
            }
        };

        hydrateFromDisk().finally(() => {
            setTimeout(initializeTextReplacement, 100);
        });
    });
    
    // Also try immediate initialization in case window.load already fired
    if (document.readyState === 'complete') {
        setTimeout(initializeTextReplacement, 100);
    }

})();
