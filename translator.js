
(() => {
    'use strict';

    // Hardcoded translation config
    const TRANSLATOR_CONFIG = {
        provider: 'local', // 'deepl' | 'local'
        targetLang: 'KO',
        enableTokenCounter: true // crude cumulative token accounting (Qwen-style heuristic)
    };

    const TokenCounter = (() => {
        const enabled = !!TRANSLATOR_CONFIG.enableTokenCounter;
        if (!enabled) {
            return {
                record() {},
                estimateText() { return 0; },
                estimateMessages() { return 0; }
            };
        }

        const totals = { input: 0, output: 0 };

        function record(messages, responseText) {
            if (!enabled) return;
            const inputTokens = estimateMessages(messages);
            const outputTokens = estimateText(responseText);
            totals.input += inputTokens;
            totals.output += outputTokens;
            logTotals();
        }

        function logTotals() {
            const inputMtok = (totals.input / 1000).toFixed(3);
            const outputMtok = (totals.output / 1000).toFixed(3);
            console.log(`[TokenCounter] cumulative input ${inputMtok} MtoK | output ${outputMtok} MtoK`);
        }

        function estimateMessages(messages) {
            if (!Array.isArray(messages)) return 0;
            return messages.reduce((acc, msg) => {
                if (!msg || typeof msg.content !== 'string') return acc;
                return acc + estimateText(msg.content);
            }, 0);
        }

        function estimateText(text) {
            if (!text) return 0;
            const str = String(text);
            let tokens = 0;
            let asciiBuffer = '';
            const totalLength = str.length;

            for (let i = 0; i < totalLength; i++) {
                const ch = str[i];
                const code = str.charCodeAt(i);

                if (code <= 0x7f) {
                    if (/\s/.test(ch)) {
                        if (asciiBuffer) {
                            tokens += asciiChunkTokens(asciiBuffer);
                            asciiBuffer = '';
                        }
                        while (i + 1 < totalLength && /\s/.test(str[i + 1])) {
                            i++;
                        }
                        tokens += 1;
                        continue;
                    }
                    asciiBuffer += ch;
                    continue;
                }

                if (asciiBuffer) {
                    tokens += asciiChunkTokens(asciiBuffer);
                    asciiBuffer = '';
                }
                tokens += nonAsciiTokenWeight(code);
            }

            if (asciiBuffer) {
                tokens += asciiChunkTokens(asciiBuffer);
            }

            return tokens;
        }

        function asciiChunkTokens(chunk) {
            const len = chunk.length;
            if (!len) return 0;
            return Math.max(1, Math.ceil(len / 3));
        }

        function nonAsciiTokenWeight(codePoint) {
            if (
                (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
                (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Extension A
                (codePoint >= 0x20000 && codePoint <= 0x2a6df) || // Extension B
                (codePoint >= 0x2a700 && codePoint <= 0x2b73f) || // Extension C
                (codePoint >= 0x2b740 && codePoint <= 0x2b81f) || // Extension D
                (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) || // Extension E
                (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef) || // Extension F
                (codePoint >= 0x3000 && codePoint <= 0x303f) // CJK symbols / punctuation
            ) {
                return 1;
            }
            return 2;
        }

        return {
            record,
            estimateText,
            estimateMessages
        };
    })();

    const TextProcessor = {
        // Unified translator function (DeepL or Local LLM based on config)
        async translateText(text, targetLang = 'KO', apiKey) {
            try {
                // For local LLM, call the single-item path directly (no translateMany)
                if (TRANSLATOR_CONFIG.provider === 'local') {
                    const localConfig = loadLocalConfig(safeRequire('fs'), safeRequire('path'));
                    return await translateOneLocal(String(text), targetLang, localConfig);
                }

                // Otherwise, use batch path for providers that support it
                const out = await TextProcessor.translateMany([String(text)], targetLang, apiKey);
                return out && out.length ? out[0] : '';
            } catch (error) {
                console.error('Translation error:', error);
                throw error;
            }
        },

        // Unified batch translator; routes to DeepL or Local LLM
        async translateMany(texts, targetLang = TRANSLATOR_CONFIG.targetLang, apiKey) {
            if (!Array.isArray(texts)) throw new Error('translateMany requires an array of texts');

            if (TRANSLATOR_CONFIG.provider === 'local') {
                try {
                    const localConfig = loadLocalConfig(safeRequire('fs'), safeRequire('path'));
                    // Use batched local translation with separator trick
                    return translateManyLocalBatched(texts, targetLang, localConfig);
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    throw new Error(`Local provider error: ${msg}`);
                }
            }

            const deeplKey = resolveDeepLKey(apiKey);
            if (!deeplKey) throw new Error('DeepL provider selected but apikey.txt or provided key is missing.');
            return translateManyDeepL(texts, targetLang, deeplKey);
        },

        // Main processing function
        process(text, type = 'generic') {
            // Template - add your processing logic here
            console.log(`[SecondaryScript] Processing ${type}: ${text}`);
            return `[${type.toUpperCase()}]`;
        }
    };

    // Helpers
    function resolveDeepLKey(apiKeyFromArg) {
        if (typeof apiKeyFromArg === 'string' && apiKeyFromArg.trim()) return apiKeyFromArg.trim();
        const fs = safeRequire('fs');
        const path = safeRequire('path');
        try {
            if (fs && path) {
                const apiKeyPath = path.join(__dirname, 'apikey.txt');
                return fs.readFileSync(apiKeyPath, 'utf8').trim();
            }
        } catch (_) {}
        return null;
    }

    function safeRequire(mod) {
        try { return require(mod); } catch (_) { return null; }
    }

    function loadLocalConfig(fs, path) {
        if (!fs || !path) throw new Error('Filesystem/path modules unavailable.');

        const configPath = path.join(__dirname, 'local.json');
        if (!fs.existsSync(configPath)) {
            throw new Error(`local.json not found. Expected at: ${configPath}`);
        }
        let raw;
        try {
            raw = fs.readFileSync(configPath, 'utf8');
        } catch (e) {
            throw new Error(`Failed to read ${configPath}: ${e && e.message ? e.message : e}`);
        }
        let cfg;
        try {
            cfg = JSON.parse(raw);
        } catch (e) {
            throw new Error(`Failed to parse ${configPath}: ${e && e.message ? e.message : e}`);
        }
        const normalized = normalizeLocalConfig(cfg);
        normalized._configPath = configPath;
        return normalized;
    }

    function normalizeLocalConfig(cfg) {
        const out = {
            address: cfg.Address || cfg.address || '127.0.0.1',
            port: Number(cfg.port || cfg.Port || 1234),
            model: cfg.model || cfg.Model || null,
            system_prompt: cfg.system_prompt || cfg.systemPrompt || cfg.SystemPrompt || '',
            temperature: valueOrDefault(cfg.temperature || cfg.Temperature, 0.2),
            top_k: valueOrDefault(cfg.top_k || cfg.TopK, null),
            repeat_penalty: valueOrDefault(cfg.repeat_penalty || cfg.repeatPenalty || cfg.repetition_penalty, null),
            min_p: valueOrDefault(cfg.min_p || cfg.MinP, null),
            top_p: valueOrDefault(cfg.top_p || cfg.TopP, 0.95)
        };

        if (!out.model || typeof out.model !== 'string' || !out.model.trim()) {
            throw new Error('local.json missing required "model" field.');
        }
        if (!Number.isFinite(out.port) || out.port <= 0) {
            throw new Error('local.json has invalid "port" (must be a positive number).');
        }

        // Guard optional sampling params: ensure they are finite numbers when present
        for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty']) {
            if (out[key] !== null && !Number.isFinite(out[key])) {
                throw new Error(`local.json has invalid "${key}" (must be a number).`);
            }
        }

        return out;
    }

    function valueOrDefault(v, def) {
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    }

    // DeepL implementation (batch)
    async function translateManyDeepL(texts, targetLang, apiKey) {
        try {
            const response = await fetch('https://api-free.deepl.com/v2/translate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `DeepL-Auth-Key ${apiKey}`
                },
                body: JSON.stringify({
                    text: texts.map(t => String(t)),
                    target_lang: targetLang
                })
            });

            if (!response.ok) {
                const err = new Error(`DeepL API error: ${response.status} ${response.statusText}`);
                try { err.status = response.status; } catch (_) {}
                try {
                    const ra = response.headers && response.headers.get ? response.headers.get('Retry-After') : null;
                    if (ra) err.retryAfter = Number(ra);
                } catch (_) {}
                throw err;
            }

            const data = await response.json();
            const arr = (data && Array.isArray(data.translations)) ? data.translations : [];
            return arr.map(o => (o && typeof o.text === 'string') ? o.text : '');
        } catch (error) {
            console.error('Translation error (DeepL):', error);
            throw error;
        }
    }

    // Local LLM (LM Studio OpenAI-compatible) implementation
    async function translateManyLocal(texts, targetLang, cfg) {
        // Send each text independently; preserve input→output order
        const out = [];
        for (const t of texts) {
            const one = await translateOneLocal(String(t), targetLang, cfg);
            out.push(one);
        }
        return out;
    }

    function buildLocalMessages(text, targetLang, systemPrompt) {
        // System must come from config; user message must be text only
        const sys = (systemPrompt ?? '').toString();
        const messages = [];
        if (sys.trim()) messages.push({ role: 'system', content: sys });
        messages.push({ role: 'user', content: String(text) });
        return messages;
    }

    async function translateOneLocal(text, targetLang, cfg) {
        const url = `http://${cfg.address}:${cfg.port}/v1/chat/completions`;
        const sourceText = String(text ?? '');
        const baseTokens = Math.max(1, TokenCounter.estimateText(sourceText) || 0);
        const maxTokens = Math.max(1, Math.ceil(baseTokens * 5));
        const body = {
            model: cfg.model,
            messages: buildLocalMessages(sourceText, targetLang, cfg.system_prompt),
            temperature: cfg.temperature,
            top_p: cfg.top_p,
            top_k: cfg.top_k,
            min_p: cfg.min_p,
            repetition_penalty: cfg.repeat_penalty,
            max_tokens: maxTokens
        };

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (e) {
            throw new Error(`Local LLM request failed: ${e && e.message ? e.message : e}`);
        }

        if (!resp || !resp.ok) {
            const status = resp ? `${resp.status} ${resp.statusText}` : 'no response';
            throw new Error(`Local LLM error: ${status}`);
        }

        const data = await resp.json();
        try {
            // Prefer chat.completions schema
            const choice = data && data.choices && data.choices[0];
            const content = choice && choice.message && typeof choice.message.content === 'string'
                ? choice.message.content
                : (choice && typeof choice.text === 'string' ? choice.text : '');

            // Strip local LLM control codes like <think>...</think>
            const sanitized = sanitizeLocalOutput(String(content || ''));
            TokenCounter.record(body.messages, sanitized);
            return sanitized;
        } catch (e) {
            console.error('[Local LLM] Parse error:', e);
            return '';
        }
    }

    // Batched local translation using a robust separator; falls back to per-item on mismatch/errors
    async function translateManyLocalBatched(texts, targetLang, cfg) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        const inputs = texts.map(t => String(t ?? ''));

        // Pick a short, low-collision separator to reduce token overhead
        const SEP = chooseShortSeparator(inputs);
        const messages = buildLocalBatchMessages(inputs, targetLang, cfg.system_prompt, SEP);
        const combinedTokenEstimate = inputs.reduce((sum, item) => {
            return sum + Math.max(1, TokenCounter.estimateText(item));
        }, 0);
        const maxTokens = Math.max(1, Math.ceil(combinedTokenEstimate * 5));
        const url = `http://${cfg.address}:${cfg.port}/v1/chat/completions`;
        const body = {
            model: cfg.model,
            messages,
            temperature: cfg.temperature,
            top_p: cfg.top_p,
            top_k: cfg.top_k,
            min_p: cfg.min_p,
            repetition_penalty: cfg.repeat_penalty,
            max_tokens: maxTokens
        };

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (_) {
            return translateManyLocalConcurrent(inputs, targetLang, cfg);
        }

        if (!resp || !resp.ok) {
            return translateManyLocalConcurrent(inputs, targetLang, cfg);
        }

        let raw;
        try {
            const data = await resp.json();
            const choice = data && data.choices && data.choices[0];
            raw = choice && choice.message && typeof choice.message.content === 'string'
                ? choice.message.content
                : (choice && typeof choice.text === 'string' ? choice.text : '');
        } catch (_) {
            return translateManyLocalConcurrent(inputs, targetLang, cfg);
        }

        const cleaned = sanitizeLocalOutput(String(raw || ''));
        const parts = cleaned.split(SEP);
        if (parts.length !== inputs.length) {
            return translateManyLocalConcurrent(inputs, targetLang, cfg);
        }
        TokenCounter.record(body.messages, cleaned);
        return parts.map(s => String(s).trim());
    }

    function chooseShortSeparator(texts) {
        const candidates = ['§', '¤', '¶', '<|>', '|||', '\u241F'];
        // Replace the last entry with the actual Unicode Unit Separator symbol
        candidates[candidates.length - 1] = '\u241F';
        for (const tok of candidates) {
            const present = texts.some(t => String(t).includes(tok));
            if (!present) return tok;
        }
        return '|||';
    }

    function buildLocalBatchMessages(texts, targetLang, systemPrompt, sep) {
        const sys = (systemPrompt ?? '').toString();
        const msgs = [];
        if (sys.trim()) msgs.push({ role: 'system', content: sys });
        const instructions = [
            'You are a translation engine. Translate each input segment into the target language precisely.',
            `Inputs are separated by the exact delimiter ${sep}.`,
            'Return exactly the same number of segments, in the same order, joined by the same delimiter.',
            'Do not add explanations or extra text.'
        ].join(' ');
        msgs.push({ role: 'system', content: instructions });
        const combined = texts.join(sep);
        msgs.push({ role: 'user', content: combined });
        return msgs;
    }

    // Remove control-code style XML-ish blocks some local LLMs emit
    function sanitizeLocalOutput(s) {
        if (typeof s !== 'string') return '';
        let out = s;
        // Remove <think> ... </think> blocks (including attributes), case-insensitive, multiline
        out = out.replace(/<\s*think\b[\s\S]*?>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
        // Also remove any self-closing <think .../> just in case
        out = out.replace(/<\s*think\b[\s\S]*?\/>/gi, '');
        // Trim leftover whitespace
        out = out.trim();
        return out;
    }

    // Concurrent variant used by translateMany() for local provider
    async function translateManyLocalConcurrent(texts, targetLang, cfg) {
        const tasks = texts.map(t => translateOneLocal(String(t), targetLang, cfg));
        return Promise.all(tasks);
    }


    // Export for Node.js/NW.js environment
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = TextProcessor;
    }

    // Also make available globally
    if (typeof window !== 'undefined') {
        window.TextProcessor = TextProcessor;
    }

    return TextProcessor;

})();
