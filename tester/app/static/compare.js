/* LoRA Tester — visual compare viewer (1x1 flipper and tiled grid). */
"use strict";

window.LoraCompare = (() => {
  const state = {
    job: null,
    loraId: "",
    promptId: "",
    vary: "strength", // "strength" | "lora"
    strength: null, // fixed strength when vary === "lora"
    mode: "grid", // "single" | "grid"
    cols: 0, // 0 = auto fit
    index: 0,
  };
  let root = null;
  const els = {};

  const fmt = (v) => {
    const n = Number(v);
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const results = () => (state.job && state.job.results) || [];

  function loras() {
    const ids = new Set(results().map((r) => r.lora_id));
    return ((state.job && state.job.loras) || []).filter((l) => ids.has(l.lora_id));
  }

  function prompts() {
    const ids = new Set(results().map((r) => r.prompt_id));
    return ((state.job && state.job.prompts) || []).filter((p) => ids.has(p.id));
  }

  function allStrengths() {
    return [...new Set(results().map((r) => Number(r.strength)))].sort((a, b) => a - b);
  }

  function series() {
    if (state.vary === "strength") {
      return results()
        .filter((r) => r.lora_id === state.loraId && r.prompt_id === state.promptId)
        .sort((a, b) => Number(a.strength) - Number(b.strength))
        .map((r) => ({ url: r.url, label: fmt(r.strength), sub: "", strength: Number(r.strength), w: r.width, h: r.height }));
    }
    const names = new Map(loras().map((l) => [l.lora_id, l.display_name]));
    return results()
      .filter((r) => r.prompt_id === state.promptId && Number(r.strength) === Number(state.strength))
      .map((r) => ({
        url: r.url,
        label: names.get(r.lora_id) || r.lora_name,
        sub: `strength ${fmt(r.strength)}`,
        loraId: r.lora_id,
        w: r.width,
        h: r.height,
      }));
  }

  function build() {
    root = el("div", "cmp");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Compare images");

    const bar = el("div", "cmp-bar");
    els.lora = el("select");
    els.lora.setAttribute("aria-label", "LoRA");
    els.prompt = el("select");
    els.prompt.setAttribute("aria-label", "Prompt");
    els.varyWrap = el("div", "cmp-seg");
    els.varyStrength = el("button", "", "Flip strengths");
    els.varyLora = el("button", "", "Flip LoRAs");
    els.varyStrength.type = els.varyLora.type = "button";
    els.varyWrap.append(els.varyStrength, els.varyLora);
    const viewWrap = el("div", "cmp-seg");
    els.viewSingle = el("button", "", "1×1");
    els.viewGrid = el("button", "", "Grid");
    els.viewSingle.type = els.viewGrid.type = "button";
    viewWrap.append(els.viewSingle, els.viewGrid);
    els.cols = el("select");
    els.cols.setAttribute("aria-label", "Grid columns");
    [["0", "Auto fit"], ["2", "2 across"], ["3", "3 across"], ["4", "4 across"], ["5", "5 across"], ["6", "6 across"], ["8", "8 across"]].forEach(
      ([v, t]) => els.cols.append(new Option(t, v))
    );
    const close = el("button", "cmp-close", "✕ Close");
    close.type = "button";
    bar.append(els.lora, els.prompt, els.varyWrap, viewWrap, els.cols, el("span", "cmp-spacer"), close);

    els.stage = el("div", "cmp-stage");
    els.foot = el("div", "cmp-foot");
    const help = el("div", "cmp-help", "← → change strength · ↑ ↓ change prompt · G grid / 1×1 · scroll wheel flips · Esc closes");

    root.append(bar, els.stage, els.foot, help);
    document.body.append(root);

    els.lora.addEventListener("change", () => {
      state.loraId = els.lora.value;
      render();
    });
    els.prompt.addEventListener("change", () => {
      state.promptId = els.prompt.value;
      render();
    });
    els.varyStrength.addEventListener("click", () => setVary("strength"));
    els.varyLora.addEventListener("click", () => setVary("lora"));
    els.viewSingle.addEventListener("click", () => setMode("single"));
    els.viewGrid.addEventListener("click", () => setMode("grid"));
    els.cols.addEventListener("change", () => {
      state.cols = Number(els.cols.value);
      render();
    });
    close.addEventListener("click", closeViewer);
    els.stage.addEventListener(
      "wheel",
      (event) => {
        if (state.mode !== "single") return;
        event.preventDefault();
        step(event.deltaY > 0 ? 1 : -1);
      },
      { passive: false }
    );
    new ResizeObserver(() => {
      if (state.mode === "grid" && !root.hidden) layoutGrid();
    }).observe(els.stage);
  }

  function setVary(vary) {
    if (vary === state.vary) return;
    if (vary === "lora") {
      if (loras().length < 2) return;
      const cur = series()[Math.min(state.index, series().length - 1)];
      state.strength = cur && cur.strength !== undefined ? cur.strength : allStrengths()[0];
      state.vary = "lora";
      state.index = Math.max(0, loras().findIndex((l) => l.lora_id === state.loraId));
    } else {
      const cur = series()[Math.min(state.index, series().length - 1)];
      state.vary = "strength";
      if (cur && cur.loraId) state.loraId = cur.loraId;
      state.index = Math.max(0, series().findIndex((s) => s.strength === Number(state.strength)));
    }
    render();
  }

  function setMode(mode) {
    state.mode = mode;
    render();
  }

  function setIndex(index) {
    const list = series();
    if (!list.length) return;
    state.index = Math.min(list.length - 1, Math.max(0, index));
    if (state.mode === "grid") highlight();
    else render();
  }

  const step = (delta) => setIndex(state.index + delta);

  function stepPrompt(delta) {
    const list = prompts();
    const i = list.findIndex((p) => p.id === state.promptId);
    const next = list[(i + delta + list.length) % list.length];
    if (next) {
      state.promptId = next.id;
      render();
    }
  }

  function fillControls() {
    els.lora.replaceChildren(...loras().map((l) => new Option(l.display_name, l.lora_id)));
    els.lora.value = state.loraId;
    els.lora.hidden = state.vary === "lora";
    els.prompt.replaceChildren(...prompts().map((p) => new Option(p.label, p.id)));
    els.prompt.value = state.promptId;
    els.varyWrap.hidden = loras().length < 2;
    els.varyStrength.classList.toggle("on", state.vary === "strength");
    els.varyLora.classList.toggle("on", state.vary === "lora");
    els.viewSingle.classList.toggle("on", state.mode === "single");
    els.viewGrid.classList.toggle("on", state.mode === "grid");
    els.cols.hidden = state.mode !== "grid";
    els.cols.value = String(state.cols);
  }

  function renderFoot() {
    els.foot.replaceChildren();
    if (state.vary === "lora") {
      const row = el("div", "cmp-chips");
      row.append(el("span", "cmp-chip-label", "Strength"));
      allStrengths().forEach((s) => {
        const b = el("button", s === Number(state.strength) ? "on" : "", fmt(s));
        b.type = "button";
        b.addEventListener("click", () => {
          state.strength = s;
          render();
        });
        row.append(b);
      });
      els.foot.append(row);
    }
    const list = series();
    const row = el("div", "cmp-chips");
    if (state.mode === "single" && list.length > 1) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = String(list.length - 1);
      slider.step = "1";
      slider.value = String(state.index);
      slider.className = "cmp-slider";
      slider.setAttribute("aria-label", "Position in series");
      slider.addEventListener("input", () => {
        state.index = Number(slider.value);
        renderStage();
        markChips();
      });
      row.append(slider);
    }
    list.forEach((item, i) => {
      const b = el("button", i === state.index ? "on" : "", item.label);
      b.type = "button";
      b.dataset.i = String(i);
      b.addEventListener("click", () => setIndex(i));
      row.append(b);
    });
    els.foot.append(row);
  }

  function markChips() {
    els.foot.querySelectorAll("button[data-i]").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === state.index));
    const slider = els.foot.querySelector(".cmp-slider");
    if (slider) slider.value = String(state.index);
  }

  function renderStage() {
    const list = series();
    if (!list.length) {
      els.stage.replaceChildren(el("div", "cmp-empty", "No images to compare here."));
      return;
    }
    if (state.index >= list.length) state.index = list.length - 1;
    if (state.mode === "single") {
      els.stage.style.overflow = "hidden";
      const item = list[state.index];
      const wrap = el("div", "cmp-single");
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.label;
      const tag = el("div", "cmp-tag");
      tag.append(el("strong", "", item.label));
      if (item.sub) tag.append(el("span", "", item.sub));
      tag.append(el("span", "", `${state.index + 1} / ${list.length}`));
      const prev = el("button", "cmp-nav prev", "‹");
      const next = el("button", "cmp-nav next", "›");
      prev.type = next.type = "button";
      prev.setAttribute("aria-label", "Previous");
      next.setAttribute("aria-label", "Next");
      prev.disabled = state.index <= 0;
      next.disabled = state.index >= list.length - 1;
      prev.addEventListener("click", () => step(-1));
      next.addEventListener("click", () => step(1));
      wrap.append(img, tag, prev, next);
      els.stage.replaceChildren(wrap);
      return;
    }
    const grid = el("div", "cmp-grid");
    list.forEach((item, i) => {
      const tile = el("button", "cmp-tile");
      tile.type = "button";
      tile.dataset.i = String(i);
      tile.title = "Click to view 1×1";
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.label;
      const tag = el("div", "cmp-tag small", item.label);
      tile.append(img, tag);
      tile.addEventListener("click", () => {
        state.index = i;
        setMode("single");
      });
      grid.append(tile);
    });
    els.stage.replaceChildren(grid);
    layoutGrid();
    highlight();
  }

  function highlight() {
    els.stage.querySelectorAll(".cmp-tile").forEach((t) => t.classList.toggle("on", Number(t.dataset.i) === state.index));
    markChips();
  }

  // Tiles are sized so the whole set fills the screen with no gaps ("cube" view).
  function layoutGrid() {
    const grid = els.stage.querySelector(".cmp-grid");
    const list = series();
    if (!grid || !list.length) return;
    const W = els.stage.clientWidth;
    const H = els.stage.clientHeight;
    const aspect = list[0].w && list[0].h ? list[0].w / list[0].h : 2 / 3;
    let cols = state.cols;
    if (!cols) {
      let best = 0;
      for (let c = 1; c <= list.length; c++) {
        const rows = Math.ceil(list.length / c);
        const scale = Math.min(W / c / aspect, H / rows);
        if (scale > best) {
          best = scale;
          cols = c;
        }
      }
    }
    cols = Math.max(1, Math.min(cols, list.length));
    const rows = Math.ceil(list.length / cols);
    const tileH = Math.max(40, Math.min(H / rows, W / cols / aspect));
    const tileW = tileH * aspect;
    grid.style.gridTemplateColumns = `repeat(${cols}, ${Math.floor(tileW)}px)`;
    grid.style.gridAutoRows = `${Math.floor(tileH)}px`;
    els.stage.style.overflow = rows * tileH > H + 1 ? "auto" : "hidden";
  }

  function render() {
    fillControls();
    renderStage();
    renderFoot();
    series().forEach((item) => {
      const img = new Image();
      img.src = item.url;
    });
  }

  function onKey(event) {
    if (!root || root.hidden) return;
    const tag = event.target && event.target.tagName;
    if ((tag === "SELECT" || tag === "TEXTAREA") && event.key !== "Escape") return;
    switch (event.key) {
      case "Escape":
        closeViewer();
        break;
      case "ArrowLeft":
        event.preventDefault();
        step(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        stepPrompt(-1);
        break;
      case "ArrowDown":
        event.preventDefault();
        stepPrompt(1);
        break;
      case "Home":
        event.preventDefault();
        setIndex(0);
        break;
      case "End":
        event.preventDefault();
        setIndex(series().length - 1);
        break;
      case "g":
      case "G":
        setMode(state.mode === "grid" ? "single" : "grid");
        break;
      default:
        break;
    }
  }

  function open(job, options = {}) {
    if (!job || !(job.results || []).length) return;
    state.job = job;
    const ls = loras();
    state.loraId = ls.some((l) => l.lora_id === options.loraId) ? options.loraId : (ls[0] && ls[0].lora_id) || "";
    const ps = prompts();
    state.promptId = ps.some((p) => p.id === options.promptId) ? options.promptId : (ps[0] && ps[0].id) || "";
    state.vary = "strength";
    state.mode = options.mode || "grid";
    state.strength = null;
    state.index = 0;
    if (!root) {
      build();
      document.addEventListener("keydown", onKey);
    }
    root.hidden = false;
    document.body.classList.add("cmp-open");
    if (options.strength !== undefined) {
      state.index = Math.max(0, series().findIndex((s) => s.strength === Number(options.strength)));
    }
    render();
  }

  function closeViewer() {
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove("cmp-open");
  }

  return { open, close: closeViewer };
})();
