/**
 * <app-vectorizer> — PNG → SVG tracing as a SACRVM APPKIT app (kind: "view").
 *
 * A true raster-to-vector tracer (the same family of algorithm as Inkscape's
 * "Trace Bitmap"), built for clean black & white art: logos, line drawings,
 * stencils. A cut-out with transparency traces as one silhouette.
 *
 * Pipeline:  source image → threshold to pure B/W → ImageTracer → clean-up
 * Live and WYSIWYG: the right pane is exactly what gets saved.
 *
 * What goes where:
 *   nav + toolbar  — the app's own <sac-nav>: Open, Save SVG, Copy, Help.
 *   control panel  — a .sidebar in the start slot of a <sac-split>; on a
 *                    phone the nav adopts it as its drawer.
 *   stage          — two panes (source | vector) driven by ONE pan-zoom
 *                    transform; stacked instead of side by side when narrow.
 *
 * Engine: ImageTracer.js 1.2.6 (public domain), vendored in vendor/ and
 * loaded on first use — no CDN.
 */
(function () {
    const BASE = sac.app.base();
    const CSS_ID = "app-vectorizer-css";
    const ENGINE = BASE + "vendor/imagetracer_v1.2.6.js";

    const ACCEPT = "image/png,image/jpeg,image/webp,image/bmp";
    const TRACE_MAX_DIM = 1400;   // tracing resolution cap — the vector output is resolution-independent
    const NODE_SCREEN_R = 3.5;    // node marker radius in SCREEN px, constant at any zoom
    const SVG_NS = "http://www.w3.org/2000/svg";

    /* Smoothing is shown as 0–100 %; the tracer wants a line/curve tolerance
       of 0.01–4. Piecewise linear so 50 % is exactly the old default 1.0. */
    const smoothTolerance = (pct) => {
        const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 50));
        return p <= 50 ? 0.01 + 0.99 * (p / 50) : 1 + 3 * ((p - 50) / 50);
    };
    const smoothPercent = (tol) => {
        if (!Number.isFinite(tol)) return 50;
        const t = Math.max(0.01, Math.min(4, tol));
        return Math.round(t <= 1 ? ((t - 0.01) / 0.99) * 50 : 50 + ((t - 1) / 3) * 50);
    };

    /* ------------------------------------------------------------ engine -- */

    let enginePromise = null;
    function loadEngine() {
        if (window.ImageTracer) return Promise.resolve(window.ImageTracer);
        if (!enginePromise) {
            enginePromise = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = ENGINE;
                s.onload = () => resolve(window.ImageTracer);
                s.onerror = () => { enginePromise = null; reject(new Error("Could not load " + ENGINE)); };
                document.head.appendChild(s);
            });
        }
        return enginePromise;
    }

    /* ----------------------------------------------------- pure raster -- */

    /** Otsu's method over the luminance of the opaque pixels. */
    function otsuThreshold(imgData) {
        const d = imgData.data;
        const hist = new Array(256).fill(0);
        let total = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;   // transparent pixels have no say
            hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
            total++;
        }
        if (total === 0) return 128;
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * hist[t];
        let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > maxVar) { maxVar = between; threshold = t; }
        }
        return threshold;
    }

    /** Luminance below the threshold → black; transparent counts as background. */
    function thresholdToBW(imgData, threshold, invert) {
        const src = imgData.data;
        const out = new Uint8ClampedArray(src.length);
        for (let i = 0; i < src.length; i += 4) {
            let lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
            if (src[i + 3] < 128) lum = 255;
            let isBlack = lum < threshold;
            if (invert) isBlack = !isBlack;
            const v = isBlack ? 0 : 255;
            out[i] = out[i + 1] = out[i + 2] = v;
            out[i + 3] = 255;
        }
        return new ImageData(out, imgData.width, imgData.height);
    }

    /** Silhouette from alpha: opaque → black, whatever its colour. */
    function alphaToBW(imgData, cutoff, invert) {
        const src = imgData.data;
        const out = new Uint8ClampedArray(src.length);
        for (let i = 0; i < src.length; i += 4) {
            let isBlack = src[i + 3] >= cutoff;
            if (invert) isBlack = !isBlack;
            const v = isBlack ? 0 : 255;
            out[i] = out[i + 1] = out[i + 2] = v;
            out[i + 3] = 255;
        }
        return new ImageData(out, imgData.width, imgData.height);
    }

    function hasTransparency(imgData) {
        const d = imgData.data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
        return false;
    }

    /**
     * On-curve anchor points of a path `d` (M/L/H/V/Q/T/C/S/A/Z, absolute and
     * relative). ImageTracer emits absolute M/L/Q/Z; this takes any path.
     */
    function anchorPoints(d) {
        const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
        const pts = [];
        let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0;
        const n = () => parseFloat(tokens[i++]);
        while (i < tokens.length) {
            if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i]; i++; }
            const rel = cmd === cmd.toLowerCase();
            const C = cmd.toUpperCase();
            if (C === "M" || C === "L" || C === "T") {
                let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y;
                if (C === "M") { sx = x; sy = y; } pts.push([x, y]);
            } else if (C === "H") { let x = n(); if (rel) x += cx; cx = x; pts.push([cx, cy]); }
            else if (C === "V") { let y = n(); if (rel) y += cy; cy = y; pts.push([cx, cy]); }
            else if (C === "Q" || C === "S") { n(); n(); let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push([x, y]); }
            else if (C === "C") { n(); n(); n(); n(); let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push([x, y]); }
            else if (C === "A") { n(); n(); n(); n(); n(); let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push([x, y]); }
            else if (C === "Z") { cx = sx; cy = sy; }
            else { i++; }
        }
        return pts;
    }

    /* --------------------------------------------------------------- app -- */

    class AppVectorizer extends sac.app.Element {
        build() {
            sac.app.styles(BASE + "app.css", CSS_ID);
            this.innerHTML = `
<sac-nav brand="VECTORIZER" brand-icon="vector" brand-href="#/" host-nav="wide">
    <div slot="context" class="vz-theme"><sac-theme-toggle></sac-theme-toggle></div>
    <div slot="toolbar" class="toolbar">
        <button type="button" class="btn vz-open" title="Open an image (Ctrl+O)">
            <sac-icon name="folder"></sac-icon> Open
        </button>
        <button type="button" class="btn primary vz-save" data-overflow="never" title="Save the traced SVG (Ctrl+S)" disabled>
            <sac-icon name="download"></sac-icon> SVG
        </button>
        <button type="button" class="nav-icon-btn vz-copy" title="Copy SVG markup" disabled>
            <sac-icon name="copy"></sac-icon>
        </button>
        <button type="button" class="nav-icon-btn vz-fit" title="Reset view">
            <sac-icon name="fit"></sac-icon>
        </button>
        <button type="button" class="nav-icon-btn vz-about-btn" title="Credits &amp; licences">
            <sac-icon name="copyright"></sac-icon>
        </button>
        <button type="button" class="nav-icon-btn vz-help-btn" title="Help">
            <sac-icon name="info"></sac-icon>
        </button>
    </div>
</sac-nav>

<div class="main-layout vz-root">
    <sac-split class="vz-split" position="22%" min-start="230px" min-end="320px"
               aria-label="Resize the control panel">

        <div class="sidebar fill vz-panel" slot="start">
            <sac-section title="Threshold">
                <sac-slider class="vz-threshold" label="Black / white cutoff" min="1" max="254" step="1" value="128"></sac-slider>
                <sac-toggle class="vz-alpha" label="Alpha as mask (silhouette)"></sac-toggle>
                <sac-toggle class="vz-invert" data-keep="invert" label="Invert (trace white)"></sac-toggle>
                <sac-toggle class="vz-auto" data-keep="auto" label="Auto threshold (Otsu)" checked></sac-toggle>
            </sac-section>

            <sac-section title="Trace quality">
                <sac-slider class="vz-despeckle" data-keep="despeckle" label="Despeckle" min="0" max="40" step="1" value="8" suffix=" px"></sac-slider>
                <sac-slider class="vz-smooth" data-keep="smoothing" label="Smoothing" min="0" max="100" step="1" value="50" suffix="%"></sac-slider>
                <sac-toggle class="vz-rightangle" data-keep="rightangle" label="Right-angle enhance" checked></sac-toggle>
            </sac-section>

            <sac-section title="Output">
                <sac-color-field class="vz-fill" data-keep="fill" label="Fill color" value="#000000"></sac-color-field>
                <sac-toggle class="vz-keepbg" data-keep="keepbg" label="Keep background fill"></sac-toggle>
                <sac-toggle class="vz-nodes" data-keep="nodes" label="Show nodes (anchor points)"></sac-toggle>
                <div>
                    <label>Preview backdrop</label>
                    <sac-segmented-control class="vz-backdrop" data-keep="backdrop" value="checker">
                        <button data-value="checker">Checker</button>
                        <button data-value="white">White</button>
                        <button data-value="dark">Dark</button>
                    </sac-segmented-control>
                </div>
            </sac-section>
        </div>

        <div class="vz-stage" slot="end" data-bg="checker">
            <div class="viewport vz-pane vz-pane-src">
                <span class="vz-pane-label">Source</span>
                <div class="pz-layer"><canvas class="vz-src"></canvas></div>
            </div>
            <div class="viewport vz-pane vz-pane-svg">
                <span class="vz-pane-label">Vector (SVG)</span>
                <div class="pz-layer"><div class="vz-svg"></div></div>
            </div>
            <div class="app-drop vz-empty">
                <sac-drop-zone accept="image/png,image/jpeg,image/webp,image/bmp" label="Drop an image"
                               hint="or click to open" touch-label="Open an image" touch-hint=""></sac-drop-zone>
            </div>
            <sac-hud class="vz-hud" position="bottom-left"></sac-hud>
            <div class="vz-busy" hidden><sac-spinner label="Tracing"></sac-spinner><span>Tracing…</span></div>
        </div>

    </sac-split>
</div>

<sac-window class="vz-help-win" title="Vectorizer Guide" width="480px" height="460px"
            left="calc(50vw - 240px)" top="14vh" controls="close">
    <div class="vz-help">
        <h3>PNG → SVG</h3>
        <p>A true raster-to-vector tracer (the same kind of algorithm as Inkscape's
           "Trace Bitmap"), built for <b>clean black &amp; white</b> art: logos, line drawings, stencils.</p>
        <ol>
            <li><b>Threshold</b> decides which pixels become solid. Auto (Otsu) usually nails it; nudging the slider switches it off.</li>
            <li><b>Despeckle</b> drops stray blobs whose outline is shorter than the given length (in pixels of the traced image).</li>
            <li><b>Smoothing</b> trades crisp corners for softer curves: 0&nbsp;% follows every pixel step, 50&nbsp;% is the balanced default, 100&nbsp;% rounds hardest.</li>
            <li><b>Right-angle enhance</b> sharpens letterforms and boxy logos.</li>
        </ol>
        <p><b>Got a colourful logo?</b> Open a cut-out (a transparent PNG) and
           <b>Alpha as mask</b> turns on by itself — everything solid becomes one silhouette,
           colours ignored.</p>
        <p><b>Open</b> an image (Ctrl+O), drop it on the stage or paste it (Ctrl+V) — PNG, JPG, WebP, BMP.
           <b>SVG</b> saves the trace (Ctrl+S, always asks where), the copy button puts the SVG markup
           on the clipboard.</p>
        <p>The preview updates live and is exactly what gets saved. Wheel to zoom, drag to pan,
           double-click to reset — both panes move together.</p>
    </div>
</sac-window>
`;
        }

        onMount(context) {
            this._ctx = context;
            const $ = (s) => this.querySelector(s);
            const nav = $("sac-nav");
            if (nav) nav.host = context.host;
            // Standalone the app is its own page and brings a theme switch; a host has its own.
            $(".vz-theme").hidden = !!context.host;

            this._stage = $(".vz-stage");
            this._srcCanvas = $(".vz-src");
            this._svgHost = $(".vz-svg");
            this._hud = $(".vz-hud");
            this._busy = $(".vz-busy");
            this._saveBtn = $(".vz-save");
            this._copyBtn = $(".vz-copy");
            this.ui = {
                threshold: $(".vz-threshold"),
                alphaMask: $(".vz-alpha"),
                invert: $(".vz-invert"),
                auto: $(".vz-auto"),
                despeckle: $(".vz-despeckle"),
                smooth: $(".vz-smooth"),
                rightangle: $(".vz-rightangle"),
                fill: $(".vz-fill"),
                keepBg: $(".vz-keepbg"),
                nodes: $(".vz-nodes"),
                backdrop: $(".vz-backdrop"),
            };

            this._traceData = null;   // ImageData at trace resolution
            this._traceScale = 1;     // trace res / original res
            this._orig = { w: 0, h: 0 };
            this._rawSVG = "";        // ImageTracer output, before clean-up
            this._svg = "";           // cleaned — what gets saved
            this._name = "vectorized";

            this._pz = sac.setupPanZoom({
                panes: [
                    { pane: $(".vz-pane-src"), layer: $(".vz-pane-src .pz-layer") },
                    { pane: $(".vz-pane-svg"), layer: $(".vz-pane-svg .pz-layer") },
                ],
                enabled: () => this._stage.classList.contains("has-image"),
                onChange: () => this._sizeNodes(),
            });

            this._wireToolbar();
            this._wireControls();
            this._wireDrop();
            this._wireDropZone((file) => this._loadFile(file, null));

            // Paste and keys only while the app is actually on screen — on a
            // desktop a hidden view must not swallow somebody else's Ctrl+V.
            this._onPaste = (e) => this._paste(e);
            this._io = new IntersectionObserver((entries) => {
                this._setVisible(entries[entries.length - 1].isIntersecting);
            });
            this._io.observe(this);

            this._restoreSettings();
        }

        /** The snippet's migration hook. 1.1 kept smoothing as the raw tracer tolerance
         *  ("smooth", 0.01–4); 1.2 keeps a percent. The old key drops out on the next save. */
        _migrateSettings(saved) {
            if ("smooth" in saved) {
                if (!("smoothing" in saved)) saved.smoothing = smoothPercent(parseFloat(saved.smooth));
                delete saved.smooth;
            }
            return saved;
        }

        onUnmount() {
            this._setVisible(false);
            this._io?.disconnect();
            this._io = null;
            clearTimeout(this._retraceTimer);
        }

        _setVisible(on) {
            if (on === !!this._visible) return;
            this._visible = on;
            if (on) {
                document.addEventListener("paste", this._onPaste);
                this._offKeys = this._registerFileKeys(() => this._save());
            } else {
                document.removeEventListener("paste", this._onPaste);
                this._offKeys?.();
                this._offKeys = null;
            }
        }


        /* ------------------------------------------------ the app shell ---- *
         * Shared by the four DREAM-TOOLS-born apps (vectorizer, background-
         * remover, mesh-optimizer, svg-to-3d) — keep the copies in step.
         *   · settings: every control with data-keep is remembered in
         *     context.fs ("settings") and restored by replaying its event;
         *   · credits: sac.about from the manifest (notices included);
         *   · the empty state is a sac-drop-zone whose click goes through
         *     context.files (the host's file space), not the device picker.
         * ------------------------------------------------------------------ */

        _keepValue(el) {
            return el.tagName === "SAC-TOGGLE" ? el.checked : el.value;
        }

        async _restoreSettings() {
            let saved = null;
            try { saved = await this._ctx.fs?.read("settings", null); } catch { saved = null; }
            if (saved && typeof saved === "object" && this._migrateSettings) saved = this._migrateSettings(saved);
            if (saved && typeof saved === "object") {
                for (const el of this.querySelectorAll("[data-keep]")) {
                    const key = el.dataset.keep;
                    if (!(key in saved)) continue;
                    const v = saved[key];
                    const fire = (type, value) => el.dispatchEvent(new CustomEvent(type, { detail: { value }, bubbles: true }));
                    if (el.tagName === "SAC-TOGGLE") { el.checked = !!v; fire("sac:change", !!v); }
                    else if (el.tagName === "INPUT") { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
                    else if (el.tagName === "SAC-STEPPER") { el.value = Number(v); fire("sac:change", Number(v)); }
                    else if (el.tagName === "SAC-SLIDER") { el.value = String(v); fire("sac:input", String(v)); fire("sac:change", String(v)); }
                    else { el.value = String(v); fire("sac:change", String(v)); }
                }
            }
            // Watch only after restoring, so the replay above does not write back.
            const save = () => {
                clearTimeout(this._keepTimer);
                this._keepTimer = setTimeout(() => {
                    const out = {};
                    for (const el of this.querySelectorAll("[data-keep]")) out[el.dataset.keep] = this._keepValue(el);
                    Promise.resolve(this._ctx.fs?.write("settings", out)).catch(() => {});
                }, 400);
            };
            for (const el of this.querySelectorAll("[data-keep]")) {
                for (const type of ["sac:change", "sac:input", "input"]) el.addEventListener(type, save);
            }
        }

        async _about() {
            if (!this._manifest) {
                this._manifest = this._ctx.manifest
                    || await fetch(BASE + "app.json").then((r) => r.json()).catch(() => null);
            }
            if (sac.about) sac.about.open(this._manifest || { name: this.tagName.toLowerCase() });
        }

        _wireDropZone(onFile) {
            const wrap = this.querySelector(".app-drop");
            const zone = wrap.querySelector("sac-drop-zone");
            // Click / Enter / Space open through context.files, like the Open button.
            const intercept = (e) => {
                if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
                if (!e.composedPath().includes(zone)) return;
                e.preventDefault();
                e.stopPropagation();
                this._open();
            };
            wrap.addEventListener("click", intercept, true);
            wrap.addEventListener("keydown", intercept, true);
            zone.addEventListener("sac:files", (e) => { const f = e.detail.files[0]; if (f) onFile(f); });
            zone.addEventListener("sac:rejected", () => sac.toast?.("That file type does not open here.", { kind: "warn" }));
        }

        /** Ctrl+O / Ctrl+S — only while the app is on screen. */
        _registerFileKeys(saveFn) {
            const offs = [
                sac.hotkeys.register("mod+o", () => this._open(), { group: "File", description: "Open" }),
                sac.hotkeys.register("mod+s", () => saveFn(), { group: "File", description: "Save / export" }),
            ];
            return () => offs.forEach((off) => off());
        }

        /* --------------------------------------------------------- wiring -- */

        _wireToolbar() {
            this.querySelector(".vz-open").addEventListener("click", () => this._open());
            this._saveBtn.addEventListener("click", () => this._save());
            this._copyBtn.addEventListener("click", () => this._copy());
            this.querySelector(".vz-fit").addEventListener("click", () => this._pz.reset());
            this.querySelector(".vz-about-btn").addEventListener("click", () => this._about());
            this.querySelector(".vz-help-btn").addEventListener("click", () => this.querySelector(".vz-help-win").open());
        }

        /** Kit events only — composed native events from shadow inputs carry no detail. */
        _on(el, type, fn) {
            el.addEventListener(type, (e) => { if (e.detail != null) fn(e.detail.value); });
        }

        _wireControls() {
            const ui = this.ui;
            const retrace = () => this._scheduleRetrace();

            this._on(ui.threshold, "sac:input", () => {
                // A manual nudge disengages auto. Announce it like a user flip, so
                // the remembered settings see it too (a silent .checked would not).
                if (ui.auto.checked) {
                    ui.auto.checked = false;
                    ui.auto.dispatchEvent(new CustomEvent("sac:change", { detail: { value: false }, bubbles: true }));
                }
                retrace();
            });
            this._on(ui.despeckle, "sac:input", retrace);
            this._on(ui.smooth, "sac:input", retrace);
            for (const t of [ui.invert, ui.auto, ui.rightangle, ui.alphaMask]) this._on(t, "sac:change", retrace);

            // Cheap re-renders — no re-trace.
            this._on(ui.fill, "sac:change", () => this._applyOutput());
            this._on(ui.keepBg, "sac:change", () => this._applyOutput());
            this._on(ui.nodes, "sac:change", () => {
                const live = this._svgHost.querySelector("svg");
                if (live) this._drawNodes(live);
            });
            this._on(ui.backdrop, "sac:change", (v) => this._stage.setAttribute("data-bg", v));
        }

        _wireDrop() {
            const stage = this._stage;
            ["dragenter", "dragover"].forEach((ev) =>
                stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
            ["dragleave", "drop"].forEach((ev) =>
                stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("dragover"); }));
            stage.addEventListener("drop", (e) => {
                if (e.composedPath().some((n) => n.tagName === "SAC-DROP-ZONE")) return;   // the zone handles its own drop
                const file = e.dataTransfer?.files?.[0];
                if (file) this._loadFile(file, null);
            });
        }

        /* ------------------------------------------------------------ files -- */

        async _open() {
            const picked = await this._ctx.files.open({ accept: ACCEPT, title: "Open image" });
            if (picked) this._loadFile(picked.file, null);
        }

        _paste(e) {
            const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
            if (!item) return;
            const file = item.getAsFile();
            if (!file) return;
            e.preventDefault();
            this._loadFile(new File([file], "pasted.png", { type: file.type }), null);
        }

        _loadFile(file, ref) {
            if (!file || !file.type.startsWith("image/")) {
                sac.toast?.("That is not an image.", { kind: "warn" });
                return;
            }
            this._name = (file.name && file.name.replace(/\.[^.]+$/, "")) || "vectorized";
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); this._ingest(img); };
            img.onerror = () => { URL.revokeObjectURL(url); sac.toast?.("Could not read that image.", { kind: "error" }); };
            img.src = url;
        }

        _ingest(img) {
            const w = img.naturalWidth, h = img.naturalHeight;
            this._orig = { w, h };

            // The source at native resolution (CSS contains it).
            const c = this._srcCanvas;
            c.width = w;
            c.height = h;
            const sctx = c.getContext("2d");
            sctx.clearRect(0, 0, w, h);
            sctx.drawImage(img, 0, 0);

            // A (possibly downscaled) buffer to trace.
            this._traceScale = Math.min(1, TRACE_MAX_DIM / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * this._traceScale));
            const th = Math.max(1, Math.round(h * this._traceScale));
            const t = document.createElement("canvas");
            t.width = tw;
            t.height = th;
            const tctx = t.getContext("2d");
            tctx.drawImage(img, 0, 0, tw, th);
            this._traceData = tctx.getImageData(0, 0, tw, th);

            // A transparent image (a cut-out logo) → silhouette from alpha by default.
            const ui = this.ui;
            if (hasTransparency(this._traceData)) {
                ui.alphaMask.checked = true;
                const v = parseInt(ui.threshold.value, 10);
                if (v < 8 || v > 250) ui.threshold.value = "128";
            } else {
                ui.alphaMask.checked = false;
            }

            this._stage.classList.add("has-image");
            this._pz.reset();
            this._runTrace();
        }

        async _save() {
            if (!this._svg) return;
            const blob = new Blob([this._svgFile()], { type: "image/svg+xml" });
            try {
                const saved = await this._ctx.files.save(blob, {
                    name: this._name + ".svg", accept: ".svg", title: "Save SVG",
                });
                if (!saved) return;
                sac.toast?.(`Saved ${saved.name}`, { kind: "success" });
            } catch (err) {
                console.error("[vectorizer] save failed:", err);
                sac.toast?.("Saving failed.", { kind: "error" });
            }
        }

        async _copy() {
            if (!this._svg) return;
            try {
                await navigator.clipboard.writeText(this._svgFile());
                sac.toast?.("SVG copied.", { kind: "success" });
            } catch (err) {
                console.warn("[vectorizer] clipboard write failed:", err);
                sac.toast?.("The clipboard refused.", { kind: "error" });
            }
        }

        /** A standalone, namespaced SVG document. */
        _svgFile() {
            let s = this._svg;
            if (!/xmlns=/.test(s)) s = s.replace("<svg", `<svg xmlns="${SVG_NS}"`);
            return '<?xml version="1.0" encoding="UTF-8"?>\n' + s;
        }

        /* ------------------------------------------------------------ trace -- */

        _scheduleRetrace() {
            clearTimeout(this._retraceTimer);
            this._retraceTimer = setTimeout(() => this._runTrace(), 140);
        }

        async _runTrace() {
            if (!this._traceData) return;
            this._busy.hidden = false;
            let tracer;
            try {
                tracer = await loadEngine();
            } catch (err) {
                console.error("[vectorizer]", err);
                this._busy.hidden = true;
                sac.toast?.("The tracing engine did not load.", { kind: "error" });
                return;
            }
            // Two frames so the spinner paints before the synchronous trace blocks.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                try {
                    const ui = this.ui;
                    const invert = ui.invert.checked;
                    let bw;
                    if (ui.alphaMask.checked) {
                        bw = alphaToBW(this._traceData, parseInt(ui.threshold.value, 10), invert);
                    } else {
                        let threshold;
                        if (ui.auto.checked) {
                            threshold = otsuThreshold(this._traceData);
                            if (String(ui.threshold.value) !== String(threshold)) ui.threshold.value = String(threshold);
                        } else {
                            threshold = parseInt(ui.threshold.value, 10);
                        }
                        bw = thresholdToBW(this._traceData, threshold, invert);
                    }

                    const smooth = smoothTolerance(parseFloat(ui.smooth.value));
                    this._rawSVG = tracer.imagedataToSVG(bw, {
                        // curve fitting
                        ltres: smooth,
                        qtres: smooth,
                        pathomit: parseInt(ui.despeckle.value, 10),
                        rightangleenhance: ui.rightangle.checked,
                        // exactly two colours: black shapes on white
                        colorsampling: 0,
                        numberofcolors: 2,
                        mincolorratio: 0,
                        colorquantcycles: 1,
                        pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
                        // output
                        layering: 0,
                        strokewidth: 0,
                        linefilter: true,
                        roundcoords: 1,
                        viewbox: true,
                        desc: false,
                        scale: this._traceScale ? 1 / this._traceScale : 1,   // back to the original resolution
                    });
                    this._applyOutput();
                } catch (err) {
                    console.error("[vectorizer] trace failed:", err);
                    this._svgHost.innerHTML = "";
                    sac.toast?.("Trace failed — see the console.", { kind: "error" });
                } finally {
                    this._busy.hidden = true;
                }
            }));
        }

        /** Drop the background, recolour the foreground. Re-runnable without a trace. */
        _applyOutput() {
            if (!this._rawSVG) return;
            const fill = this.ui.fill.value;
            const keepBg = this.ui.keepBg.checked;

            const doc = new DOMParser().parseFromString(this._rawSVG, "image/svg+xml");
            const svg = doc.querySelector("svg");
            if (!svg) return;

            let nodes = 0, kept = 0;
            svg.querySelectorAll("path").forEach((p) => {
                const f = (p.getAttribute("fill") || "").replace(/\s/g, "").toLowerCase();
                const isWhite = f === "rgb(255,255,255)" || f === "#ffffff" || f === "#fff" || f === "white";
                if (isWhite && !keepBg) { p.remove(); return; }
                if (!isWhite) {
                    p.setAttribute("fill", fill);
                    nodes += ((p.getAttribute("d") || "").match(/[ML]/gi) || []).length;
                    kept++;
                }
            });
            svg.removeAttribute("style");
            svg.setAttribute("shape-rendering", "geometricPrecision");

            this._svg = new XMLSerializer().serializeToString(svg);
            this._svgHost.innerHTML = this._svg;
            const live = this._svgHost.querySelector("svg");
            if (live) this._drawNodes(live);   // display only — never in the saved file

            const w = parseFloat(svg.getAttribute("width")) || this._orig.w;
            const h = parseFloat(svg.getAttribute("height")) || this._orig.h;
            this._hud.innerHTML =
                `<b>${this._orig.w}×${this._orig.h}</b> px source<br>` +
                `${kept} path${kept === 1 ? "" : "s"} · ${nodes} nodes<br>` +
                `output ${Math.round(w)}×${Math.round(h)}`;

            const ready = kept > 0;
            this._saveBtn.disabled = !ready;
            this._copyBtn.disabled = !ready;
        }

        /* ------------------------------------------------------------ nodes -- */

        _drawNodes(svgEl) {
            svgEl.querySelector(".vz-nodes-g")?.remove();
            if (!this.ui.nodes.checked) return;
            const accent = getComputedStyle(this).getPropertyValue("--accent").trim();
            const ground = getComputedStyle(this).getPropertyValue("--viewport-bg").trim();
            const g = document.createElementNS(SVG_NS, "g");
            g.setAttribute("class", "vz-nodes-g");
            svgEl.querySelectorAll("path").forEach((p) => {
                anchorPoints(p.getAttribute("d") || "").forEach(([x, y]) => {
                    const c = document.createElementNS(SVG_NS, "circle");
                    c.setAttribute("cx", x);
                    c.setAttribute("cy", y);
                    c.setAttribute("fill", accent);
                    c.setAttribute("stroke", ground);
                    g.appendChild(c);
                });
            });
            svgEl.appendChild(g);
            this._sizeNodes();
        }

        /** Constant on-screen marker size: screen radius → SVG user units at the current scale. */
        _sizeNodes() {
            const svgEl = this._svgHost?.querySelector("svg");
            const g = svgEl?.querySelector(".vz-nodes-g");
            if (!g) return;
            const vb = (svgEl.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
            const vbW = vb.length === 4 ? vb[2] : (svgEl.clientWidth || 1000);
            const rectW = svgEl.getBoundingClientRect().width;
            const pxPerUnit = rectW > 0 ? rectW / vbW : 1;
            g.querySelectorAll("circle").forEach((c) => {
                c.setAttribute("r", NODE_SCREEN_R / pxPerUnit);
                c.setAttribute("stroke-width", 1 / pxPerUnit);
            });
        }
    }

    sac.app.define("app-vectorizer", AppVectorizer);
})();
