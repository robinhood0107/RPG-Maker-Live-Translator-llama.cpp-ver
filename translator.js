
(() => {
    'use strict';

    const TextProcessor = {
        // DeepL translator function
        async translateText(text, targetLang = 'KO', apiKey) {
            if (!apiKey) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const apiKeyPath = path.join(__dirname, 'apikey.txt');
                    apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
                } catch (error) {
                    throw new Error('DeepL API key is required. Create apikey.txt with your API key.');
                }
            }

            try {
                const out = await TextProcessor.translateMany([String(text)], targetLang, apiKey);
                return out && out.length ? out[0] : '';
            } catch (error) {
                console.error('Translation error:', error);
                throw error;
            }
        },
        
        // DeepL batch translator function (multiple texts per request)
        async translateMany(texts, targetLang = 'KO', apiKey) {
            if (!Array.isArray(texts)) throw new Error('translateMany requires an array of texts');
            if (!apiKey) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const apiKeyPath = path.join(__dirname, 'apikey.txt');
                    apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
                } catch (error) {
                    throw new Error('DeepL API key is required. Create apikey.txt with your API key.');
                }
            }

            try {
                // DeepL supports multiple texts in a single request.
                // JSON body uses an array under the "text" field and returns translations in order.
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
                console.error('Translation error:', error);
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
