(() => {
    'use strict';

    const DEFAULT_REFRESH_MS = 1500;
    const DEFAULT_METRICS_LOG = 'translation-metrics.log';
    const DEFAULT_ANALYSIS_LOG = 'translation-tps-analysis.log';
    const DEFAULT_ANALYSIS_SNAPSHOT = 'translation-tps-analysis.json';

    const state = {
        fs: null,
        path: null,
        supportPath: '',
        gameRoot: '',
        metricsFile: '',
        analysisLogFile: '',
        analysisSnapshotFile: '',
        metricsBasePath: '',
        refreshMs: DEFAULT_REFRESH_MS,
        lastLoggedSampleCount: 0,
        timer: null,
    };

    function getQueryValue(name) {
        try {
            return new URLSearchParams(window.location.search).get(name) || '';
        } catch (_) {
            return '';
        }
    }

    function requireNodeModules() {
        try {
            const req = typeof require === 'function' ? require : (window && window.require);
            if (!req) return false;
            state.fs = req('fs');
            state.path = req('path');
            return true;
        } catch (_) {
            return false;
        }
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
    }

    function formatNumber(value, digits = 1) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return '-';
        return numeric.toFixed(digits);
    }

    function formatInteger(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return '0';
        return String(Math.round(numeric));
    }

    function formatTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleTimeString();
    }

    function coercePositiveNumber(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }

    function lowOnePercent(values) {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const count = Math.max(1, Math.ceil(sorted.length * 0.01));
        const low = sorted.slice(0, count);
        return low.reduce((sum, value) => sum + value, 0) / low.length;
    }

    function percentile(values, fraction) {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
        return sorted[index];
    }

    function statsFor(values) {
        const clean = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
        if (!clean.length) {
            return {
                count: 0,
                latest: null,
                avg: null,
                min: null,
                max: null,
                low1: null,
                p50: null,
                p95: null,
                stdev: null,
            };
        }
        const sum = clean.reduce((total, value) => total + value, 0);
        const avg = sum / clean.length;
        const variance = clean.reduce((total, value) => total + Math.pow(value - avg, 2), 0) / clean.length;
        return {
            count: clean.length,
            latest: clean[clean.length - 1],
            avg,
            min: Math.min(...clean),
            max: Math.max(...clean),
            low1: lowOnePercent(clean),
            p50: percentile(clean, 0.5),
            p95: percentile(clean, 0.95),
            stdev: Math.sqrt(variance),
        };
    }

    function getTps(event, key) {
        const tps = event && event.tps && typeof event.tps === 'object' ? event.tps : {};
        if (key === 'serverGeneration') return coercePositiveNumber(tps.serverGenerationTps);
        if (key === 'serverPrompt') return coercePositiveNumber(tps.serverPromptTps);
        if (key === 'clientCompletion') return coercePositiveNumber(tps.clientCompletionTps);
        if (key === 'clientTotal') return coercePositiveNumber(tps.clientTotalTps);
        return null;
    }

    function readSettings() {
        const defaults = {
            metricsLogFile: DEFAULT_METRICS_LOG,
            analysisLogFile: DEFAULT_ANALYSIS_LOG,
            analysisSnapshotFile: DEFAULT_ANALYSIS_SNAPSHOT,
            refreshMs: DEFAULT_REFRESH_MS,
        };
        if (!state.fs || !state.path || !state.supportPath) return defaults;
        try {
            const raw = state.fs.readFileSync(state.path.join(state.supportPath, 'settings.json'), 'utf8');
            const parsed = JSON.parse(raw);
            const metrics = parsed && parsed.metrics && typeof parsed.metrics === 'object' ? parsed.metrics : {};
            return {
                metricsLogFile: metrics.logFile || metrics.metricsLogFile || defaults.metricsLogFile,
                analysisLogFile: metrics.analysisLogFile || defaults.analysisLogFile,
                analysisSnapshotFile: metrics.analysisSnapshotFile || defaults.analysisSnapshotFile,
                refreshMs: Math.max(500, Number(metrics.refreshMs) || defaults.refreshMs),
            };
        } catch (_) {
            return defaults;
        }
    }

    function getProcessCwd() {
        try {
            if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
                const cwd = process.cwd();
                return typeof cwd === 'string' ? cwd : '';
            }
        } catch (_) {}
        return '';
    }

    function addCandidatePath(paths, value) {
        if (!value || !state.path) return;
        const normalized = state.path.normalize(String(value));
        if (!paths.includes(normalized)) paths.push(normalized);
    }

    function getCandidateBasePaths() {
        const paths = [];
        addCandidatePath(paths, state.supportPath);
        addCandidatePath(paths, state.gameRoot);
        addCandidatePath(paths, getProcessCwd());
        return paths;
    }

    function resolveRelativeFile(fileName, basePaths, options = {}) {
        const raw = String(fileName || '').trim();
        if (!raw) return '';
        if (state.path.isAbsolute(raw)) return raw;
        const candidates = basePaths.length ? basePaths : [''];
        if (options.preferExisting) {
            for (const basePath of candidates) {
                const candidate = state.path.join(basePath, raw);
                try {
                    if (state.fs.existsSync(candidate)) return candidate;
                } catch (_) {}
            }
        }
        return state.path.join(candidates[0] || '', raw);
    }

    function resolvePaths() {
        state.supportPath = getQueryValue('supportPath');
        state.gameRoot = getQueryValue('gameRoot');
        if (!state.supportPath && typeof process !== 'undefined' && typeof process.cwd === 'function') {
            state.supportPath = process.cwd();
        }
        const settings = readSettings();
        state.refreshMs = settings.refreshMs;
        const basePaths = getCandidateBasePaths();
        state.metricsFile = resolveRelativeFile(settings.metricsLogFile, basePaths, { preferExisting: true });
        state.metricsBasePath = state.path.dirname(state.metricsFile || state.path.join(basePaths[0] || '', DEFAULT_METRICS_LOG));
        const analysisBasePaths = [];
        addCandidatePath(analysisBasePaths, state.metricsBasePath);
        for (const basePath of basePaths) addCandidatePath(analysisBasePaths, basePath);
        state.analysisLogFile = resolveRelativeFile(settings.analysisLogFile, analysisBasePaths);
        state.analysisSnapshotFile = resolveRelativeFile(settings.analysisSnapshotFile, analysisBasePaths);
        setText('log-path', `raw: ${state.metricsFile}`);
        setText('analysis-path', `analysis: ${state.analysisSnapshotFile}`);
    }

    function readEvents() {
        try {
            const raw = state.fs.readFileSync(state.metricsFile, 'utf8');
            return raw.split(/\r?\n/)
                .filter(Boolean)
                .map((line) => {
                    try { return JSON.parse(line); } catch (_) { return null; }
                })
                .filter(Boolean);
        } catch (error) {
            if (error && error.code === 'ENOENT') return [];
            throw error;
        }
    }

    function summarizeEvents(events) {
        const totals = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            elapsedMs: 0,
        };
        const allGeneration = [];
        const allPrompt = [];
        const allClientCompletion = [];
        const allClientTotal = [];
        const models = new Map();

        for (const event of events) {
            const model = String(event.model || 'unknown');
            if (!models.has(model)) {
                models.set(model, {
                    model,
                    samples: [],
                    promptSamples: [],
                    clientCompletionSamples: [],
                    clientTotalSamples: [],
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    elapsedMs: 0,
                    lastAt: '',
                });
            }
            const row = models.get(model);
            const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
            const promptTokens = Number(usage.promptTokens) || 0;
            const completionTokens = Number(usage.completionTokens) || 0;
            const totalTokens = Number(usage.totalTokens) || 0;
            const elapsedMs = Number(event.elapsedMs) || 0;
            row.promptTokens += promptTokens;
            row.completionTokens += completionTokens;
            row.totalTokens += totalTokens;
            row.elapsedMs += elapsedMs;
            row.lastAt = event.at || row.lastAt;
            totals.promptTokens += promptTokens;
            totals.completionTokens += completionTokens;
            totals.totalTokens += totalTokens;
            totals.elapsedMs += elapsedMs;

            const generation = getTps(event, 'serverGeneration');
            const prompt = getTps(event, 'serverPrompt');
            const clientCompletion = getTps(event, 'clientCompletion');
            const clientTotal = getTps(event, 'clientTotal');
            if (generation !== null) {
                row.samples.push(generation);
                allGeneration.push(generation);
            }
            if (prompt !== null) {
                row.promptSamples.push(prompt);
                allPrompt.push(prompt);
            }
            if (clientCompletion !== null) {
                row.clientCompletionSamples.push(clientCompletion);
                allClientCompletion.push(clientCompletion);
            }
            if (clientTotal !== null) {
                row.clientTotalSamples.push(clientTotal);
                allClientTotal.push(clientTotal);
            }
        }

        const modelRows = Array.from(models.values()).map((row) => Object.assign(row, {
            generation: statsFor(row.samples),
            prompt: statsFor(row.promptSamples),
            clientCompletion: statsFor(row.clientCompletionSamples),
            clientTotal: statsFor(row.clientTotalSamples),
        })).sort((a, b) => {
            const latestDiff = new Date(b.lastAt || 0).getTime() - new Date(a.lastAt || 0).getTime();
            return latestDiff || a.model.localeCompare(b.model);
        });

        return {
            at: new Date().toISOString(),
            sampleCount: allGeneration.length,
            eventCount: events.length,
            totals,
            generation: statsFor(allGeneration),
            prompt: statsFor(allPrompt),
            clientCompletion: statsFor(allClientCompletion),
            clientTotal: statsFor(allClientTotal),
            models: modelRows,
        };
    }

    function renderSummary(summary) {
        setText('sample-count', `${formatInteger(summary.sampleCount)} generation samples`);
        setText('latest-tps', formatNumber(summary.generation.latest));
        setText('average-tps', formatNumber(summary.generation.avg));
        setText('low1-tps', formatNumber(summary.generation.low1));
        setText('minmax-tps', `${formatNumber(summary.generation.min)} / ${formatNumber(summary.generation.max)}`);
        setText('last-updated', summary.eventCount ? formatTime(summary.at) : '-');
        setText(
            'status-line',
            summary.eventCount
                ? `${formatInteger(summary.eventCount)} requests, ${formatInteger(summary.totals.completionTokens)} completion tokens`
                : 'Waiting for metrics...'
        );

        const body = document.getElementById('model-rows');
        if (body) {
            body.innerHTML = '';
            if (!summary.models.length) {
                const row = document.createElement('tr');
                row.innerHTML = '<td colspan="10" class="empty">No TPS samples yet.</td>';
                body.appendChild(row);
            } else {
                for (const model of summary.models) {
                    const row = document.createElement('tr');
                    row.innerHTML = [
                        `<td title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</td>`,
                        `<td>${formatInteger(model.generation.count)}</td>`,
                        `<td>${formatNumber(model.generation.latest)}</td>`,
                        `<td>${formatNumber(model.generation.avg)}</td>`,
                        `<td>${formatNumber(model.generation.low1)}</td>`,
                        `<td>${formatNumber(model.generation.min)}</td>`,
                        `<td>${formatNumber(model.generation.max)}</td>`,
                        `<td>${formatNumber(model.generation.p50)}</td>`,
                        `<td>${formatNumber(model.generation.p95)}</td>`,
                        `<td>${formatNumber(model.generation.stdev)}</td>`,
                    ].join('');
                    body.appendChild(row);
                }
            }
        }

        renderDetails(summary);
    }

    function renderDetails(summary) {
        const grid = document.getElementById('detail-grid');
        if (!grid) return;
        const cards = [
            ['Server generation', summary.generation],
            ['Server prompt', summary.prompt],
            ['Client completion', summary.clientCompletion],
            ['Client total', summary.clientTotal],
        ];
        grid.innerHTML = '';
        for (const [label, stats] of cards) {
            const card = document.createElement('div');
            card.className = 'detail-card';
            card.innerHTML = [
                `<b>${escapeHtml(label)}</b>`,
                `<span>avg ${formatNumber(stats.avg)} | low1 ${formatNumber(stats.low1)}</span>`,
                `<span>min ${formatNumber(stats.min)} | max ${formatNumber(stats.max)}</span>`,
                `<span>p50 ${formatNumber(stats.p50)} | p95 ${formatNumber(stats.p95)}</span>`,
                `<span>stdev ${formatNumber(stats.stdev)} | n ${formatInteger(stats.count)}</span>`,
            ].join('');
            grid.appendChild(card);
        }
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[ch]);
    }

    function serializableSummary(summary) {
        return {
            at: summary.at,
            sampleCount: summary.sampleCount,
            eventCount: summary.eventCount,
            totals: summary.totals,
            generation: summary.generation,
            prompt: summary.prompt,
            clientCompletion: summary.clientCompletion,
            clientTotal: summary.clientTotal,
            models: summary.models.map((model) => ({
                model: model.model,
                lastAt: model.lastAt,
                promptTokens: model.promptTokens,
                completionTokens: model.completionTokens,
                totalTokens: model.totalTokens,
                elapsedMs: model.elapsedMs,
                generation: model.generation,
                prompt: model.prompt,
                clientCompletion: model.clientCompletion,
                clientTotal: model.clientTotal,
            })),
        };
    }

    function writeAnalysisLogs(summary) {
        if (!summary.eventCount || summary.eventCount === state.lastLoggedSampleCount) return;
        state.lastLoggedSampleCount = summary.eventCount;
        const payload = serializableSummary(summary);
        try {
            state.fs.mkdirSync(state.path.dirname(state.analysisLogFile), { recursive: true });
            state.fs.appendFileSync(state.analysisLogFile, `${JSON.stringify(payload)}\n`, 'utf8');
            state.fs.writeFileSync(state.analysisSnapshotFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        } catch (error) {
            setText('status-line', `Analysis log write failed: ${error && error.message ? error.message : error}`);
        }
    }

    function refresh() {
        try {
            const events = readEvents();
            const summary = summarizeEvents(events);
            renderSummary(summary);
            writeAnalysisLogs(summary);
        } catch (error) {
            setText('status-line', `Read failed: ${error && error.message ? error.message : error}`);
        }
    }

    function boot() {
        if (!requireNodeModules()) {
            setText('status-line', 'Node fs/path unavailable.');
            return;
        }
        resolvePaths();
        const refreshButton = document.getElementById('refresh-button');
        if (refreshButton) refreshButton.addEventListener('click', refresh);
        refresh();
        state.timer = setInterval(refresh, state.refreshMs);
        window.addEventListener('beforeunload', () => {
            if (state.timer) clearInterval(state.timer);
            state.timer = null;
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
