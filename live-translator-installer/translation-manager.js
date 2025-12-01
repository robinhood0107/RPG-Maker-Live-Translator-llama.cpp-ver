(() => {
    'use strict';

    const globalScope = typeof window !== 'undefined'
        ? window
        : (typeof globalThis !== 'undefined' ? globalThis : Function('return this')());

    if (!globalScope.LiveTranslatorModules) {
        globalScope.LiveTranslatorModules = {};
    }

    function noop() {}

    function defaultPreview(text, max = 48) {
        const s = String(text ?? '').replace(/\s+/g, ' ').trim();
        if (s.length <= max) return s;
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    function ensureTelemetry(telemetry) {
        if (telemetry && typeof telemetry.logTranslation === 'function') {
            return telemetry;
        }
        return {
            logTranslation: () => {},
        };
    }

    function createRateLimiter(options) {
        const dbg = typeof options?.dbg === 'function' ? options.dbg : noop;
        const state = {
            baseIntervalMs: 250,
            maxIntervalMs: 5000,
            intervalMs: 0,
            cooldownUntil: 0,
            lastRunAt: 0,
            queue: [],
            running: false,
        };

        function sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }

        async function processQueue() {
            if (state.running) return;
            state.running = true;
            try {
                while (state.queue.length) {
                    const { task, resolve, reject } = state.queue.shift();
                    const now = Date.now();
                    const timeSinceLast = now - (state.lastRunAt || 0);
                    const waitForInterval = Math.max(0, state.intervalMs - timeSinceLast);
                    const waitForCooldown = Math.max(0, state.cooldownUntil - now);
                    const waitMs = Math.max(waitForInterval, waitForCooldown);
                    if (waitMs > 0) await sleep(waitMs);
                    try {
                        state.lastRunAt = Date.now();
                        const res = await task();
                        if (state.intervalMs === 0) state.intervalMs = state.baseIntervalMs;
                        else state.intervalMs = Math.max(state.baseIntervalMs, Math.floor(state.intervalMs * 0.75));
                        state.cooldownUntil = 0;
                        resolve(res);
                    } catch (err) {
                        try {
                            const is429 = (err && (err.status === 429 || /\b429\b/.test(String(err && err.message))));
                            if (is429) {
                                const retryAfterSec = (err && typeof err.retryAfter !== 'undefined') ? Number(err.retryAfter) : NaN;
                                const retryMs = !Number.isNaN(retryAfterSec) && retryAfterSec > 0
                                    ? Math.min(state.maxIntervalMs, Math.floor(retryAfterSec * 1000))
                                    : Math.min(state.maxIntervalMs, state.intervalMs ? state.intervalMs * 2 : 1000);
                                const jitter = Math.floor(Math.random() * 250);
                                state.intervalMs = Math.max(state.baseIntervalMs, retryMs);
                                state.cooldownUntil = Date.now() + state.intervalMs + jitter;
                                dbg(`[Translate] 429 received. Backing off ~${state.intervalMs}ms`);
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
    }

    function createTranslatorBatcher(options) {
        const {
            textProcessor = null,
            isLocalProvider = false,
            rateLimiter,
            logger = {},
            diag = noop,
        } = options || {};

        const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
        const translateText = textProcessor && typeof textProcessor.translateText === 'function'
            ? textProcessor.translateText.bind(textProcessor)
            : null;
        const translateMany = textProcessor && typeof textProcessor.translateMany === 'function'
            ? textProcessor.translateMany.bind(textProcessor)
            : null;

        const state = { queue: [], running: false };
        const MAX_BATCH_CHARS = 100;

        function takeNextBatch() {
            if (!state.queue.length) return null;
            let chars = 0;
            const items = [];
            while (state.queue.length) {
                const next = state.queue[0];
                const t = String(next.text);
                const len = t.length;
                if (items.length === 0) {
                    items.push(state.queue.shift());
                    chars += len;
                } else {
                    if (chars + len > MAX_BATCH_CHARS) break;
                    items.push(state.queue.shift());
                    chars += len;
                }
            }
            return items;
        }

        async function run() {
            if (state.running) return;
            state.running = true;
            try {
                while (state.queue.length) {
                    const items = takeNextBatch();
                    if (!items || !items.length) break;
                    const texts = items.map((i) => String(i.text));
                    try {
                        if (isLocalProvider) {
                            if (!translateText) {
                                throw new Error('No translateText function available for local provider.');
                            }
                            for (const item of items) {
                                Promise.resolve()
                                    .then(() => translateText(String(item.text)))
                                    .then((res) => { try { item.resolve(typeof res === 'string' ? res : ''); } catch (_) {} })
                                    .catch((err) => { try { item.reject(err); } catch (_) {} });
                            }
                            continue;
                        }

                        if (!rateLimiter || typeof rateLimiter.enqueue !== 'function') {
                            throw new Error('Rate limiter unavailable for remote provider.');
                        }

                        const outputs = await rateLimiter.enqueue(() => {
                            if (translateMany) {
                                return translateMany(texts);
                            }
                            return Promise.all(texts.map((t) => translateText ? translateText(t) : Promise.resolve('')));
                        });

                        for (let i = 0; i < items.length; i++) {
                            const out = outputs && typeof outputs[i] === 'string' ? outputs[i] : '';
                            items[i].resolve(out);
                        }
                    } catch (err) {
                        for (const item of items) {
                            try { item.reject(err); } catch (_) {}
                        }
                    }
                }
            } catch (err) {
                logError('[TranslatorBatcher] run error', err);
            } finally {
                state.running = false;
            }
        }

        function request(text) {
            return new Promise((resolve, reject) => {
                const wasIdle = state.queue.length === 0 && !state.running;
                state.queue.push({ text: String(text), resolve, reject });
                if (wasIdle) run();
            });
        }

        return { request };
    }

    function createTranslationCache(options) {
        const {
            logger = {},
            telemetry,
            diskCache = {},
            preview = defaultPreview,
            getCacheEntryLimit = () => 0,
            pruneMapToLimit = () => {},
            translatorBatcher,
            diag = noop,
        } = options || {};

        const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
        const telemetrySafe = ensureTelemetry(telemetry);
        const disk = diskCache && typeof diskCache === 'object' ? diskCache : { enabled: false };
        let translateSeq = 0;

        const cache = {
            completed: new Map(),
            ongoing: new Map(),
            requestTranslation,
            shouldSkip,
            performTranslation,
        };

        function shouldSkip(text) {
            if (!text) return true;
            const trimmed = String(text).trim();
            if (!trimmed) return true;
            const hasKorean = /[\uAC00-\uD7AF]/u.test(trimmed);
            if (hasKorean) return true;
            const hasJapaneseOrChinese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/u.test(trimmed);
            return !hasJapaneseOrChinese;
        }

        function requestTranslation(text) {
            const normalized = String(text || '').trim();
            telemetrySafe.logTranslation('request', normalized);

            if (cache.completed.has(normalized)) {
                const existing = cache.completed.get(normalized);
                telemetrySafe.logTranslation('cache_hit', normalized, existing);
                return Promise.resolve(existing);
            }

            if (cache.ongoing.has(normalized)) {
                return cache.ongoing.get(normalized);
            }

            telemetrySafe.logTranslation('cache_miss', normalized);
            const translationPromise = cache.performTranslation(normalized);
            cache.ongoing.set(normalized, translationPromise);

            translationPromise
                .then((translated) => {
                    try { cache.ongoing.delete(normalized); } catch (_) {}
                    const limit = getCacheEntryLimit();
                    if (limit > 0) pruneMapToLimit(cache.completed, limit);
                    cache.completed.set(normalized, translated);
                    telemetrySafe.logTranslation('completed', normalized, translated);
                    if (disk.enabled && typeof disk.appendRecord === 'function') {
                        try { disk.appendRecord(normalized, translated); } catch (_) {}
                    }
                    return translated;
                })
                .catch((error) => {
                    const message = error && error.message ? error.message : 'unknown error';
                    telemetrySafe.logTranslation('error', normalized, message);
                    cache.ongoing.delete(normalized);
                    throw error;
                });

            return translationPromise;
        }

        async function performTranslation(text) {
            const normalized = String(text);
            if (cache.shouldSkip(normalized)) {
                telemetrySafe.logTranslation('skip', normalized, 'trivial text (no letters/already translated)');
                return normalized;
            }

            if (!translatorBatcher || typeof translatorBatcher.request !== 'function') {
                const err = new Error('Translator unavailable');
                logError('[Translation] translator unavailable');
                throw err;
            }

            try {
                const id = (++translateSeq) & 0x7FFFFFFF;
                const start = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                diag(`[Translate] #${id} Request | in="${preview(normalized)}"`);
                const result = await translatorBatcher.request(normalized);
                const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                const timing = Math.round(end - start);
                diag(`[Translate] #${id} OK ${timing}ms | out="${preview(result)}"`);
                return result || normalized;
            } catch (err) {
                logError('[Translation Failure]', err);
                diag('[Translate] Failed');
                throw err;
            }
        }

        cache.shouldSkip = shouldSkip;
        cache.requestTranslation = requestTranslation;
        cache.performTranslation = performTranslation;

        return cache;
    }

    globalScope.LiveTranslatorModules.createTranslationManager = function createTranslationManager(options = {}) {
        const {
            logger,
            telemetry,
            diskCache,
            preview,
            getCacheEntryLimit,
            pruneMapToLimit,
            textProcessor,
            isLocalProvider = false,
            dbg,
            diag,
        } = options;

        const rateLimiter = createRateLimiter({ dbg });
        const translatorBatcher = createTranslatorBatcher({
            textProcessor,
            isLocalProvider,
            rateLimiter,
            logger,
            diag,
        });

        const translationCache = createTranslationCache({
            logger,
            telemetry,
            diskCache,
            preview,
            getCacheEntryLimit,
            pruneMapToLimit,
            translatorBatcher,
            diag,
        });

        return { translationCache };
    };
})();
