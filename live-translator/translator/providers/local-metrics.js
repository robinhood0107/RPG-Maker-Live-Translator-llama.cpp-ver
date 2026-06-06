// Local provider throughput metrics writer.
// Records one JSONL event per local LLM response plus a model-level cumulative summary.
(() => {
    'use strict';

    const globalScope = typeof window !== 'undefined'
        ? window
        : (typeof globalThis !== 'undefined' ? globalThis : Function('return this')());

    if (!globalScope.LiveTranslatorModules) {
        globalScope.LiveTranslatorModules = {};
    }
    if (!globalScope.LiveTranslatorModules.runtime) {
        globalScope.LiveTranslatorModules.runtime = {};
    }
    const defineRuntimeModule = globalScope.LiveTranslatorDefine;
    if (typeof defineRuntimeModule !== 'function') {
        throw new Error('[LiveTranslator] runtime module registry is unavailable before translator/providers/local-metrics.js.');
    }

    const DEFAULT_LOG_FILE = 'translation-metrics.log';
    const DEFAULT_SUMMARY_FILE = 'translation-metrics-summary.json';

    function noop() {}

    function bindLogger(logger = {}) {
        return {
            debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
            warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
            error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
        };
    }

    function getNodeApi() {
        try {
            const req = typeof require === 'function'
                ? require
                : (globalScope && typeof globalScope.require === 'function' ? globalScope.require : null);
            if (!req) return null;
            return {
                fs: req('fs'),
                path: req('path'),
            };
        } catch (_) {
            return null;
        }
    }

    function getPathContext(explicitPaths) {
        if (explicitPaths && typeof explicitPaths === 'object') return explicitPaths;
        return globalScope.LiveTranslatorPaths && typeof globalScope.LiveTranslatorPaths === 'object'
            ? globalScope.LiveTranslatorPaths
            : {};
    }

    function normalizeMetricsSettings(settings = {}) {
        const translation = settings && settings.translation && typeof settings.translation === 'object'
            ? settings.translation
            : {};
        const metrics = settings && settings.metrics && typeof settings.metrics === 'object'
            ? settings.metrics
            : (translation.metrics && typeof translation.metrics === 'object' ? translation.metrics : {});
        return {
            enabled: metrics.enabled !== false,
            logFile: typeof metrics.logFile === 'string' && metrics.logFile.trim()
                ? metrics.logFile.trim()
                : DEFAULT_LOG_FILE,
            summaryFile: typeof metrics.summaryFile === 'string' && metrics.summaryFile.trim()
                ? metrics.summaryFile.trim()
                : DEFAULT_SUMMARY_FILE,
        };
    }

    function resolveOutputPaths(pathModule, settings, paths) {
        const context = getPathContext(paths);
        const supportPath = typeof context.supportPath === 'string' ? context.supportPath : '';
        const gameRoot = typeof context.gameRoot === 'string' ? context.gameRoot : '';
        let baseDir = supportPath || gameRoot || '';
        if (!baseDir) {
            try {
                if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
                    baseDir = process.cwd();
                }
            } catch (_) {}
        }
        if (!baseDir) return null;
        return {
            dir: baseDir,
            logFile: pathModule.isAbsolute(settings.logFile)
                ? settings.logFile
                : pathModule.join(baseDir, settings.logFile),
            summaryFile: pathModule.isAbsolute(settings.summaryFile)
                ? settings.summaryFile
                : pathModule.join(baseDir, settings.summaryFile),
        };
    }

    function finiteNumber(value, fallback = null) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    function positiveNumber(value, fallback = 0) {
        const numeric = finiteNumber(value, fallback);
        return numeric > 0 ? numeric : fallback;
    }

    function round(value, digits = 3) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        const scale = Math.pow(10, digits);
        return Math.round(numeric * scale) / scale;
    }

    function getUsageNumber(usage, keys) {
        if (!usage || typeof usage !== 'object') return 0;
        for (const key of keys) {
            const numeric = Number(usage[key]);
            if (Number.isFinite(numeric) && numeric >= 0) return numeric;
        }
        return 0;
    }

    function getTimingNumber(timings, keys) {
        if (!timings || typeof timings !== 'object') return null;
        for (const key of keys) {
            const numeric = Number(timings[key]);
            if (Number.isFinite(numeric) && numeric >= 0) return numeric;
        }
        return null;
    }

    function extractUserText(requestBody) {
        if (!requestBody || typeof requestBody !== 'object') return '';
        if (typeof requestBody.input === 'string') return requestBody.input;
        const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message && message.role === 'user' && typeof message.content === 'string') {
                return message.content;
            }
        }
        return '';
    }

    function getModelName(data, selection, requestBody) {
        const candidates = [
            data && data.model,
            data && data.model_instance_id,
            selection && selection.requestedModel,
            selection && selection.expectedInstanceId,
            requestBody && requestBody.model,
            selection && selection.configuredModel,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
        return 'unknown';
    }

    function createEmptySummary() {
        return {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            updatedAt: '',
            totals: createEmptyAggregate(),
            models: {},
        };
    }

    function createEmptyAggregate() {
        return {
            requests: 0,
            streamRequests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            elapsedMs: 0,
            promptMs: 0,
            predictedMs: 0,
            promptTimingTokens: 0,
            predictedTimingTokens: 0,
            lastModel: '',
            lastUpdatedAt: '',
            lastServerGenerationTps: null,
            lastClientCompletionTps: null,
            avgServerGenerationTps: null,
            avgClientCompletionTps: null,
            avgTotalTps: null,
        };
    }

    function normalizeAggregate(value) {
        return Object.assign(createEmptyAggregate(), value && typeof value === 'object' ? value : {});
    }

    function computeRates(aggregate) {
        aggregate.avgServerGenerationTps = aggregate.predictedMs > 0
            ? round((aggregate.predictedTimingTokens * 1000) / aggregate.predictedMs, 3)
            : null;
        aggregate.avgClientCompletionTps = aggregate.elapsedMs > 0
            ? round((aggregate.completionTokens * 1000) / aggregate.elapsedMs, 3)
            : null;
        aggregate.avgTotalTps = aggregate.elapsedMs > 0
            ? round((aggregate.totalTokens * 1000) / aggregate.elapsedMs, 3)
            : null;
        return aggregate;
    }

    function updateAggregate(aggregate, event) {
        const target = normalizeAggregate(aggregate);
        target.requests += 1;
        if (event.stream === true) target.streamRequests += 1;
        target.promptTokens += positiveNumber(event.usage && event.usage.promptTokens, 0);
        target.completionTokens += positiveNumber(event.usage && event.usage.completionTokens, 0);
        target.totalTokens += positiveNumber(event.usage && event.usage.totalTokens, 0);
        target.elapsedMs += positiveNumber(event.elapsedMs, 0);
        target.promptMs += positiveNumber(event.timings && event.timings.promptMs, 0);
        target.predictedMs += positiveNumber(event.timings && event.timings.predictedMs, 0);
        target.promptTimingTokens += positiveNumber(event.timings && event.timings.promptTokens, 0);
        target.predictedTimingTokens += positiveNumber(event.timings && event.timings.predictedTokens, 0);
        target.lastModel = event.model || target.lastModel || '';
        target.lastUpdatedAt = event.at || new Date().toISOString();
        target.lastServerGenerationTps = event.tps && event.tps.serverGenerationTps !== null
            ? event.tps.serverGenerationTps
            : target.lastServerGenerationTps;
        target.lastClientCompletionTps = event.tps && event.tps.clientCompletionTps !== null
            ? event.tps.clientCompletionTps
            : target.lastClientCompletionTps;
        return computeRates(target);
    }

    function createEvent(payload = {}) {
        const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
        const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
        const timings = data.timings && typeof data.timings === 'object' ? data.timings : {};
        const requestBody = payload.requestBody && typeof payload.requestBody === 'object' ? payload.requestBody : {};
        const elapsedMs = positiveNumber(payload.elapsedMs, 0);
        const promptTokens = getUsageNumber(usage, ['prompt_tokens', 'promptTokens']);
        const completionTokens = getUsageNumber(usage, ['completion_tokens', 'completionTokens', 'predicted_tokens']);
        const totalTokens = getUsageNumber(usage, ['total_tokens', 'totalTokens']) || (promptTokens + completionTokens);
        const promptMs = getTimingNumber(timings, ['prompt_ms', 'promptMs']);
        const predictedMs = getTimingNumber(timings, ['predicted_ms', 'predictedMs']);
        const promptTimingTokens = getTimingNumber(timings, ['prompt_n', 'promptTokens']) || promptTokens;
        const predictedTimingTokens = getTimingNumber(timings, ['predicted_n', 'predictedTokens']) || completionTokens;
        const sourceText = typeof payload.sourceText === 'string' ? payload.sourceText : extractUserText(requestBody);
        const outputText = typeof payload.outputText === 'string' ? payload.outputText : '';
        const model = getModelName(data, payload.selection, requestBody);
        const serverPromptTps = getTimingNumber(timings, ['prompt_per_second', 'promptPerSecond']);
        const serverGenerationTps = getTimingNumber(timings, ['predicted_per_second', 'predictedPerSecond']);

        return {
            at: new Date().toISOString(),
            provider: 'local',
            apiType: payload.cfg && payload.cfg.api_type ? String(payload.cfg.api_type) : '',
            model,
            stream: payload.stream === true,
            elapsedMs: round(elapsedMs, 3),
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
                cachedTokens: usage.prompt_tokens_details && Number.isFinite(Number(usage.prompt_tokens_details.cached_tokens))
                    ? Number(usage.prompt_tokens_details.cached_tokens)
                    : 0,
            },
            timings: {
                promptTokens: promptTimingTokens,
                predictedTokens: predictedTimingTokens,
                promptMs: promptMs === null ? null : round(promptMs, 3),
                predictedMs: predictedMs === null ? null : round(predictedMs, 3),
            },
            tps: {
                serverPromptTps: serverPromptTps === null ? null : round(serverPromptTps, 3),
                serverGenerationTps: serverGenerationTps === null ? null : round(serverGenerationTps, 3),
                clientCompletionTps: elapsedMs > 0 && completionTokens > 0 ? round((completionTokens * 1000) / elapsedMs, 3) : null,
                clientTotalTps: elapsedMs > 0 && totalTokens > 0 ? round((totalTokens * 1000) / elapsedMs, 3) : null,
            },
            request: {
                maxTokens: requestBody.max_tokens || requestBody.max_output_tokens || null,
                temperature: requestBody.temperature || null,
                topP: requestBody.top_p || null,
                topK: requestBody.top_k || null,
                minP: requestBody.min_p || null,
                sourceChars: sourceText.length,
                outputChars: outputText.length,
            },
        };
    }

    function createLocalMetricsRecorder(options = {}) {
        const logger = bindLogger(options.logger);
        const settings = normalizeMetricsSettings(options.settings || globalScope.LiveTranslatorSettings || {});
        const nodeApi = getNodeApi();
        const fs = nodeApi && nodeApi.fs;
        const path = nodeApi && nodeApi.path;
        const output = fs && path ? resolveOutputPaths(path, settings, options.paths) : null;
        const enabled = settings.enabled && !!(fs && path && output);
        let summary = null;
        let chain = Promise.resolve();

        if (!enabled) {
            logger.debug('[LocalMetrics] Disabled.');
        }

        async function ensureSummary() {
            if (summary) return summary;
            summary = createEmptySummary();
            try {
                const raw = await fs.promises.readFile(output.summaryFile, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    summary = Object.assign(createEmptySummary(), parsed);
                    summary.totals = normalizeAggregate(summary.totals);
                    summary.models = summary.models && typeof summary.models === 'object' ? summary.models : {};
                    Object.keys(summary.models).forEach((model) => {
                        summary.models[model] = normalizeAggregate(summary.models[model]);
                    });
                }
            } catch (error) {
                if (!error || error.code !== 'ENOENT') {
                    logger.warn('[LocalMetrics] Failed to read existing summary; starting fresh.', error);
                }
            }
            return summary;
        }

        async function writeEvent(event) {
            await fs.promises.mkdir(output.dir, { recursive: true });
            await fs.promises.appendFile(output.logFile, `${JSON.stringify(event)}\n`, 'utf8');

            const current = await ensureSummary();
            current.updatedAt = event.at;
            current.totals = updateAggregate(current.totals, event);
            if (!current.models[event.model]) current.models[event.model] = createEmptyAggregate();
            current.models[event.model] = updateAggregate(current.models[event.model], event);
            await fs.promises.writeFile(output.summaryFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        }

        function enqueue(work) {
            chain = chain.then(work).catch((error) => {
                logger.warn('[LocalMetrics] Failed to write metrics.', error);
            });
            return chain;
        }

        function record(payload) {
            if (!enabled) return null;
            const event = createEvent(payload);
            enqueue(() => writeEvent(event));
            try {
                globalScope.LiveTranslatorLocalMetricsLastEvent = event;
            } catch (_) {}
            return event;
        }

        return {
            enabled,
            logFile: output && output.logFile ? output.logFile : '',
            summaryFile: output && output.summaryFile ? output.summaryFile : '',
            record,
        };
    }

    defineRuntimeModule('runtime.translationLocalMetrics', {
        createLocalMetricsRecorder,
    });
})();
