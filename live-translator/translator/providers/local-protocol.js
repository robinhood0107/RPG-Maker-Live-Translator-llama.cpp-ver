// LM Studio model selection, request bodies, response parsing, and stream parsing.
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
    const requireRuntimeModule = globalScope.LiveTranslatorRequire;
    if (typeof defineRuntimeModule !== 'function') {
        throw new Error('[LiveTranslator] runtime module registry is unavailable before translator/providers/local-protocol.js.');
    }

    function requireModule(moduleName) {
        if (typeof requireRuntimeModule === 'function') {
            return requireRuntimeModule(moduleName);
        }
        const modules = globalScope.LiveTranslatorModules || {};
        if (modules[moduleName]) return modules[moduleName];
        return String(moduleName || '').split('.').reduce((current, part) => {
            return current && current[part] ? current[part] : null;
        }, modules);
    }

    const utils = requireModule('runtime.translationProviderUtils');
    const {
        DEFAULT_LOCAL_MAX_OUTPUT_TOKENS,
    } = utils;

    function readParallelCapacity(instance) {
        const config = instance && instance.config && typeof instance.config === 'object'
            ? instance.config
            : {};
        const candidates = [
            config.parallel,
            config.max_parallel,
            config.maxParallel,
            instance && instance.parallel,
            instance && instance.max_parallel,
            instance && instance.maxParallel,
        ];
        for (const value of candidates) {
            const numeric = Number(value);
            if (Number.isInteger(numeric) && numeric > 0) return numeric;
        }
        return 1;
    }

    function getLoadedLlmInstances(models) {
        const out = [];
        const list = Array.isArray(models) ? models : [];
        for (const model of list) {
            if (!model || model.type !== 'llm') continue;
            const modelKey = typeof model.key === 'string' ? model.key.trim() : '';
            if (!modelKey) continue;
            const loadedInstances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
            for (const instance of loadedInstances) {
                const instanceId = instance && typeof instance.id === 'string' ? instance.id.trim() : '';
                if (!instanceId) continue;
                out.push({
                    instanceId,
                    modelKey,
                    capacity: readParallelCapacity(instance),
                });
            }
        }
        return out;
    }

    function describeLoadedLlmInstances(instances) {
        const list = Array.isArray(instances) ? instances : [];
        if (!list.length) return 'none';
        return list.map((item) => {
            if (!item || typeof item.instanceId !== 'string' || typeof item.modelKey !== 'string') return '<invalid>';
            const suffix = item.capacity > 1 ? `, parallel ${item.capacity}` : '';
            return item.instanceId === item.modelKey
                ? `${item.instanceId}${suffix}`
                : `${item.instanceId} (${item.modelKey}${suffix})`;
        }).join(', ');
    }

    function getLoadedInstancesForModel(model) {
        const modelKey = model && typeof model.key === 'string' ? model.key.trim() : '';
        const loadedInstances = model && Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
        return loadedInstances
            .map((instance) => ({
                instanceId: instance && typeof instance.id === 'string' ? instance.id.trim() : '',
                modelKey,
                capacity: readParallelCapacity(instance),
            }))
            .filter((instance) => instance.instanceId);
    }

    function isLlamaCppConfig(cfg) {
        return cfg && cfg.api_type === 'llamacpp';
    }

    function normalizeLocalModelCatalog(data, cfg) {
        if (isLlamaCppConfig(cfg)) {
            if (data && Array.isArray(data.data)) return data.data;
            if (data && Array.isArray(data.models)) return data.models;
            if (Array.isArray(data)) return data;
            throw new Error('Local LLM models response missing required "data" array.');
        }
        if (!data || !Array.isArray(data.models)) {
            throw new Error('Local LLM models response missing required "models" array.');
        }
        return data.models;
    }

    function getOpenAiModelIds(models) {
        const ids = [];
        const list = Array.isArray(models) ? models : [];
        for (const model of list) {
            const id = typeof model === 'string'
                ? model.trim()
                : model && typeof model.id === 'string'
                    ? model.id.trim()
                    : model && typeof model.key === 'string'
                        ? model.key.trim()
                        : model && typeof model.model === 'string'
                            ? model.model.trim()
                            : model && typeof model.name === 'string'
                                ? model.name.trim()
                                : '';
            if (id && !ids.includes(id)) ids.push(id);
        }
        return ids;
    }

    function describeOpenAiModels(ids) {
        return Array.isArray(ids) && ids.length ? ids.join(', ') : 'none';
    }

    function selectOpenAiChatModel(models, cfg) {
        const configuredModel = typeof cfg.model === 'string' ? cfg.model.trim() : '';
        const modelIds = getOpenAiModelIds(models);

        if (configuredModel.toLowerCase() === 'auto') {
            if (modelIds.length !== 1) {
                throw new Error(
                    `settings.local.model is "auto", but llama.cpp /v1/models returned ${modelIds.length} model(s): `
                    + `${describeOpenAiModels(modelIds)}. Start llama.cpp with one model or set settings.local.model to a specific model id.`
                );
            }
            return {
                apiType: 'llamacpp',
                configuredModel,
                requestedModel: modelIds[0],
                expectedInstanceId: modelIds[0],
                capacity: 1,
            };
        }

        if (modelIds.includes(configuredModel)) {
            return {
                apiType: 'llamacpp',
                configuredModel,
                requestedModel: configuredModel,
                expectedInstanceId: configuredModel,
                capacity: 1,
            };
        }

        throw new Error(
            `Configured local model "${configuredModel}" was not found in llama.cpp /v1/models: `
            + `${describeOpenAiModels(modelIds)}.`
        );
    }

    function selectLocalChatModel(models, cfg) {
        if (isLlamaCppConfig(cfg)) {
            return selectOpenAiChatModel(models, cfg);
        }

        const configuredModel = typeof cfg.model === 'string' ? cfg.model.trim() : '';
        const loadedLlmInstances = getLoadedLlmInstances(models);

        if (configuredModel.toLowerCase() === 'auto') {
            if (loadedLlmInstances.length !== 1) {
                throw new Error(
                    `settings.local.model is "auto", but LM Studio currently has ${loadedLlmInstances.length} loaded LLM instance(s): `
                    + `${describeLoadedLlmInstances(loadedLlmInstances)}. Load exactly one LLM instance or set settings.local.model to a specific loaded instance identifier.`
                );
            }
            return {
                apiType: 'lmstudio',
                configuredModel,
                requestedModel: loadedLlmInstances[0].instanceId,
                expectedInstanceId: loadedLlmInstances[0].instanceId,
                capacity: loadedLlmInstances[0].capacity || 1,
            };
        }

        const exactModel = Array.isArray(models)
            ? models.find((model) => model && typeof model.key === 'string' && model.key.trim() === configuredModel)
            : null;
        if (exactModel) {
            if (exactModel.type !== 'llm') {
                throw new Error(`Configured local model "${configuredModel}" is not an LLM.`);
            }

            const loadedInstances = getLoadedInstancesForModel(exactModel);
            if (loadedInstances.length === 0) {
                throw new Error(`Configured local model "${configuredModel}" is not loaded in LM Studio.`);
            }
            if (loadedInstances.length > 1) {
                throw new Error(
                    `Configured local model "${configuredModel}" has ${loadedInstances.length} loaded instances: `
                    + `${describeLoadedLlmInstances(loadedInstances)}. Set settings.local.model to a specific loaded instance identifier.`
                );
            }

            return {
                apiType: 'lmstudio',
                configuredModel,
                requestedModel: loadedInstances[0].instanceId,
                expectedInstanceId: loadedInstances[0].instanceId,
                capacity: loadedInstances[0].capacity || 1,
            };
        }

        const exactLoadedInstance = loadedLlmInstances.find((instance) => instance.instanceId === configuredModel);
        if (exactLoadedInstance) {
            return {
                apiType: 'lmstudio',
                configuredModel,
                requestedModel: exactLoadedInstance.instanceId,
                expectedInstanceId: exactLoadedInstance.instanceId,
                capacity: exactLoadedInstance.capacity || 1,
            };
        }

        throw new Error(`Configured local model "${configuredModel}" was not found in LM Studio /api/v1/models.`);
    }

    function buildLocalChatBody(sourceText, cfg, stream) {
        if (isLlamaCppConfig(cfg)) {
            const messages = [];
            if (typeof cfg.system_prompt === 'string' && cfg.system_prompt) {
                messages.push({ role: 'system', content: cfg.system_prompt });
            }
            messages.push({ role: 'user', content: String(sourceText ?? '') });

            const body = {
                messages,
                stream: !!stream,
            };
            if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;
            if (Number.isFinite(cfg.top_p)) body.top_p = cfg.top_p;
            if (Number.isFinite(cfg.top_k)) body.top_k = cfg.top_k;
            if (Number.isFinite(cfg.min_p)) body.min_p = cfg.min_p;
            if (Number.isFinite(cfg.repeat_penalty)) body.repeat_penalty = cfg.repeat_penalty;
            body.max_tokens = Number.isFinite(cfg.max_output_tokens)
                ? cfg.max_output_tokens
                : DEFAULT_LOCAL_MAX_OUTPUT_TOKENS;
            return body;
        }

        const body = {
            input: String(sourceText ?? ''),
            stream: !!stream,
            store: false,
        };
        if (typeof cfg.system_prompt === 'string' && cfg.system_prompt) body.system_prompt = cfg.system_prompt;
        if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;
        if (Number.isFinite(cfg.top_p)) body.top_p = cfg.top_p;
        if (Number.isFinite(cfg.top_k)) body.top_k = cfg.top_k;
        if (Number.isFinite(cfg.min_p)) body.min_p = cfg.min_p;
        if (Number.isFinite(cfg.repeat_penalty)) body.repeat_penalty = cfg.repeat_penalty;
        body.max_output_tokens = Number.isFinite(cfg.max_output_tokens)
            ? cfg.max_output_tokens
            : DEFAULT_LOCAL_MAX_OUTPUT_TOKENS;
        return body;
    }

    function extractMessageContentFromV1(data) {
        const output = data && Array.isArray(data.output)
            ? data.output
            : (data && data.result && Array.isArray(data.result.output) ? data.result.output : []);
        const messages = output.filter((item) => item && item.type === 'message' && typeof item.content === 'string');
        return messages.map((item) => item.content).join('');
    }

    function extractMessageContentFromOpenAi(data) {
        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        if (choice && choice.message && typeof choice.message.content === 'string') {
            return choice.message.content;
        }
        if (choice && typeof choice.text === 'string') {
            return choice.text;
        }
        return '';
    }

    function extractMessageContentFromLocalResponse(data, selection) {
        return selection && selection.apiType === 'llamacpp'
            ? extractMessageContentFromOpenAi(data)
            : extractMessageContentFromV1(data);
    }

    function stripLocalSpecialTokens(value) {
        return String(value || '')
            .replace(/<\|channel\>\s*[^<\r\n]+\s*<channel\|>/gi, '')
            .replace(/<\|channel\>\s*[^<\r\n]*/gi, '')
            .replace(/<channel\|>/gi, '');
    }

    function sanitizeLocalOutput(value) {
        if (typeof value !== 'string') return '';
        let out = stripLocalSpecialTokens(value);
        out = out.replace(/<\s*think\b[\s\S]*?>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
        out = out.replace(/<\s*think\b[\s\S]*?\/>/gi, '');
        out = out.replace(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/u, '$1');
        return out.trim();
    }

    function parseLocalTextOutput(content) {
        return sanitizeLocalOutput(String(content || ''));
    }

    function getLocalChatResponseModelInstanceId(data) {
        const id = data && typeof data.model_instance_id === 'string' ? data.model_instance_id.trim() : '';
        if (!id) {
            throw new Error('Local LLM response missing required "model_instance_id".');
        }
        return id;
    }

    function getLocalChatResponseStats(data) {
        return data && data.stats && typeof data.stats === 'object' ? data.stats : null;
    }

    function assertLocalChatResponseMatchesSelection(data, selection) {
        if (selection && selection.apiType === 'llamacpp') {
            const responseModel = data && typeof data.model === 'string' ? data.model.trim() : '';
            if (responseModel && responseModel !== selection.expectedInstanceId) {
                throw new Error(
                    `Local LLM responded with model "${responseModel}", but "${selection.expectedInstanceId}" was requested.`
                );
            }
            return;
        }

        const responseInstanceId = getLocalChatResponseModelInstanceId(data);
        if (responseInstanceId !== selection.expectedInstanceId) {
            throw new Error(
                `Local LLM responded with instance "${responseInstanceId}", but "${selection.expectedInstanceId}" was required.`
            );
        }

        const stats = getLocalChatResponseStats(data);
        if (stats && typeof stats.model_load_time_seconds !== 'undefined') {
            throw new Error(
                `Local LLM auto-loaded "${responseInstanceId}" unexpectedly. The configured model must already be loaded in LM Studio.`
            );
        }
    }

    function extractOpenAiStreamDeltaContent(event) {
        const choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
        if (!choice) return '';
        if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
        if (typeof choice.text === 'string') return choice.text;
        return '';
    }

    function createThinkBlockStripper() {
        const state = { inThink: false };
        return {
            feed(chunk) {
                const input = String(chunk || '');
                if (!input) return '';
                const lowerInput = input.toLowerCase();
                let out = '';
                let index = 0;
                while (index < input.length) {
                    if (!state.inThink) {
                        const start = lowerInput.indexOf('<think', index);
                        if (start === -1) {
                            out += input.slice(index);
                            break;
                        }
                        out += input.slice(index, start);
                        const endTag = input.indexOf('>', start);
                        if (endTag === -1) {
                            state.inThink = true;
                            break;
                        }
                        state.inThink = true;
                        index = endTag + 1;
                    } else {
                        const end = lowerInput.indexOf('</think', index);
                        if (end === -1) break;
                        const endTag = input.indexOf('>', end);
                        if (endTag === -1) break;
                        state.inThink = false;
                        index = endTag + 1;
                    }
                }
                return out;
            },
        };
    }

    function createSseParser() {
        let buffer = '';
        return {
            feed(chunk) {
                buffer += String(chunk || '');
                const events = [];
                while (true) {
                    const match = buffer.match(/\r?\n\r?\n/);
                    if (!match) break;
                    const index = match.index;
                    const raw = buffer.slice(0, index);
                    buffer = buffer.slice(index + match[0].length);

                    const dataLines = [];
                    raw.split(/\r?\n/).forEach((line) => {
                        if (line.startsWith('data:')) {
                            dataLines.push(line.slice(5).trimStart());
                        }
                    });
                    if (!dataLines.length) continue;

                    try {
                        events.push(JSON.parse(dataLines.join('\n')));
                    } catch (_) {
                        // A malformed server event should not corrupt later events.
                    }
                }
                return events;
            },
        };
    }

    defineRuntimeModule('runtime.translationLocalProtocol', {
        readParallelCapacity,
        getLoadedLlmInstances,
        describeLoadedLlmInstances,
        getLoadedInstancesForModel,
        isLlamaCppConfig,
        normalizeLocalModelCatalog,
        getOpenAiModelIds,
        selectLocalChatModel,
        buildLocalChatBody,
        extractMessageContentFromV1,
        extractMessageContentFromOpenAi,
        extractMessageContentFromLocalResponse,
        stripLocalSpecialTokens,
        sanitizeLocalOutput,
        parseLocalTextOutput,
        getLocalChatResponseModelInstanceId,
        getLocalChatResponseStats,
        assertLocalChatResponseMatchesSelection,
        extractOpenAiStreamDeltaContent,
        createThinkBlockStripper,
        createSseParser,
    });
})();
