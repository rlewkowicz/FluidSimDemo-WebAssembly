// Profiling helpers. When PROFILE is false, every export is a passthrough so
// release builds carry zero overhead and never reference the .profile.wasm
// artifact or the host import shims.

export const PROFILE = (() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("profile") === "1";
})();

const ROLL = 120;

function makeStats() {
    return { samples: new Float64Array(ROLL), n: 0, idx: 0, total: 0, count: 0 };
}

function record(stats, ms) {
    stats.samples[stats.idx] = ms;
    stats.idx = (stats.idx + 1) % ROLL;
    if (stats.n < ROLL) stats.n++;
    stats.total += ms;
    stats.count++;
}

function summary(stats) {
    if (stats.n === 0) return { avg: 0, p95: 0, max: 0, count: stats.count };
    const buf = stats.samples.slice(0, stats.n);
    let sum = 0, max = 0;
    for (let i = 0; i < buf.length; i++) {
        sum += buf[i];
        if (buf[i] > max) max = buf[i];
    }
    const sorted = buf.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
    return { avg: sum / buf.length, p95, max, count: stats.count };
}

let regionStats = null;
let regionNames = null;
let frameStats = null;
let frameCount = 0;

if (PROFILE) {
    regionStats = new Map();
    frameStats = makeStats();
    window.__fluidsim_profile = {
        step: () => summary(frameStats),
        regions: () => {
            const out = {};
            for (const [id, s] of regionStats) {
                const name = regionNames ? regionNames[id] : `region_${id}`;
                out[name || `region_${id}`] = summary(s);
            }
            return out;
        },
        raw: { frameStats, regionStats: () => regionStats }
    };
}

function jsRecord(id, ms) {
    let s = regionStats.get(id);
    if (!s) { s = makeStats(); regionStats.set(id, s); }
    record(s, ms);
}

export async function loadModel(releasePath) {
    if (!PROFILE) {
        const response = await fetch(releasePath);
        const bytes = await response.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes);
        return { instance };
    }

    const profilePath = releasePath.replace(/model\.wasm$/, "model.profile.wasm");
    const regionsPath = releasePath.replace(/model\.wasm$/, "model.regions.json");

    try {
        const r = await fetch(regionsPath);
        if (r.ok) {
            const json = await r.json();
            regionNames = json.regions || [];
        }
    } catch (_) { /* regions metadata is optional */ }

    const response = await fetch(profilePath);
    const bytes = await response.arrayBuffer();
    const imports = {
        env: {
            js_perf_now: () => performance.now(),
            js_profile_record: (id, ms) => jsRecord(id, ms),
        }
    };
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    return { instance };
}

export function wrapStep(fn, _label) {
    if (!PROFILE) return fn;
    return function profiledStep(...args) {
        const t0 = performance.now();
        const r = fn(...args);
        record(frameStats, performance.now() - t0);
        frameCount++;
        if (frameCount % ROLL === 0) {
            console.log("[fluidsim profile]", {
                step: summary(frameStats),
                regions: window.__fluidsim_profile.regions(),
            });
        }
        return r;
    };
}

export class ProfileHUD {
    constructor(canvas) {
        this.canvas = canvas;
        this.enabled = PROFILE;
    }

    draw() {
        if (!this.enabled) return;
        const ctx = this.canvas.getContext("2d");
        const step = summary(frameStats);
        const regions = [];
        for (const [id, s] of regionStats) {
            const name = (regionNames && regionNames[id]) || `r${id}`;
            regions.push([name, summary(s)]);
        }
        regions.sort((a, b) => b[1].avg - a[1].avg);

        const lines = [
            `step  avg ${step.avg.toFixed(2)}ms  p95 ${step.p95.toFixed(2)}  fps ${step.avg > 0 ? (1000 / step.avg).toFixed(0) : "—"}`,
        ];
        for (let i = 0; i < Math.min(3, regions.length); i++) {
            const [name, s] = regions[i];
            lines.push(`${name.padEnd(10)} avg ${s.avg.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}`);
        }

        const w = 280, h = 18 + 16 * lines.length;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(8, 8, w, h);
        ctx.fillStyle = "#0f0";
        ctx.font = "12px monospace";
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 16, 26 + i * 16);
        }
        ctx.restore();
    }
}
