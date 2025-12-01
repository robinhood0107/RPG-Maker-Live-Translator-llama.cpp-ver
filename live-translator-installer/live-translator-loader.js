(() => {
    'use strict';

    const SUPPORT_SCRIPTS = [
        'translator.js',
        'logger.js',
        'window-helpers.js',
        'control-code-helpers.js',
        'hooks.js',
        'disk-cache.js',
        'window-draw-hooks.js',
        'translation-manager.js',
        'text-replacement-addon.js',
    ];
    const SUPPORT_FILES = ['translator.json', 'settings.json'];

    function resolveSupportDir(loaderScript) {
        try {
            const base = new URL(loaderScript.src, window.location.href);
            return new URL('./live-translator/', base).href;
        } catch (err) {
            console.error('[LiveTranslatorLoader] Could not resolve support directory:', err);
            return null;
        }
    }

    function injectScript(url) {
        return new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = url;
            tag.async = false;
            tag.onload = resolve;
            tag.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(tag);
        });
    }

    async function loadSupportFiles(supportDir) {
        const assets = {};
        await Promise.all(
            SUPPORT_FILES.map(async (file) => {
                const url = new URL(file, supportDir).href;
                try {
                    const response = await fetch(url);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status} ${response.statusText}`);
                    }
                    const text = await response.text();
                    const lower = file.toLowerCase();
                    if (lower.endsWith('.json')) {
                        assets[file] = {
                            raw: text,
                            json: JSON.parse(text)
                        };
                    } else {
                        assets[file] = { raw: text };
                    }
                    console.log(`[LiveTranslatorLoader] Loaded asset ${file}`);
                } catch (err) {
                    console.warn(`[LiveTranslatorLoader] Could not load asset ${file}:`, err);
                }
            })
        );
        return assets;
    }

    async function bootstrap() {
        if (typeof document === 'undefined') {
            console.error('[LiveTranslatorLoader] No document context available.');
            return;
        }

        const loaderScript = document.currentScript;
        if (!loaderScript || !loaderScript.src) {
            console.error('[LiveTranslatorLoader] document.currentScript unavailable.');
            return;
        }

        if (typeof window === 'undefined') return;
        if (window.LiveTranslatorLoaderBootstrapped) {
            console.log('[LiveTranslatorLoader] Bootstrap already completed, skipping.');
            return;
        }
        window.LiveTranslatorLoaderBootstrapped = true;

        const supportDir = resolveSupportDir(loaderScript);
        if (!supportDir) return;
        if (!window.LiveTranslatorAssets) window.LiveTranslatorAssets = {};

        try {
            const assets = await loadSupportFiles(supportDir);
            Object.assign(window.LiveTranslatorAssets, assets);
            if (assets['translator.json'] && assets['translator.json'].json) {
                window.LiveTranslatorConfig = assets['translator.json'].json;
            }
            if (assets['settings.json'] && assets['settings.json'].json) {
                window.LiveTranslatorSettings = assets['settings.json'].json;
            }
        } catch (err) {
            console.error('[LiveTranslatorLoader] Failed while loading support assets:', err);
            return;
        }

        try {
            for (const script of SUPPORT_SCRIPTS) {
                const url = new URL(script, supportDir).href;
                await injectScript(url);
                console.log(`[LiveTranslatorLoader] Loaded script ${script}`);
            }
            console.log('[LiveTranslatorLoader] All scripts loaded.');
        } catch (err) {
            console.error('[LiveTranslatorLoader] Failed while loading support scripts:', err);
            return;
        }
    }

    bootstrap();
})();
