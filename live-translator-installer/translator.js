
(() => {
    'use strict';

    const TRANSLATOR_CONFIG = initializeTranslatorConfig();
    const logger = (() => {
        try {
            if (typeof globalThis !== 'undefined'
                && globalThis.LiveTranslatorModules
                && typeof globalThis.LiveTranslatorModules.createLoggerBundle === 'function') {
                const bundle = globalThis.LiveTranslatorModules.createLoggerBundle({
                    settings: (typeof globalThis.LiveTranslatorSettings === 'object' && globalThis.LiveTranslatorSettings) || {},
                    maxLogsPerFrame: 1000,
                });
                return bundle && bundle.logger ? bundle.logger : console;
            }
        } catch (_) {}
        return console;
    })();

    const TextProcessor = {
        // Unified translator function (DeepL or Local LLM based on config)
        async translateText(text, targetLang = null) {
            try {
                const [first] = await TextProcessor.translateMany([text], targetLang);
                return typeof first === 'string' ? first : '';
            } catch (error) {
                logger.error('Translation error:', error);
                throw error;
            }
        },

        async translateMany(texts, targetLang = null) {
            const items = Array.isArray(texts) ? texts : [texts];
            try {
                // For local LLM, map single-item path directly
                if (TRANSLATOR_CONFIG.provider === 'local') {
                    return Promise.all(items.map((t) => translateOneLocal(String(t), TRANSLATOR_CONFIG.settings.local)));
                }

                // DeepL batch path (preferred)
                return await translateManyDeepL(
                    items.map((t) => String(t)),
                    resolveTargetLang(targetLang),
                    resolveDeepLKey()
                );
            } catch (error) {
                logger.error('Translation error:', error);
                throw error;
            }
        },

        // Main processing function
        process(text, type = 'generic') {
            // Template - add your processing logic here
            console.log(`[SecondaryScript] Processing ${type}: ${text}`);
            return `[${type.toUpperCase()}]`;
        }
    };

    // Helpers
    function resolveDeepLKey() {
        const key = TRANSLATOR_CONFIG
            && TRANSLATOR_CONFIG.settings
            && TRANSLATOR_CONFIG.settings.deepl
            && typeof TRANSLATOR_CONFIG.settings.deepl.apiKey === 'string'
                ? TRANSLATOR_CONFIG.settings.deepl.apiKey.trim()
                : '';
        if (!key) {
            throw new Error('translator.json missing required settings.deepl.apiKey while DeepL provider is active.');
        }
        return key;
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
            throw new Error('translator.json missing required "settings.local.model" field.');
        }
        if (!Number.isFinite(out.port) || out.port <= 0) {
            throw new Error('translator.json has invalid "settings.local.port" (must be a positive number).');
        }

        // Guard optional sampling params: ensure they are finite numbers when present
        for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty']) {
            if (out[key] !== null && !Number.isFinite(out[key])) {
                throw new Error(`translator.json has invalid "settings.local.${key}" (must be a number).`);
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

    function buildLocalMessages(text, systemPrompt) {
        // System must come from config; user message must be text only
        const sys = (systemPrompt ?? '').toString();
        const messages = [];
        if (sys.trim()) messages.push({ role: 'system', content: sys });
        messages.push({ role: 'user', content: String(text) });
        return messages;
    }

    async function translateOneLocal(text, cfg) {
        const url = `http://${cfg.address}:${cfg.port}/v1/chat/completions`;
        const sourceText = String(text ?? '');
        const body = {
            model: cfg.model,
            messages: buildLocalMessages(sourceText, cfg.system_prompt),
            temperature: cfg.temperature,
            top_p: cfg.top_p,
            top_k: cfg.top_k,
            min_p: cfg.min_p,
            repetition_penalty: cfg.repeat_penalty,
            max_tokens: cfg.max_tokens || 256
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
            return sanitized;
        } catch (e) {
            console.error('[Local LLM] Parse error:', e);
            return '';
        }
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

    function initializeTranslatorConfig() {
        const root = getGlobalTranslatorConfig();
        const providerRaw = root && root.provider;
        if (typeof providerRaw !== 'string' || !providerRaw.trim()) {
            throw new Error('translator.json missing required "provider" value.');
        }
        const provider = providerRaw.trim().toLowerCase();
        const settings = root.settings && typeof root.settings === 'object' ? root.settings : {};
        const config = { provider, settings: {} };

        if (provider === 'local') {
            if (!settings.local || typeof settings.local !== 'object') {
                throw new Error('translator.json missing required "settings.local" section for local provider.');
            }
            config.settings.local = normalizeLocalConfig(settings.local);
        } else if (provider === 'deepl') {
            const deeplConfig = normalizeDeepLConfig(settings.deepl);
            if (!deeplConfig.apiKey) {
                throw new Error('translator.json missing required "settings.deepl.apiKey" value for DeepL provider.');
            }
            config.settings.deepl = deeplConfig;
        } else {
            throw new Error(`translator.json contains unsupported provider "${providerRaw}".`);
        }

        if (provider !== 'deepl' && settings.deepl && typeof settings.deepl === 'object') {
            config.settings.deepl = normalizeDeepLConfig(settings.deepl);
        }

        return config;
    }

    function getGlobalTranslatorConfig() {
        if (typeof globalThis === 'undefined' || !globalThis.LiveTranslatorConfig) {
            throw new Error('LiveTranslatorConfig global not found. Ensure translator.json is loaded before translator.js.');
        }
        const cfg = globalThis.LiveTranslatorConfig;
        if (!cfg || typeof cfg !== 'object') {
            throw new Error('LiveTranslatorConfig is not an object.');
        }
        return cfg;
    }

    function normalizeDeepLConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            throw new Error('translator.json missing required "settings.deepl" section.');
        }
        const language = cfg.language || cfg.targetLang || cfg.lang;
        if (typeof language !== 'string' || !language.trim()) {
            throw new Error('translator.json missing required DeepL target language (settings.deepl.language).');
        }
        const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
        return {
            language: language.trim(),
            apiKey
        };
    }

    function resolveTargetLang(overrideLang) {
        if (typeof overrideLang === 'string' && overrideLang.trim()) {
            return overrideLang.trim();
        }
        if (!TRANSLATOR_CONFIG.settings.deepl) {
            throw new Error('DeepL target language unavailable. Check translator.json settings.deepl.');
        }
        return TRANSLATOR_CONFIG.settings.deepl.language;
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
