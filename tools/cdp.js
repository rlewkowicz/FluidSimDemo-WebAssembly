#!/usr/bin/env node
// Tiny Chrome DevTools Protocol client for inspecting an already-running
// Chrome/Chromium with --remote-debugging-port=9222.
//
// Subcommands:
//   list                          List all CDP targets (id, type, url, title)
//   inspect <url-substring>       Console logs + uncaught exceptions + failed
//                                 network requests + WebAssembly status for the
//                                 first page whose URL contains <url-substring>.
//   shot    <url-substring> <out> Save a PNG screenshot of that page to <out>.
//   eval    <url-substring> <js>  Evaluate <js> in that page and print the result.
//   reload  <url-substring>       Hard-reload that page (ignoreCache).
//
// Defaults: CDP_HOST=localhost CDP_PORT=9222 CDP_TAIL_MS=2500 (how long to
// listen for events after attaching).
//
// Requires Node >=22 (built-in WebSocket).

import { writeFileSync } from "node:fs";

const CDP_HOST = process.env.CDP_HOST || "localhost";
const CDP_PORT = process.env.CDP_PORT || "9222";
const CDP_TAIL_MS = parseInt(process.env.CDP_TAIL_MS || "2500");

async function targets() {
    const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
    return r.json();
}

async function pickTarget(urlSubstring) {
    const all = await targets();
    const t = all.find(x => x.type === "page" && x.url.includes(urlSubstring));
    if (!t) {
        console.error(`no page target matched "${urlSubstring}"`);
        console.error("available pages:");
        for (const x of all) if (x.type === "page") console.error(`  ${x.url}`);
        process.exit(2);
    }
    return t;
}

class CDP {
    constructor(target) {
        this.target = target;
        this.ws = new WebSocket(target.webSocketDebuggerUrl);
        this.id = 0;
        this.pending = new Map();
        this.handlers = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = e => reject(e);
        });
        this.ws.onmessage = ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id != null) {
                const cb = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (cb) cb(msg);
            } else {
                for (const h of this.handlers) h(msg);
            }
        };
    }
    on(fn) { this.handlers.push(fn); }
    send(method, params) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            this.pending.set(id, msg => {
                if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
                else resolve(msg.result);
            });
        });
    }
    close() { this.ws.close(); }
}

function fmtArg(arg) {
    if (arg.value !== undefined) return JSON.stringify(arg.value);
    if (arg.unserializableValue) return arg.unserializableValue;
    if (arg.description) return arg.description;
    return arg.type;
}

async function cmdList() {
    const all = await targets();
    for (const t of all) {
        if (t.type !== "page") continue;
        console.log(`${t.id.slice(0, 8)}  ${t.url}`);
    }
}

async function cmdInspect(urlSubstring) {
    const target = await pickTarget(urlSubstring);
    console.log(`# ${target.url}\n`);
    const cdp = new CDP(target);
    await cdp.ready;

    const buffer = [];
    cdp.on(msg => {
        if (msg.method === "Runtime.consoleAPICalled") {
            const args = msg.params.args.map(fmtArg).join(" ");
            buffer.push(`[console.${msg.params.type}] ${args}`);
        } else if (msg.method === "Runtime.exceptionThrown") {
            const e = msg.params.exceptionDetails;
            const stack = e.stackTrace ? "\n" + e.stackTrace.callFrames.map(f =>
                `    at ${f.functionName || "<anon>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`).join("\n") : "";
            buffer.push(`[exception] ${e.exception?.description || e.text}${stack}`);
        } else if (msg.method === "Network.loadingFailed") {
            buffer.push(`[net.fail] ${msg.params.errorText}  (${msg.params.type})`);
        } else if (msg.method === "Network.responseReceived") {
            const r = msg.params.response;
            if (r.status >= 400) buffer.push(`[net.${r.status}] ${r.url}`);
        }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");

    // Surface any pre-existing logs.
    const recent = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
            const summary = {
                url: location.href,
                readyState: document.readyState,
                title: document.title,
                hasCanvas: !!document.querySelector("canvas"),
                wasmSupported: typeof WebAssembly !== "undefined",
                fluidsim_profile: typeof window.__fluidsim_profile,
                errors: window.__last_errors || null,
            };
            return JSON.stringify(summary, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log("page state:");
    console.log(recent.result.value);
    console.log();

    await new Promise(r => setTimeout(r, CDP_TAIL_MS));

    if (buffer.length === 0) {
        console.log("(no events captured during tail window)");
    } else {
        console.log(`events (last ${CDP_TAIL_MS}ms):`);
        for (const line of buffer) console.log(line);
    }
    cdp.close();
}

async function cmdShot(urlSubstring, outPath) {
    const target = await pickTarget(urlSubstring);
    const cdp = new CDP(target);
    await cdp.ready;
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(outPath, Buffer.from(r.data, "base64"));
    console.log(`wrote ${outPath} (${Buffer.from(r.data, "base64").length} bytes)`);
    cdp.close();
}

async function cmdEval(urlSubstring, expression) {
    const target = await pickTarget(urlSubstring);
    const cdp = new CDP(target);
    await cdp.ready;
    const r = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (r.exceptionDetails) {
        console.error("exception:", r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        process.exit(1);
    }
    console.log(JSON.stringify(r.result.value, null, 2));
    cdp.close();
}

async function cmdReload(urlSubstring) {
    const target = await pickTarget(urlSubstring);
    const cdp = new CDP(target);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
    console.log(`reloaded ${target.url}`);
    cdp.close();
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = {
    list: () => cmdList(),
    inspect: () => cmdInspect(args[0] || ""),
    shot: () => cmdShot(args[0] || "", args[1] || "shot.png"),
    eval: () => cmdEval(args[0] || "", args.slice(1).join(" ")),
    reload: () => cmdReload(args[0] || ""),
};
if (!cmds[cmd]) {
    console.error("usage: cdp.js {list|inspect|shot|eval|reload} [args...]");
    process.exit(64);
}
await cmds[cmd]();
