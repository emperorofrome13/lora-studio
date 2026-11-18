/* LoRA Tester frontend */
"use strict";

const STRENGTHS = [-2.0, -1.5, -1.0, -0.25, 0.25, 1.0, 1.5, 2.0];
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

const state = {
  status: null,
  defaults: null,
  imports: [],
  selectedLoras: new Set(),
  prompts: [],
  strengths: new Set(STRENGTHS),
  negative: "",
  activeJobId: null,
  displayedJobId: null,
  job: null,
  jobs: [],
  pollTimer: null,
  polling: false,
  promptsReady: false,
  settingsReady: false,
  importsReady: false,
  lastGalleryKey: "",
  uploadBusy: false,
  showUnsupported: false,
  statusLoading: false,
  statusFailed: false,
  toastTimer: null,
  storeTimer: null,
};

const dom = {};

function $(id) {
  return document.getElementById(id);
}

function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    /* Storage can be disabled; the app still works for this session. */
  }
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
    return "—";
  }
  const total = Math.round(Number(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function secondsBetween(startIso, endIso) {
  if (!startIso) return 0;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

function wordCount(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function formatStrength(value) {
  return Number(value).toFixed(2);
}

function shortStatus(status) {
  return String(status || "").replace(/_/g, " ");
}

async function api(path, options = {}) {
  const init = { ...options };
  init.headers = { Accept: "application/json", ...(options.headers || {}) };
  if (init.body && typeof init.body === "string") {
    init.headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(`The server returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (HTTP ${response.status}).`);
    error.detail = data.detail || "";
    throw error;
  }
  return data;
}

function toast(message, kind = "info", duration = 6000) {
  if (!dom.toast) return;
  clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.className = `toast is-visible${kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : kind === "ok" ? " is-ok" : ""}`;
  dom.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    dom.toast.classList.remove("is-visible");
    setTimeout(() => {
      dom.toast.hidden = true;
    }, 220);
  }, duration);
}

function showNotice(title, text, kind = "warn") {
  if (!dom.notice) return;
  dom.noticeTitle.textContent = title;
  dom.noticeText.textContent = text;
  dom.notice.className = `notice${kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : ""}`;
  dom.notice.hidden = false;
}

function hideNotice() {
  if (dom.notice) dom.notice.hidden = true;
}

function setComfyPill(mode, text) {
  if (!dom.comfyPill) return;
  dom.comfyPill.className = `status-pill ${mode === "online" ? "is-online" : mode === "offline" ? "is-offline" : "is-waiting"}`;
  dom.comfyPillText.textContent = text;
}

function setVersion(version) {
  const label = `v${version}`;
  if (dom.versionBadge) dom.versionBadge.textContent = label;
  if (dom.footerVersion) dom.footerVersion.textContent = label;
  document.title = `LoRA Tester ${label}`;
}

function cacheDom() {
  dom.body = document.body;
  dom.comfyPill = $("comfyPill");
  dom.comfyPillText = $("comfyPillText");
  dom.versionBadge = $("versionBadge");
  dom.footerVersion = $("footerVersion");
  dom.themeSelect = $("themeSelect");
  dom.notice = $("notice");
  dom.noticeTitle = $("noticeTitle");
  dom.noticeText = $("noticeText");
  dom.noticeClose = $("noticeClose");
  dom.comfyUrl = $("comfyUrl");
  dom.saveUrlBtn = $("saveUrlBtn");
  dom.reconnectBtn = $("reconnectBtn");
  dom.checkpointSelect = $("checkpointSelect");
  dom.checkpointHint = $("checkpointHint");
  dom.modelNotice = $("modelNotice");
  dom.modelTools = $("modelTools");
  dom.showUnsupportedInput = $("showUnsupportedInput");
  dom.unsupportedToggleText = $("unsupportedToggleText");
  dom.unsupportedDetails = $("unsupportedDetails");
  dom.unsupportedSummary = $("unsupportedSummary");
  dom.unsupportedList = $("unsupportedList");
  dom.archHint = $("archHint");
  dom.refreshCheckpointsBtn = $("refreshCheckpointsBtn");
  dom.lorasDir = $("lorasDir");
  dom.lorasDirHint = $("lorasDirHint");
  dom.browseLorasBtn = $("browseLorasBtn");
  dom.autoDetectBtn = $("autoDetectBtn");
  dom.saveLorasBtn = $("saveLorasBtn");
  dom.dropzone = $("dropzone");
  dom.zipInput = $("zipInput");
  dom.chooseZipBtn = $("chooseZipBtn");
  dom.importProgress = $("importProgress");
  dom.importBar = $("importBar");
  dom.importStatus = $("importStatus");
  dom.importNotice = $("importNotice");
  dom.importNoticeText = $("importNoticeText");
  dom.importList = $("importList");
  dom.selectAllBtn = $("selectAllBtn");
  dom.clearAllBtn = $("clearAllBtn");
  dom.promptList = $("promptList");
  dom.negativePrompt = $("negativePrompt");
  dom.negativeCount = $("negativeCount");
  dom.strengthList = $("strengthList");
  dom.resetPromptsBtn = $("resetPromptsBtn");
  dom.resolutionPreset = $("resolutionPreset");
  dom.widthInput = $("widthInput");
  dom.heightInput = $("heightInput");
  dom.stepsInput = $("stepsInput");
  dom.cfgInput = $("cfgInput");
  dom.samplerSelect = $("samplerSelect");
  dom.schedulerSelect = $("schedulerSelect");
  dom.seedInput = $("seedInput");
  dom.randomSeedBtn = $("randomSeedBtn");
  dom.cleanupInput = $("cleanupInput");
  dom.startBtn = $("startBtn");
  dom.cancelBtn = $("cancelBtn");
  dom.startHint = $("startHint");
  dom.sumCheckpoint = $("sumCheckpoint");
  dom.sumLoras = $("sumLoras");
  dom.sumPrompts = $("sumPrompts");
  dom.sumStrengths = $("sumStrengths");
  dom.sumImages = $("sumImages");
  dom.jobPanel = $("jobPanel");
  dom.jobStatus = $("jobStatus");
  dom.jobBar = $("jobBar");
  dom.jobBarWrap = document.querySelector(".job-bar");
  dom.jobDone = $("jobDone");
  dom.jobFailed = $("jobFailed");
  dom.jobElapsed = $("jobElapsed");
  dom.jobEta = $("jobEta");
  dom.jobCurrent = $("jobCurrent");
  dom.jobError = $("jobError");
  dom.jobErrorTitle = $("jobErrorTitle");
  dom.jobErrorText = $("jobErrorText");
  dom.jobErrorDetailsWrap = $("jobErrorDetailsWrap");
  dom.jobErrorDetails = $("jobErrorDetails");
  dom.imageErrors = $("imageErrors");
  dom.jobLog = $("jobLog");
  dom.cancelJobBtn = $("cancelJobBtn");
  dom.openJobOutputBtn = $("openJobOutputBtn");
  dom.resultsSub = $("resultsSub");
  dom.downloadAllBtn = $("downloadAllBtn");
  dom.gallery = $("gallery");
  dom.historyList = $("historyList");
  dom.openOutputBtn = $("openOutputBtn");
  dom.toast = $("toast");
}

function applyTheme(theme) {
  const allowed = ["neon", "amber", "mono"];
  const chosen = allowed.includes(theme) ? theme : "neon";
  document.body.dataset.theme = chosen;
  if (dom.themeSelect) dom.themeSelect.value = chosen;
  try {
    localStorage.setItem("lt_theme", chosen);
  } catch (_error) {
    /* ignore */
  }
}

function fillSelect(select, values, desired) {
  if (!select) return "";
  const unique = [];
  (values || []).forEach((value) => {
    const text = String(value);
    if (text && !unique.includes(text)) unique.push(text);
  });
  select.replaceChildren();
  unique.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  if (desired && unique.includes(String(desired))) {
    select.value = String(desired);
  } else if (unique.length) {
    select.value = unique[0];
  }
  return select.value;
}

function modelOptionsList() {
  return (state.status && state.status.comfy && state.status.comfy.model_options) || [];
}

function isModelSupported(option) {
  return option.supported !== false;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function modelDisplayName(value) {
  const text = String(value || "");
  const split = text.indexOf("::");
  const name = split >= 0 ? text.slice(split + 2) : text;
  if (text.startsWith("unet::")) return `[UNET] ${name}`;
  if (text.startsWith("gguf::")) return `[GGUF] ${name}`;
  return name;
}

function fillModelSelect(select, options, desired) {
  if (!select) return "";
  const list = Array.isArray(options) ? options : [];
  const visible = state.showUnsupported ? list : list.filter(isModelSupported);
  select.replaceChildren();
  const groups = new Map();
  const order = [];
  let firstSupported = "";
  visible.forEach((option) => {
    const groupName = option.group || "Models";
    let group = groups.get(groupName);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = groupName;
      groups.set(groupName, group);
      order.push(group);
    }
    const node = document.createElement("option");
    node.value = String(option.id);
    const supported = isModelSupported(option);
    node.textContent = supported ? String(option.name) : `${option.name} — not supported`;
    node.disabled = !supported;
    if (!supported && option.unsupported_reason) node.title = option.unsupported_reason;
    group.append(node);
    if (supported && !firstSupported) firstSupported = String(option.id);
  });
  if (!visible.length) return "";
  order.forEach((group) => {
    const items = Array.from(group.children);
    const supported = items.filter((node) => !node.disabled).length;
    group.label = state.showUnsupported && supported !== items.length
      ? `${group.label} — ${supported} of ${items.length} supported`
      : `${group.label} — ${items.length}`;
    select.append(group);
  });
  let target = "";
  if (desired) {
    const match =
      list.find((option) => String(option.id) === String(desired)) ||
      list.find((option) => String(option.name) === String(desired));
    if (match && isModelSupported(match)) target = String(match.id);
  }
  select.value = target || firstSupported;
  return select.value;
}

function hideModelNotice() {
  if (!dom.modelNotice) return;
  dom.modelNotice.hidden = true;
  dom.modelNotice.textContent = "";
}

function updateModelNotice(desired, checkMissing) {
  if (!dom.modelNotice) return;
  hideModelNotice();
  if (!checkMissing || !desired) return;
  const options = modelOptionsList();
  if (!options.length) return;
  const match =
    options.find((option) => String(option.id) === String(desired)) ||
    options.find((option) => String(option.name) === String(desired));
  if (match && isModelSupported(match)) return;
  const fallback = currentModelLabel();
  const saved = modelDisplayName(desired);
  let text = match
    ? `Your saved model “${saved}” is not supported by this app.`
    : `Your saved model “${saved}” is no longer installed in ComfyUI.`;
  text += fallback
    ? ` Using “${fallback}” instead — pick another model if needed.`
    : " Pick another model below, or install a supported checkpoint.";
  dom.modelNotice.textContent = text;
  dom.modelNotice.hidden = false;
  if (fallback && currentCheckpoint()) {
    try {
      localStorage.setItem("lt_checkpoint", currentCheckpoint());
    } catch (_error) {
      /* ignore */
    }
  }
}

function updateModelTools(options) {
  if (!dom.modelTools) return;
  const unsupported = (options || []).filter((option) => !isModelSupported(option));
  const online = Boolean(state.status && state.status.comfy && state.status.comfy.online);
  if (!unsupported.length || !online) {
    dom.modelTools.hidden = true;
    dom.unsupportedList.replaceChildren();
    return;
  }
  dom.modelTools.hidden = false;
  dom.showUnsupportedInput.checked = state.showUnsupported;
  dom.unsupportedToggleText.textContent =
    `${state.showUnsupported ? "Hide" : "Show"} ${plural(unsupported.length, "unsupported model")}`;
  dom.unsupportedDetails.hidden = false;
  dom.unsupportedSummary.textContent = `Why are ${unsupported.length} models unavailable?`;

  const groups = new Map();
  unsupported.forEach((option) => {
    const reason = option.unsupported_reason || "";
    const label =
      option.unsupported_label ||
      (/flux1/i.test(reason) ? "Flux1 model" : "Unsupported diffusion model");
    if (!groups.has(label)) {
      groups.set(label, { reason, names: [] });
    }
    groups.get(label).names.push(option.name);
  });
  dom.unsupportedList.replaceChildren();
  groups.forEach((group, label) => {
    const block = make("div", "model-help-group");
    block.append(make("strong", "", `${label} · ${plural(group.names.length, "model")}`));
    if (group.reason) block.append(make("p", "", group.reason));
    const names = document.createElement("details");
    names.className = "model-help-names";
    const summary = document.createElement("summary");
    summary.textContent = `Show ${plural(group.names.length, "model name")}`;
    names.append(summary);
    const list = document.createElement("ul");
    list.className = "model-help-list";
    group.names.forEach((name) => list.append(make("li", "", name)));
    names.append(list);
    block.append(names);
    dom.unsupportedList.append(block);
  });
  dom.unsupportedList.append(
    make(
      "p",
      "hint",
      "These files stay installed in ComfyUI. They are listed only so you can see why the app will not wire them."
    )
  );
}

function updateCheckpointHint() {
  if (!dom.checkpointHint || !state.status) return;
  const comfy = state.status.comfy || {};
  const options = comfy.model_options || [];
  const supportedOptions = options.filter(isModelSupported);
  const supported = supportedOptions.length;
  const unsupported = options.length - supported;
  dom.checkpointHint.className = "hint";
  if (!comfy.online) {
    dom.checkpointHint.textContent = "Models appear after ComfyUI is connected.";
    dom.checkpointHint.classList.add("is-warn");
  } else if (!options.length) {
    dom.checkpointHint.textContent =
      comfy.message || "No checkpoints or diffusion models found in ComfyUI.";
    dom.checkpointHint.classList.add("is-warn");
  } else if (!supported) {
    dom.checkpointHint.textContent =
      `${plural(options.length, "model")} found, but none can be wired by this app. See why some models are unavailable below.`;
    dom.checkpointHint.classList.add("is-warn");
  } else {
    const supportedCheckpoints = supportedOptions.filter(
      (option) => (option.loader || "checkpoint") === "checkpoint"
    ).length;
    const supportedDiffusion = supported - supportedCheckpoints;
    let text =
      `${plural(supported, "model")} ready · ${plural(supportedCheckpoints, "checkpoint")} · ${plural(supportedDiffusion, "diffusion model")}.`;
    if (unsupported) {
      text += ` ${plural(unsupported, "installed model")} ${unsupported === 1 ? "isn't" : "aren't"} supported; ${state.showUnsupported ? "shown disabled" : "hidden"}.`;
    }
    dom.checkpointHint.textContent = text;
  }
}

function renderModelPicker(desired, checkMissing = false) {
  if (!dom.checkpointSelect) return "";
  const comfy = (state.status && state.status.comfy) || {};
  const options = comfy.model_options || [];
  const supported = options.filter(isModelSupported);
  if (!state.status || !comfy.online) {
    dom.checkpointSelect.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = !state.status
      ? "Models unavailable — press Reconnect"
      : "ComfyUI offline — press Reconnect";
    dom.checkpointSelect.append(option);
    dom.checkpointSelect.disabled = true;
    state.checkpoint = "";
    hideModelNotice();
    updateModelTools([]);
    if (!state.status && dom.checkpointHint) {
      dom.checkpointHint.textContent =
        "The app could not read ComfyUI's model list. Press Reconnect to try again.";
      dom.checkpointHint.className = "hint is-warn";
    } else {
      updateCheckpointHint();
    }
    updateArchitectureHint();
    return "";
  }
  if (!supported.length) {
    dom.checkpointSelect.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = options.length ? "No supported models" : "No models found";
    dom.checkpointSelect.append(option);
    dom.checkpointSelect.disabled = true;
    state.checkpoint = "";
    hideModelNotice();
    updateModelTools(options);
    updateCheckpointHint();
    updateArchitectureHint();
    return "";
  }
  const value = fillModelSelect(dom.checkpointSelect, options, desired);
  dom.checkpointSelect.disabled = false;
  state.checkpoint = value;
  updateModelTools(options);
  updateCheckpointHint();
  updateArchitectureHint();
  updateModelNotice(desired, checkMissing);
  return value;
}

function currentModelOption() {
  const value = currentCheckpoint();
  const options = (state.status && state.status.comfy && state.status.comfy.model_options) || [];
  return options.find((option) => String(option.id) === String(value)) || null;
}

function currentModelLabel() {
  const option = currentModelOption();
  if (!option) return modelDisplayName(currentCheckpoint());
  if (option.loader === "unet") return `[UNET] ${option.name}`;
  if (option.loader === "gguf") return `[GGUF] ${option.name}`;
  return option.name;
}

function jobModelLabel(job) {
  const loader = (job && job.model_loader) || "checkpoint";
  const prefix = loader === "unet" ? "[UNET] " : loader === "gguf" ? "[GGUF] " : "";
  return `${prefix}${(job && job.checkpoint) || ""}`;
}

function checkpointInfo(name) {
  if (!state.status || !state.status.comfy) return null;
  const map = state.status.comfy.checkpoint_info || {};
  return map[name] || null;
}

function updateArchitectureHint() {
  if (!dom.archHint) return;
  const info = checkpointInfo(currentCheckpoint());
  if (!info) {
    dom.archHint.hidden = true;
    dom.archHint.textContent = "";
    return;
  }
  const parts = [`Pipeline: ${info.label}`];
  const loaderLabel =
    info.loader === "unet"
      ? "UNET diffusion model"
      : info.loader === "gguf"
        ? "GGUF diffusion model"
        : "checkpoint";
  parts.unshift(`Selected ${loaderLabel}`);
  if (info.clip_name) parts.push(`CLIP ${info.clip_name} (${info.clip_type})`);
  if (info.vae_name) parts.push(`VAE ${info.vae_name}`);
  if (info.shift !== null && info.shift !== undefined) parts.push(`AuraFlow shift ${info.shift}`);
  if (info.clip_skip !== null && info.clip_skip !== undefined) parts.push(`CLIP skip ${info.clip_skip}`);
  parts.push(info.lora_mode === "model" ? "LoRA on diffusion model only" : "LoRA on model + text encoder");
  parts.push(`recommended ${info.steps} steps · CFG ${info.cfg} · ${info.sampler}/${info.scheduler}`);
  let text = parts.join(" · ");
  const warnings = info.warnings || [];
  if (warnings.length) text += " — " + warnings.join(" ");
  dom.archHint.textContent = text;
  dom.archHint.className = `hint arch-hint${warnings.length ? " is-warn" : ""}`;
  dom.archHint.hidden = false;
}

function applyRecommendedSettings(info) {
  if (!info) return;
  if (info.width) dom.widthInput.value = String(info.width);
  if (info.height) dom.heightInput.value = String(info.height);
  if (info.steps) dom.stepsInput.value = String(info.steps);
  if (info.cfg !== undefined && info.cfg !== null) dom.cfgInput.value = String(info.cfg);
  const setSelect = (select, value) => {
    if (!value) return;
    if (Array.from(select.options).some((option) => option.value === String(value))) {
      select.value = String(value);
    }
  };
  setSelect(dom.samplerSelect, info.sampler);
  setSelect(dom.schedulerSelect, info.scheduler);
  if (info.preset && Array.from(dom.resolutionPreset.options).some((option) => option.value === info.preset)) {
    dom.resolutionPreset.value = info.preset;
  } else {
    dom.resolutionPreset.value = "custom";
  }
}

function syncRecommendedForCheckpoint(force, announce) {
  const checkpoint = currentCheckpoint();
  const info = checkpointInfo(checkpoint);
  updateArchitectureHint();
  if (info && force) {
    applyRecommendedSettings(info);
    saveAdvanced();
    if (announce) {
      toast(
        `Using recommended ${info.label} settings: ${info.steps} steps, CFG ${info.cfg}, ${info.sampler}/${info.scheduler}.`,
        "ok",
        6500
      );
    }
  }
  state.lastCheckpoint = checkpoint;
}

function updateLorasDirHint() {
  if (!dom.lorasDirHint || !state.status) return;
  const value = (state.status.loras_dir || "").trim();
  const valid = Boolean(state.status.loras_dir_valid);
  dom.lorasDirHint.className = "hint";
  if (!valid) {
    dom.lorasDirHint.textContent = "Not set. Choose ComfyUI's models\\loras folder so the app can install the test LoRA.";
    dom.lorasDirHint.classList.add("is-warn");
    return;
  }
  const name = value.split(/[\\/]/).filter(Boolean).pop() || value;
  const count = state.status.comfy ? state.status.comfy.lora_count : 0;
  const visible = state.status.comfy && state.status.comfy.online ? ` ComfyUI currently lists ${count} LoRA${count === 1 ? "" : "s"}.` : "";
  dom.lorasDirHint.textContent = `Folder found: ${value}.${visible}`;
  if (name.toLowerCase() !== "loras") {
    dom.lorasDirHint.textContent += " This folder is not named “loras” — make sure it is the folder ComfyUI actually scans.";
    dom.lorasDirHint.classList.add("is-warn");
  }
  if (state.status.loras_dir_note) {
    // e.g. switched to the running ComfyUI's folder, or the folder belongs to another install.
    dom.lorasDirHint.textContent += ` ${state.status.loras_dir_note}`;
    dom.lorasDirHint.classList.add("is-warn");
  }
}

function updateComfyStatus(data) {
  const comfy = data.comfy || {};
  if (comfy.online) {
    const options = comfy.model_options || [];
    const modelCount = options.length;
    const ready = options.filter(isModelSupported).length;
    const label = ready === modelCount
      ? plural(modelCount, "model")
      : `${ready} of ${modelCount} models ready`;
    setComfyPill("online", `ComfyUI online · ${label}`);
    if (comfy.message) {
      showNotice("Model notice", comfy.message, "warn");
    } else {
      hideNotice();
    }
  } else {
    setComfyPill("offline", "ComfyUI offline");
    showNotice("ComfyUI offline", comfy.message || "Start ComfyUI, then press Reconnect.", "error");
  }
  updateCheckpointHint();
  updateLorasDirHint();
}

function mergeImports(nextImports) {
  const previousKeys = new Set();
  state.imports.forEach((manifest) => {
    (manifest.loras || []).forEach((lora) => previousKeys.add(`${manifest.import_id}:${lora.lora_id}`));
  });
  const nextKeys = new Set();
  (nextImports || []).forEach((manifest) => {
    (manifest.loras || []).forEach((lora) => nextKeys.add(`${manifest.import_id}:${lora.lora_id}`));
  });
  if (!state.importsReady) {
    const ordered = [...(nextImports || [])].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );
    if (ordered[0]) {
      (ordered[0].loras || []).forEach((lora) =>
        state.selectedLoras.add(`${ordered[0].import_id}:${lora.lora_id}`)
      );
    }
    state.importsReady = true;
  } else {
    nextKeys.forEach((key) => {
      if (!previousKeys.has(key)) state.selectedLoras.add(key);
    });
    Array.from(state.selectedLoras).forEach((key) => {
      if (!nextKeys.has(key)) state.selectedLoras.delete(key);
    });
  }
  state.imports = nextImports || [];
}

function setModelsLoading(busy) {
  state.statusLoading = busy;
  if (dom.refreshCheckpointsBtn) {
    dom.refreshCheckpointsBtn.disabled = busy;
    dom.refreshCheckpointsBtn.textContent = busy ? "Refreshing…" : "Refresh";
    dom.refreshCheckpointsBtn.setAttribute("aria-busy", busy ? "true" : "false");
  }
  if (dom.checkpointSelect) {
    dom.checkpointSelect.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

async function loadStatus(refresh = false, quiet = false, announce = false) {
  if (!quiet) setComfyPill("waiting", "Checking ComfyUI…");
  setModelsLoading(true);
  try {
    const data = await api(`/api/status${refresh ? "?refresh=1" : ""}`);
    state.status = data;
    state.statusFailed = false;
    state.defaults = data.defaults;
    setVersion(data.version || "1.01");
    if (dom.comfyUrl) dom.comfyUrl.value = data.comfy.url || "";
    if (dom.lorasDir) dom.lorasDir.value = data.loras_dir || "";
    updateComfyStatus(data);

    const desiredCheckpoint =
      state.checkpoint !== undefined && state.checkpoint !== null && state.checkpoint !== ""
        ? state.checkpoint
        : localStorage.getItem("lt_checkpoint") || (data.config && data.config.last_checkpoint) || "";
    renderModelPicker(desiredCheckpoint, !quiet);

    if (!state.settingsReady) {
      initPromptsAndSettings(data);
      state.settingsReady = true;
    } else {
      const sampler = dom.samplerSelect.value;
      const scheduler = dom.schedulerSelect.value;
      fillSelect(dom.samplerSelect, data.comfy.samplers, sampler);
      fillSelect(dom.schedulerSelect, data.comfy.schedulers, scheduler);
      if (state.lastCheckpoint !== state.checkpoint) {
        syncRecommendedForCheckpoint(true, false);
      } else {
        updateArchitectureHint();
      }
    }

    mergeImports(data.imports || []);
    renderImports();
    updateSelectionControls();

    if (data.active_job_id) {
      state.activeJobId = data.active_job_id;
      if (!state.displayedJobId) {
        await loadJobById(data.active_job_id, true);
      } else {
        startPolling();
      }
    } else {
      state.activeJobId = null;
      stopPolling();
    }
    updateSummary();
    if (announce) {
      const ready = (data.comfy.model_options || []).filter(isModelSupported).length;
      toast(
        ready
          ? `Models refreshed: ${plural(ready, "model")} ready.`
          : "Models refreshed, but none can be wired by this app.",
        ready ? "ok" : "warn",
        5000
      );
    }
    return data;
  } catch (error) {
    setComfyPill("offline", "App server offline");
    const unreachable = /failed to fetch|network|load failed|fetch/i.test(error.message || "");
    showNotice(
      "Connection problem",
      unreachable
        ? "The app server is not responding. Press Reconnect to try again."
        : error.message,
      "error"
    );
    state.status = null;
    state.statusFailed = true;
    renderModelPicker("", false);
    updateSummary();
    return null;
  } finally {
    setModelsLoading(false);
  }
}

function initPromptsAndSettings(data) {
  const defaults = data.defaults || {};
  const savedPrompts = readJSON("lt_prompts_v1");
  const source = Array.isArray(defaults.prompts) && defaults.prompts.length ? defaults.prompts : [];
  state.prompts = source.map((prompt) => {
    const saved = Array.isArray(savedPrompts) ? savedPrompts.find((item) => item && item.id === prompt.id) : null;
    return {
      id: prompt.id,
      label: prompt.label,
      text: saved && typeof saved.text === "string" ? saved.text : prompt.text,
      enabled: saved ? saved.enabled !== false : true,
    };
  });
  const savedNegative = localStorage.getItem("lt_negative_v1");
  state.negative = typeof savedNegative === "string" ? savedNegative : defaults.negative || "";
  dom.negativePrompt.value = state.negative;
  updateNegativeCount();
  autoGrowTextarea(dom.negativePrompt, 260);
  renderPrompts();
  renderStrengths(defaults.strengths || STRENGTHS);
  initAdvanced(data);
  state.promptsReady = true;
  persistPrompts();
}

function initAdvanced(data) {
  const saved = readJSON("lt_advanced_v1") || {};
  const config = data.config || {};
  const defaults = data.defaults || {};
  const presets = defaults.resolutions || [];
  dom.resolutionPreset.replaceChildren();
  presets.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    dom.resolutionPreset.append(option);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom size";
  dom.resolutionPreset.append(custom);

  fillSelect(
    dom.samplerSelect,
    data.comfy.samplers,
    saved.sampler || config.last_sampler || "dpmpp_2m"
  );
  fillSelect(
    dom.schedulerSelect,
    data.comfy.schedulers,
    saved.scheduler || config.last_scheduler || "karras"
  );

  const presetId = saved.preset || config.last_resolution || "sdxl_portrait";
  const preset = presets.find((item) => item.id === presetId);
  dom.resolutionPreset.value = preset ? preset.id : "custom";
  dom.widthInput.value = Number(saved.width || (preset ? preset.width : 832));
  dom.heightInput.value = Number(saved.height || (preset ? preset.height : 1216));
  dom.stepsInput.value = Number(saved.steps || config.last_steps || 30);
  dom.cfgInput.value = Number(saved.cfg !== undefined ? saved.cfg : config.last_cfg || 7);
  dom.seedInput.value = Number(saved.seed !== undefined ? saved.seed : config.last_seed || 123456789);
  dom.cleanupInput.checked = Boolean(saved.cleanup !== undefined ? saved.cleanup : config.cleanup_after_run);

  const checkpoint = currentCheckpoint();
  const info = checkpointInfo(checkpoint);
  const modelOption = currentModelOption();
  const savedCheckpoint = saved.checkpoint || "";
  const savedMatches =
    savedCheckpoint === checkpoint ||
    (modelOption &&
      (savedCheckpoint === modelOption.name || savedCheckpoint === currentModelLabel()));
  if (info && !savedMatches) {
    applyRecommendedSettings(info);
  }
  state.lastCheckpoint = checkpoint;
  updateArchitectureHint();
  saveAdvanced();
}

function saveAdvanced() {
  const payload = {
    checkpoint: currentCheckpoint(),
    preset: dom.resolutionPreset.value,
    width: Number(dom.widthInput.value) || 0,
    height: Number(dom.heightInput.value) || 0,
    steps: Number(dom.stepsInput.value) || 0,
    cfg: Number(dom.cfgInput.value) || 0,
    sampler: dom.samplerSelect.value,
    scheduler: dom.schedulerSelect.value,
    seed: Number(dom.seedInput.value),
    cleanup: Boolean(dom.cleanupInput.checked),
  };
  writeJSON("lt_advanced_v1", payload);
  updateSummary();
}

function persistPrompts() {
  const payload = state.prompts.map((prompt) => ({
    id: prompt.id,
    text: prompt.text,
    enabled: prompt.enabled,
  }));
  writeJSON("lt_prompts_v1", payload);
  try {
    localStorage.setItem("lt_negative_v1", state.negative);
  } catch (_error) {
    /* ignore */
  }
}

function schedulePersistPrompts() {
  clearTimeout(state.storeTimer);
  state.storeTimer = setTimeout(persistPrompts, 250);
}

function updateNegativeCount() {
  if (!dom.negativeCount) return;
  dom.negativeCount.textContent = `${wordCount(state.negative)} words`;
}

function autoGrowTextarea(textarea, maxHeight = 360) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight + 2, 140), maxHeight)}px`;
}

function renderPrompts() {
  dom.promptList.replaceChildren();
  state.prompts.forEach((prompt) => {
    const card = make("article", `prompt-card${prompt.enabled ? "" : " is-off"}`);
    card.dataset.promptId = prompt.id;

    const head = make("div", "prompt-head");
    const label = make("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = prompt.enabled;
    checkbox.setAttribute("aria-label", `Include ${prompt.label}`);
    const title = make("span", "", prompt.label);
    label.append(checkbox, title);

    const count = make("span", "prompt-count");
    const reset = make("button", "btn ghost", "Reset this prompt");
    reset.type = "button";

    head.append(label, count, reset);

    const textarea = document.createElement("textarea");
    textarea.value = prompt.text;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", prompt.label);

    const refreshCount = () => {
      const words = wordCount(prompt.text);
      count.textContent = `${words} words`;
      count.className = "prompt-count";
      if (prompt.id === "p5" && (words < 250 || words > 360)) {
        count.textContent = `${words} words · target about 300`;
        count.classList.add("is-warn");
      }
    };
    refreshCount();

    checkbox.addEventListener("change", () => {
      prompt.enabled = checkbox.checked;
      card.classList.toggle("is-off", !prompt.enabled);
      persistPrompts();
      updateSummary();
    });

    textarea.addEventListener("input", () => {
      prompt.text = textarea.value;
      refreshCount();
      autoGrowTextarea(textarea);
      schedulePersistPrompts();
      updateSummary();
    });

    reset.addEventListener("click", () => {
      const original = (state.defaults.prompts || []).find((item) => item.id === prompt.id);
      if (!original) return;
      prompt.text = original.text;
      prompt.enabled = true;
      textarea.value = original.text;
      checkbox.checked = true;
      card.classList.remove("is-off");
      refreshCount();
      autoGrowTextarea(textarea);
      persistPrompts();
      updateSummary();
      toast(`${prompt.label} restored.`, "ok", 2500);
    });

    card.append(head, textarea);
    dom.promptList.append(card);
    requestAnimationFrame(() => autoGrowTextarea(textarea));
  });
}

function renderStrengths(values) {
  const list = Array.isArray(values) && values.length ? values : STRENGTHS;
  dom.strengthList.replaceChildren();
  list.forEach((value) => {
    const strength = Number(value);
    const label = make("label", "chip");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(strength);
    checkbox.checked = state.strengths.has(strength);
    label.classList.toggle("is-on", checkbox.checked);
    const text = make("span", "", formatStrength(strength));
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.strengths.add(strength);
      else state.strengths.delete(strength);
      label.classList.toggle("is-on", checkbox.checked);
      updateSummary();
    });
    label.append(checkbox, text);
    dom.strengthList.append(label);
  });
}

async function removeLoras(items, label) {
  if (!items.length) return;
  const ok = window.confirm(
    `Remove ${label} from the LoRA list?

The LoRA file copy is deleted to free disk space. ` +
      "Your test history and generated images are kept."
  );
  if (!ok) return;
  try {
    const data = await api("/api/imports/remove", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    const fresh = await api("/api/imports");
    mergeImports(fresh.imports || []);
    renderImports();
    updateSummary();
    if (state.job) renderGallery(state.job);
    const note = data.skipped_running ? ` (${data.skipped_running} in the running test were kept)` : "";
    toast(`Removed ${plural(data.removed, "LoRA")}.${note}`, "ok", 4500);
  } catch (error) {
    toast(error.message, "warn", 6000);
  }
}

function removeTestedLoras(job) {
  const present = new Set();
  state.imports.forEach((m) => (m.loras || []).forEach((l) => present.add(`${m.import_id}:${l.lora_id}`)));
  const items = (job.loras || [])
    .filter((l) => present.has(`${l.import_id}:${l.lora_id}`))
    .map((l) => ({ import_id: l.import_id, lora_id: l.lora_id }));
  if (!items.length) {
    toast("The LoRAs from this test are already removed.", "info", 3500);
    return;
  }
  removeLoras(items, plural(items.length, "tested LoRA"));
}

function renderImports() {
  dom.importList.replaceChildren();
  if (!state.imports.length) {
    dom.importList.append(
      make("div", "empty", "No ZIP or LoRA file imported yet. Drop a Civitai ZIP or a single .safetensors LoRA above.")
    );
    return;
  }
  state.imports.forEach((manifest) => {
    const group = make("div", "import-group");
    group.dataset.importId = manifest.import_id;

    const head = make("div", "import-head");
    const title = make("div", "import-title");
    const source = manifest.source_type === "file" ? "Single LoRA file" : "ZIP";
    const name = make("strong", "", manifest.zip_name || source);
    const meta = make(
      "span",
      "",
      `${source} · ${(manifest.loras || []).length} LoRA${(manifest.loras || []).length === 1 ? "" : "s"} · imported ${fmtDate(manifest.created_at)}`
    );
    title.append(name, meta);

    const tools = make("div", "head-tools");
    const select = make("button", "btn small", "Select all");
    select.type = "button";
    select.addEventListener("click", () => {
      (manifest.loras || []).forEach((lora) => state.selectedLoras.add(`${manifest.import_id}:${lora.lora_id}`));
      renderImports();
      updateSummary();
    });
    const none = make("button", "btn small ghost", "None");
    none.type = "button";
    none.addEventListener("click", () => {
      (manifest.loras || []).forEach((lora) => state.selectedLoras.delete(`${manifest.import_id}:${lora.lora_id}`));
      renderImports();
      updateSummary();
    });
    const removeAll = make("button", "btn small danger", "Remove");
    removeAll.type = "button";
    removeAll.title = "Remove every LoRA in this import (test history is kept)";
    removeAll.addEventListener("click", () =>
      removeLoras(
        (manifest.loras || []).map((l) => ({ import_id: manifest.import_id, lora_id: l.lora_id })),
        manifest.zip_name || "this import"
      )
    );
    tools.append(select, none, removeAll);
    head.append(title, tools);
    group.append(head);

    (manifest.loras || []).forEach((lora) => {
      const key = `${manifest.import_id}:${lora.lora_id}`;
      const row = make("div", "lora-row");
      row.dataset.importId = manifest.import_id;
      row.dataset.loraId = lora.lora_id;

      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "lora-check";
      check.checked = state.selectedLoras.has(key);
      check.setAttribute("aria-label", `Include ${lora.display_name}`);
      check.addEventListener("change", () => {
        if (check.checked) state.selectedLoras.add(key);
        else state.selectedLoras.delete(key);
        updateSummary();
      });

      const thumb = make("div", "lora-thumb");
      if (lora.preview) {
        const image = document.createElement("img");
        image.loading = "lazy";
        image.alt = `Sample image from ${lora.display_name}`;
        image.src = `/api/imports/${encodeURIComponent(manifest.import_id)}/file?path=${encodeURIComponent(lora.preview)}`;
        image.addEventListener("error", () => {
          thumb.replaceChildren(make("span", "", "LT"));
        });
        thumb.append(image);
      } else {
        thumb.append(make("span", "", "LT"));
      }

      const info = make("div", "lora-info");
      info.append(make("div", "lora-name", lora.display_name));
      const metaLine = make("div", "lora-meta");
      const pieces = [];
      pieces.push(lora.base_model || "Base model not specified");
      if (lora.rank) pieces.push(`rank ${lora.rank}`);
      pieces.push(fmtBytes(lora.size));
      pieces.forEach((piece, index) => {
        if (index) metaLine.append(make("span", "dotsep", "·"));
        metaLine.append(make("span", "", piece));
      });
      info.append(metaLine);
      if (lora.warning) info.append(make("div", "lora-warning", lora.warning));

      const only = make("button", "btn small ghost only-btn", "Test only this");
      only.type = "button";
      only.title = `Select only ${lora.display_name} for the next test`;
      only.addEventListener("click", () => {
        state.selectedLoras.clear();
        state.selectedLoras.add(key);
        renderImports();
        updateSummary();
        toast(`Only “${lora.display_name}” is selected.`, "ok", 3500);
      });
      info.append(only);
      const removeOne = make("button", "btn small danger only-btn", "Remove");
      removeOne.type = "button";
      removeOne.title = `Remove ${lora.display_name} (its test history is kept)`;
      removeOne.addEventListener("click", () =>
        removeLoras([{ import_id: manifest.import_id, lora_id: lora.lora_id }], `“${lora.display_name}”`)
      );
      info.append(removeOne);

      const trigger = make("div", "trigger-field");
      const toggle = make("label", "trigger-toggle");
      const useTrigger = document.createElement("input");
      useTrigger.type = "checkbox";
      useTrigger.dataset.role = "use-trigger";
      useTrigger.checked = Boolean(lora.trigger);
      useTrigger.setAttribute("aria-label", `Use trigger word for ${lora.display_name}`);
      toggle.append(useTrigger, make("span", "", "Use trigger"));

      const triggerInput = document.createElement("input");
      triggerInput.type = "text";
      triggerInput.dataset.role = "trigger";
      triggerInput.value = lora.trigger || "";
      triggerInput.placeholder = "Optional trigger word";
      triggerInput.setAttribute("aria-label", `Trigger word for ${lora.display_name}`);
      triggerInput.addEventListener("input", () => {
        if (triggerInput.value.trim() && !useTrigger.checked) useTrigger.checked = true;
      });
      trigger.append(toggle, triggerInput);

      row.append(check, thumb, info, trigger);
      group.append(row);
    });

    if ((manifest.skipped || []).length) {
      const note = make(
        "p",
        "hint",
        `${manifest.skipped.length} non-LoRA file${manifest.skipped.length === 1 ? " was" : "s were"} skipped.`
      );
      group.append(note);
    }
    dom.importList.append(group);
  });
  updateSelectionControls();
}

function updateSelectionControls() {
  const total = state.imports.reduce((sum, manifest) => sum + (manifest.loras || []).length, 0);
  const selected = state.selectedLoras.size;
  if (dom.selectAllBtn) dom.selectAllBtn.disabled = total === 0 || selected === total;
  if (dom.clearAllBtn) dom.clearAllBtn.disabled = selected === 0;
}

function collectSelectedLoras() {
  const rows = qsa(".lora-row");
  return rows
    .filter((row) => {
      const check = row.querySelector(".lora-check");
      return check && check.checked;
    })
    .map((row) => {
      const triggerInput = row.querySelector('[data-role="trigger"]');
      const useTrigger = row.querySelector('[data-role="use-trigger"]');
      return {
        import_id: row.dataset.importId,
        lora_id: row.dataset.loraId,
        trigger: triggerInput ? triggerInput.value.trim() : "",
        use_trigger: Boolean(useTrigger && useTrigger.checked),
      };
    });
}

function activePromptCount() {
  return state.prompts.filter((prompt) => prompt.enabled && prompt.text.trim()).length;
}

function selectedStrengthList() {
  return Array.from(state.strengths).filter((value) => Number.isFinite(Number(value))).sort((a, b) => a - b);
}

function currentCheckpoint() {
  return dom.checkpointSelect ? dom.checkpointSelect.value : "";
}

function validationReason() {
  if (!state.status) {
    return state.statusFailed
      ? "The app server is not responding. Press Reconnect to try again."
      : "Waiting for the app to load models.";
  }
  if (!state.status.comfy || !state.status.comfy.online) {
    return "ComfyUI is offline. Start it, then press Reconnect.";
  }
  if (!(state.status.comfy.model_options || []).length) return "ComfyUI reports no models.";
  if (!(state.status.comfy.model_options || []).some(isModelSupported)) {
    return "No model is available that this app can run. See why models are unavailable in step 01.";
  }
  if (!currentCheckpoint()) return "Pick a checkpoint or diffusion model.";
  const pipeline = checkpointInfo(currentCheckpoint());
  if (!pipeline) return "Pick a supported checkpoint or diffusion model.";
  if (pipeline.supported === false) {
    return pipeline.unsupported_reason || "That diffusion model is not supported.";
  }
  if (pipeline.architecture !== "standard") {
    const clips = state.status.comfy.clip_files || [];
    const vaes = state.status.comfy.vae_files || [];
    if (pipeline.clip_name && clips.length && !clips.includes(pipeline.clip_name)) {
      return `The ${pipeline.label} text encoder is missing in ComfyUI (${pipeline.clip_name}).`;
    }
    if (pipeline.vae_name && vaes.length && !vaes.includes(pipeline.vae_name)) {
      return `The ${pipeline.label} VAE is missing in ComfyUI (${pipeline.vae_name}).`;
    }
  }
  if (!state.status.loras_dir_valid) return "Set ComfyUI's models\\loras folder in step 01.";
  const loras = collectSelectedLoras().length;
  if (!loras) return "Import a ZIP or LoRA file, then select at least one LoRA.";
  if (!activePromptCount()) return "Enable at least one prompt with text.";
  if (!state.strengths.size) return "Check at least one strength.";
  const width = Number(dom.widthInput.value);
  const height = Number(dom.heightInput.value);
  if (!width || !height || width % 8 || height % 8) return "Width and height must be multiples of 8.";
  if (state.activeJobId) return "A test is running. Wait for it to finish or cancel it.";
  return "";
}

function updateSummary() {
  if (!dom.sumImages) return;
  const loras = collectSelectedLoras().length;
  const prompts = activePromptCount();
  const strengths = state.strengths.size;
  const total = loras * prompts * strengths;

  dom.sumCheckpoint.textContent = currentModelLabel() || "—";
  dom.sumCheckpoint.title = currentModelLabel() || "";
  dom.sumLoras.textContent = String(loras);
  dom.sumPrompts.textContent = String(prompts);
  dom.sumStrengths.textContent = String(strengths);
  dom.sumImages.textContent = String(total);

  const reason = validationReason();
  dom.startBtn.disabled = Boolean(reason) || state.uploadBusy;
  dom.startBtn.textContent = state.activeJobId ? "Test running…" : "Start LoRA test";
  dom.startHint.textContent = reason || `Ready · ${total} image${total === 1 ? "" : "s"} will be generated.`;
  dom.startHint.className = `hint${reason ? " is-warn" : " is-ok"}`;

  const isActive = Boolean(state.activeJobId);
  dom.cancelBtn.hidden = !isActive;
  dom.cancelJobBtn.hidden = !isActive;
  dom.cancelBtn.disabled = !isActive;
  dom.downloadAllBtn.hidden = !(state.job && state.job.results && state.job.results.length);
}

function statusLabel(status) {
  const labels = {
    queued: "Queued",
    running: "Running",
    cancelling: "Cancelling…",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  };
  return labels[status] || shortStatus(status);
}

function renderJob(job) {
  if (!job) return;
  state.job = job;
  dom.jobPanel.hidden = false;

  const status = job.status || "queued";
  dom.jobStatus.textContent = statusLabel(status);
  dom.jobStatus.className = `job-status is-${status}`;

  const progress = job.progress || {};
  const percent = Number(progress.percent || 0);
  dom.jobBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (dom.jobBarWrap) dom.jobBarWrap.setAttribute("aria-valuenow", String(Math.round(percent)));
  dom.jobDone.textContent = `${progress.done || 0} / ${progress.total || 0}`;
  dom.jobFailed.textContent = String(progress.failed || 0);

  const elapsed = secondsBetween(job.started_at, job.finished_at);
  dom.jobElapsed.textContent = job.started_at ? fmtDuration(elapsed) : "—";
  dom.jobEta.textContent = progress.eta_seconds !== null && progress.eta_seconds !== undefined
    ? fmtDuration(progress.eta_seconds)
    : "—";

  const current = progress.current;
  if (current && !TERMINAL.has(status)) {
    dom.jobCurrent.textContent =
      `${current.lora_name || "LoRA"} · ${current.prompt_label || "Prompt"} · strength ${formatStrength(current.strength)}` +
      (current.elapsed_seconds ? ` · ${fmtDuration(current.elapsed_seconds)} in ComfyUI` : " · rendering…");
  } else if (status === "queued") {
    dom.jobCurrent.textContent = "Queued. The worker will start as soon as ComfyUI is free.";
  } else if (status === "completed") {
    dom.jobCurrent.textContent = `Finished ${fmtDate(job.finished_at)}. Click any image to open it full size.`;
  } else if (status === "cancelled") {
    dom.jobCurrent.textContent = "Cancelled. Finished images were kept.";
  } else if (status === "interrupted") {
    dom.jobCurrent.textContent = "The app closed while this test was running. Finished images were kept.";
  } else if (status === "failed") {
    dom.jobCurrent.textContent = "The test stopped. See the message below.";
  } else {
    dom.jobCurrent.textContent = "";
  }

  if (job.error) {
    dom.jobError.hidden = false;
    dom.jobErrorTitle.textContent = status === "interrupted" ? "Test interrupted" : "Test stopped";
    dom.jobErrorText.textContent = job.error;
    if (job.detail) {
      dom.jobErrorDetailsWrap.hidden = false;
      dom.jobErrorDetails.textContent = job.detail;
    } else {
      dom.jobErrorDetailsWrap.hidden = true;
      dom.jobErrorDetails.textContent = "";
    }
  } else {
    dom.jobError.hidden = true;
  }

  const imageErrors = job.image_errors || [];
  dom.imageErrors.replaceChildren();
  if (imageErrors.length) {
    dom.imageErrors.hidden = false;
    dom.imageErrors.append(make("strong", "", `${imageErrors.length} image${imageErrors.length === 1 ? "" : "s"} failed`));
    const list = make("ul");
    imageErrors.slice(0, 8).forEach((item) => {
      const li = make(
        "li",
        "",
        `${item.lora_name} · ${item.prompt_label} · strength ${formatStrength(item.strength)}: ${item.message}`
      );
      list.append(li);
    });
    dom.imageErrors.append(list);
    if (imageErrors.length > 8) {
      dom.imageErrors.append(make("p", "hint", `${imageErrors.length - 8} more failure(s) are in the activity log.`));
    }
  } else {
    dom.imageErrors.hidden = true;
  }

  const log = job.log || [];
  dom.jobLog.textContent = log
    .map((entry) => `${String(entry.time || "").slice(11, 19)}  ${entry.level === "error" ? "ERR " : entry.level === "warning" ? "WARN " : "     "}${entry.message}`)
    .join("\n");

  dom.resultsSub.textContent = `${plural((job.results || []).length, "image")} · ${jobModelLabel(job)} · ${plural((job.loras || []).length, "LoRA")}`;
  dom.downloadAllBtn.hidden = !(job.results || []).length;
  dom.cancelJobBtn.hidden = !state.activeJobId;
  dom.cancelBtn.hidden = !state.activeJobId;

  const galleryKey = [
    job.id,
    status,
    (job.results || []).length,
    (job.image_errors || []).length,
    (job.contact_sheets || []).length,
    job.error || "",
  ].join("|");
  if (galleryKey !== state.lastGalleryKey) {
    state.lastGalleryKey = galleryKey;
    renderGallery(job);
  }
  updateSummary();
}

function renderGallery(job) {
  dom.gallery.replaceChildren();
  const results = job.results || [];
  if (!results.length) {
    if (job.status === "failed") {
      dom.gallery.append(make("div", "empty", job.error || "The test failed before producing images."));
    } else if (job.status === "queued" || job.status === "running" || job.status === "cancelling") {
      dom.gallery.append(make("div", "empty", "Waiting for the first image. ComfyUI renders one image at a time."));
    } else {
      dom.gallery.append(make("div", "empty", "No images were produced. Check the activity log above."));
    }
    return;
  }

  const sheets = job.contact_sheets || [];
  (job.loras || []).forEach((lora) => {
    const loraResults = results.filter((result) => result.lora_id === lora.lora_id);
    if (!loraResults.length) return;

    const section = make("section", "lora-section");
    const head = make("div", "lora-section-head");
    const title = make("div", "lora-section-title");
    title.append(make("h3", "", lora.display_name));
    const detailParts = [lora.file_name];
    if (lora.base_model) detailParts.push(lora.base_model);
    if (lora.use_trigger && lora.trigger) detailParts.push(`trigger: ${lora.trigger}`);
    title.append(make("p", "", detailParts.join(" · ")));
    head.append(title);

    const links = make("div", "lora-section-links");
    const sheet = sheets.find((item) => item.lora_id === lora.lora_id);
    if (sheet) {
      const link = make("a", "btn small ghost", "Contact sheet (JPG)");
      link.href = sheet.url;
      link.target = "_blank";
      link.rel = "noopener";
      links.append(link);
    }
    const compareAll = make("button", "btn small primary-soft", "Compare");
    compareAll.type = "button";
    compareAll.addEventListener("click", () => window.LoraCompare.open(job, { loraId: lora.lora_id }));
    links.append(compareAll);
    const download = make("button", "btn small ghost", "Download ZIP");
    download.type = "button";
    download.addEventListener("click", () => downloadJob(job.id));
    links.append(download);
    head.append(links);
    section.append(head);

    (job.prompts || []).forEach((prompt) => {
      const promptResults = loraResults
        .filter((result) => result.prompt_id === prompt.id)
        .sort((a, b) => Number(a.strength) - Number(b.strength));
      if (!promptResults.length) return;
      const group = make("div", "prompt-group");
      const groupHead = make("div", "prompt-group-head");
      groupHead.append(make("strong", "", prompt.label));
      groupHead.append(make("span", "", `${promptResults.length} strength${promptResults.length === 1 ? "" : "s"}`));
      const cmp = make("button", "btn small ghost", "Compare ⤢");
      cmp.type = "button";
      cmp.addEventListener("click", () =>
        window.LoraCompare.open(job, { loraId: lora.lora_id, promptId: prompt.id })
      );
      groupHead.append(cmp);
      group.append(groupHead);

      const grid = make("div", "shots");
      promptResults.forEach((result) => {
        const shot = document.createElement("a");
        shot.className = "shot";
        shot.href = result.url;
        shot.title = "Click to compare strengths (Ctrl+click opens the full-size image)";
        shot.addEventListener("click", (event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          window.LoraCompare.open(job, {
            loraId: lora.lora_id,
            promptId: prompt.id,
            strength: result.strength,
            mode: "single",
          });
        });
        const image = document.createElement("img");
        image.loading = "lazy";
        image.src = result.url;
        image.alt = `${lora.display_name}, ${prompt.label}, strength ${formatStrength(result.strength)}`;
        if (result.width && result.height) {
          image.width = result.width;
          image.height = result.height;
        }
        const meta = make("div", "shot-meta");
        meta.append(make("strong", "", `Strength ${formatStrength(result.strength)}`));
        meta.append(make("span", "", `seed ${result.seed}`));
        shot.append(image, meta);
        grid.append(shot);
      });
      group.append(grid);
      section.append(group);
    });
    dom.gallery.append(section);
  });
}

async function loadJobById(jobId, quiet = false) {
  if (!jobId) return;
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    state.displayedJobId = jobId;
    if (data.active_job_id) state.activeJobId = data.active_job_id;
    state.job = data.job;
    state.lastGalleryKey = "";
    renderJob(data.job);
    renderHistory();
    if (!TERMINAL.has(data.job.status)) {
      state.activeJobId = jobId;
      startPolling();
    } else if (!data.active_job_id) {
      state.activeJobId = null;
      stopPolling();
      updateSummary();
    }
  } catch (error) {
    if (!quiet) toast(error.message, "error", 8000);
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollActiveJob, 2000);
  pollActiveJob();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollActiveJob() {
  if (!state.activeJobId || state.polling) return;
  state.polling = true;
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(state.activeJobId)}`);
    if (state.displayedJobId === state.activeJobId || !state.displayedJobId) {
      state.displayedJobId = data.job.id;
      renderJob(data.job);
    }
    if (TERMINAL.has(data.job.status)) {
      state.activeJobId = data.active_job_id || null;
      stopPolling();
      state.lastGalleryKey = "";
      state.displayedJobId = data.job.id;
      renderJob(data.job);
      loadJobs();
      updateSummary();
      const finishedId = data.job.id;
      [5000, 16000].forEach((delay) => {
        setTimeout(() => {
          if (!state.activeJobId && state.displayedJobId === finishedId) {
            loadJobById(finishedId, true);
          }
        }, delay);
      });
      if (data.job.status === "completed") {
        const failed = (data.job.image_errors || []).length;
        toast(
          failed
            ? `Test finished with ${failed} failed image${failed === 1 ? "" : "s"}.`
            : `Test finished. ${(data.job.results || []).length} images saved.`,
          failed ? "warn" : "ok",
          8000
        );
      } else if (data.job.status === "failed") {
        toast(data.job.error || "The test failed.", "error", 9000);
      } else if (data.job.status === "cancelled") {
        toast("Test cancelled. Finished images were kept.", "warn", 6000);
      }
    } else {
      updateSummary();
    }
  } catch (error) {
    toast(`Lost contact with the running test: ${error.message}`, "error", 9000);
    stopPolling();
  } finally {
    state.polling = false;
  }
}

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    state.jobs = data.jobs || [];
    if (data.active_job_id && !state.activeJobId) {
      state.activeJobId = data.active_job_id;
    }
    renderHistory();
  } catch (_error) {
    /* History is secondary; keep the main screen usable. */
  }
}

function renderHistory() {
  dom.historyList.replaceChildren();
  if (!state.jobs.length) {
    dom.historyList.append(make("div", "empty small", "No tests yet."));
    return;
  }
  state.jobs.forEach((job) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `history-item${job.id === state.displayedJobId ? " is-active" : ""}`;
    const top = make("div", "history-top");
    top.append(make("strong", "", fmtDate(job.created_at)));
    top.append(make("span", `history-status is-${job.status}`, statusLabel(job.status)));
    const meta = make(
      "div",
      "history-meta",
      `${jobModelLabel(job)} · ${job.pipeline_label || job.architecture || "Standard"} · ${plural((job.loras || []).length, "LoRA")} · ${job.result_count || 0}/${job.progress ? job.progress.total : 0} images`
    );
    item.append(top, meta);
    item.addEventListener("click", () => {
      if (state.activeJobId && job.id !== state.activeJobId) {
        toast("A test is running. Wait for it to finish or cancel it before opening another test.", "warn", 6000);
        return;
      }
      loadJobById(job.id);
    });
    dom.historyList.append(item);
  });
}

async function startJob() {
  const reason = validationReason();
  if (reason) {
    toast(reason, "warn", 6000);
    updateSummary();
    return;
  }
  const loras = collectSelectedLoras();
  const prompts = state.prompts
    .filter((prompt) => prompt.enabled && prompt.text.trim())
    .map((prompt) => ({ id: prompt.id, label: prompt.label, text: prompt.text }));
  const payload = {
    checkpoint: currentCheckpoint(),
    loras,
    prompts,
    negative: state.negative,
    strengths: selectedStrengthList(),
    width: Number(dom.widthInput.value),
    height: Number(dom.heightInput.value),
    steps: Number(dom.stepsInput.value),
    cfg: Number(dom.cfgInput.value),
    sampler: dom.samplerSelect.value,
    scheduler: dom.schedulerSelect.value,
    seed: Number(dom.seedInput.value),
    cleanup_after_run: Boolean(dom.cleanupInput.checked),
  };

  dom.startBtn.disabled = true;
  dom.startBtn.textContent = "Starting…";
  try {
    const data = await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    state.activeJobId = data.job.id;
    state.displayedJobId = data.job.id;
    state.job = data.job;
    state.lastGalleryKey = "";
    renderJob(data.job);
    startPolling();
    loadJobs();
    toast(
      `Test queued: ${(data.job.progress && data.job.progress.total) || 0} images across ${loras.length} LoRA${loras.length === 1 ? "" : "s"}.`,
      "ok",
      7000
    );
    $("step4Title").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message, "error", 9000);
    if (error.detail) console.error("Job error detail:", error.detail);
  } finally {
    updateSummary();
  }
}

async function cancelJob() {
  const jobId = state.activeJobId;
  if (!jobId) {
    toast("There is no running test.", "warn", 4000);
    return;
  }
  if (!window.confirm("Stop this test? Images that already finished will be kept.")) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: "{}" });
    toast("Cancelling. The current ComfyUI step will stop first.", "warn", 6000);
    setTimeout(pollActiveJob, 900);
  } catch (error) {
    toast(error.message, "error", 7000);
  }
}

function downloadJob(jobId) {
  if (!jobId) return;
  window.location.href = `/api/jobs/${encodeURIComponent(jobId)}/download`;
}

async function saveComfyUrl() {
  const url = dom.comfyUrl.value.trim();
  if (!url) {
    toast("Enter the ComfyUI address, for example http://127.0.0.1:8188.", "warn", 6000);
    dom.comfyUrl.focus();
    return;
  }
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ comfy_url: url }) });
    toast("Address saved. Reconnecting…", "ok", 3000);
    await loadStatus(true);
  } catch (error) {
    toast(error.message, "error", 8000);
  }
}

async function saveLorasDir() {
  const value = dom.lorasDir.value.trim();
  if (!value) {
    toast("Choose ComfyUI's models\\loras folder first.", "warn", 6000);
    return;
  }
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ loras_dir: value }) });
    toast("LoRA folder saved.", "ok", 3000);
    await loadStatus(false);
  } catch (error) {
    toast(error.message, "error", 8000);
  }
}

async function browseLorasDir() {
  try {
    const data = await api("/api/pick-folder", { method: "POST", body: "{}" });
    if (!data.path) return;
    dom.lorasDir.value = data.path;
    await saveLorasDir();
  } catch (error) {
    toast(error.message, "error", 8000);
  }
}

async function autoDetectLorasDir() {
  try {
    toast("Looking for the running ComfyUI folder…", "info", 3000);
    const data = await api("/api/status?refresh=1");
    state.status = data;
    dom.lorasDir.value = data.loras_dir || "";
    if (data.loras_dir_valid) {
      updateLorasDirHint();
      updateSummary();
      toast(`Found: ${data.loras_dir}`, "ok", 5000);
    } else {
      toast("Could not detect the folder automatically. Use Browse… to pick ComfyUI's models\\loras folder.", "warn", 8000);
    }
  } catch (error) {
    toast(error.message, "error", 8000);
  }
}

async function openFolder(kind) {
  try {
    await api("/api/open-folder", { method: "POST", body: JSON.stringify({ kind }) });
  } catch (error) {
    toast(error.message, "error", 7000);
  }
}

function uploadFiles(files) {
  const allowed = [".zip", ".safetensors", ".pt", ".pth", ".ckpt", ".bin"];
  const list = Array.from(files || []).filter((file) => {
    if (!file || !file.name) return false;
    const lower = file.name.toLowerCase();
    return allowed.some((extension) => lower.endsWith(extension));
  });
  if (!list.length) {
    toast("Choose a Civitai ZIP or a .safetensors / .pt / .pth / .ckpt / .bin LoRA file.", "warn", 6000);
    return;
  }
  if (state.uploadBusy) return;
  state.uploadBusy = true;
  updateSummary();
  dom.importNotice.hidden = true;
  dom.importProgress.hidden = false;
  dom.importBar.style.width = "0%";
  dom.importStatus.textContent = "Uploading…";
  dom.chooseZipBtn.disabled = true;

  const form = new FormData();
  list.forEach((file) => form.append("files", file, file.name));

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/import");
  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
    dom.importBar.style.width = `${percent}%`;
    dom.importStatus.textContent = `Uploading ${percent}% · ${fmtBytes(event.loaded)} of ${fmtBytes(event.total)}`;
  });
  xhr.upload.addEventListener("load", () => {
    dom.importBar.style.width = "100%";
    dom.importStatus.textContent = "Reading the file and looking for LoRAs…";
  });
  xhr.addEventListener("load", async () => {
    let data = null;
    try {
      data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
    } catch (_error) {
      data = null;
    }
    if (!data) {
      toast("The server returned an unreadable response while importing the file.", "error", 8000);
    } else {
      const imports = data.imports || [];
      const errors = data.errors || [];
      if (errors.length) {
        dom.importNotice.hidden = false;
        dom.importNoticeText.textContent = errors.map((item) => `${item.file}: ${item.error}`).join(" ");
      } else if (!imports.length && data.error) {
        dom.importNotice.hidden = false;
        dom.importNoticeText.textContent = data.error;
        toast(data.error, "error", 9000);
      }
      if (imports.length) {
        imports.forEach((manifest) => {
          const index = state.imports.findIndex((item) => item.import_id === manifest.import_id);
          if (index >= 0) state.imports[index] = manifest;
          else state.imports.push(manifest);
          (manifest.loras || []).forEach((lora) => state.selectedLoras.add(`${manifest.import_id}:${lora.lora_id}`));
        });
        renderImports();
        updateSummary();
        const loraCount = imports.reduce((sum, manifest) => sum + (manifest.loras || []).length, 0);
        toast(
          `Imported ${imports.length} file${imports.length === 1 ? "" : "s"} · ${loraCount} LoRA${loraCount === 1 ? "" : "s"} found.`,
          "ok",
          7000
        );
        await loadStatus(false, true);
      } else if (!errors.length && !data.error) {
        toast("No LoRAs were found in the selected file.", "warn", 7000);
      }
      if (errors.length && !imports.length) {
        toast(errors[0].error, "error", 9000);
      }
    }
    dom.importStatus.textContent = "Done.";
    setTimeout(() => {
      dom.importProgress.hidden = true;
      dom.importBar.style.width = "0%";
    }, 700);
    state.uploadBusy = false;
    dom.chooseZipBtn.disabled = false;
    dom.zipInput.value = "";
    updateSummary();
  });
  xhr.addEventListener("error", () => {
    toast("The upload failed. Check that the app is still running and try again.", "error", 8000);
    dom.importProgress.hidden = true;
    state.uploadBusy = false;
    dom.chooseZipBtn.disabled = false;
    updateSummary();
  });
  xhr.send(form);
}

function wireEvents() {
  dom.themeSelect.addEventListener("change", () => applyTheme(dom.themeSelect.value));
  dom.noticeClose.addEventListener("click", hideNotice);
  dom.saveUrlBtn.addEventListener("click", saveComfyUrl);
  dom.reconnectBtn.addEventListener("click", async () => {
    if (dom.comfyUrl.value.trim() && dom.comfyUrl.value.trim() !== (state.status ? state.status.comfy.url : "")) {
      await saveComfyUrl();
    } else {
      await loadStatus(true);
    }
  });
  dom.refreshCheckpointsBtn.addEventListener("click", () => {
    if (state.statusLoading) return;
    loadStatus(true, false, true);
  });
  dom.showUnsupportedInput.addEventListener("change", () => {
    state.showUnsupported = dom.showUnsupportedInput.checked;
    try {
      localStorage.setItem("lt_show_unsupported", state.showUnsupported ? "1" : "0");
    } catch (_error) {
      /* ignore */
    }
    const before = currentCheckpoint();
    const desired = before || localStorage.getItem("lt_checkpoint") || "";
    renderModelPicker(desired, false);
    if (state.checkpoint !== before) syncRecommendedForCheckpoint(true, false);
    updateSummary();
  });
  dom.checkpointSelect.addEventListener("change", () => {
    const changed = state.checkpoint !== dom.checkpointSelect.value;
    state.checkpoint = dom.checkpointSelect.value;
    hideModelNotice();
    try {
      localStorage.setItem("lt_checkpoint", state.checkpoint);
    } catch (_error) {
      /* ignore */
    }
    syncRecommendedForCheckpoint(changed, changed);
    updateSummary();
  });
  dom.browseLorasBtn.addEventListener("click", browseLorasDir);
  dom.saveLorasBtn.addEventListener("click", saveLorasDir);
  dom.autoDetectBtn.addEventListener("click", autoDetectLorasDir);
  dom.lorasDir.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveLorasDir();
  });

  dom.chooseZipBtn.addEventListener("click", () => dom.zipInput.click());
  dom.zipInput.addEventListener("change", () => uploadFiles(dom.zipInput.files));
  ["dragenter", "dragover"].forEach((name) => {
    dom.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dom.dropzone.classList.add("is-drag");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dom.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dom.dropzone.classList.remove("is-drag");
    });
  });
  dom.dropzone.addEventListener("drop", (event) => {
    if (event.dataTransfer && event.dataTransfer.files) uploadFiles(event.dataTransfer.files);
  });

  dom.selectAllBtn.addEventListener("click", () => {
    state.imports.forEach((manifest) => {
      (manifest.loras || []).forEach((lora) => state.selectedLoras.add(`${manifest.import_id}:${lora.lora_id}`));
    });
    renderImports();
    updateSummary();
  });
  dom.clearAllBtn.addEventListener("click", () => {
    state.selectedLoras.clear();
    renderImports();
    updateSummary();
  });

  dom.resetPromptsBtn.addEventListener("click", () => {
    const defaults = (state.defaults && state.defaults.prompts) || [];
    state.prompts.forEach((prompt) => {
      const original = defaults.find((item) => item.id === prompt.id);
      if (original) prompt.text = original.text;
      prompt.enabled = true;
    });
    state.negative = (state.defaults && state.defaults.negative) || state.negative;
    dom.negativePrompt.value = state.negative;
    updateNegativeCount();
    autoGrowTextarea(dom.negativePrompt, 260);
    renderPrompts();
    persistPrompts();
    updateSummary();
    toast("Prompts and negative prompt restored to the defaults.", "ok", 4000);
  });

  dom.negativePrompt.addEventListener("input", () => {
    state.negative = dom.negativePrompt.value;
    updateNegativeCount();
    autoGrowTextarea(dom.negativePrompt, 260);
    schedulePersistPrompts();
  });

  dom.resolutionPreset.addEventListener("change", () => {
    const presetId = dom.resolutionPreset.value;
    const presets = (state.defaults && state.defaults.resolutions) || [];
    const preset = presets.find((item) => item.id === presetId);
    if (preset) {
      dom.widthInput.value = preset.width;
      dom.heightInput.value = preset.height;
    }
    saveAdvanced();
  });
  [dom.widthInput, dom.heightInput].forEach((input) => {
    input.addEventListener("input", () => {
      const presets = (state.defaults && state.defaults.resolutions) || [];
      const match = presets.find(
        (preset) => Number(preset.width) === Number(dom.widthInput.value) && Number(preset.height) === Number(dom.heightInput.value)
      );
      dom.resolutionPreset.value = match ? match.id : "custom";
      saveAdvanced();
    });
  });
  [dom.stepsInput, dom.cfgInput, dom.seedInput, dom.samplerSelect, dom.schedulerSelect].forEach((input) => {
    input.addEventListener("change", saveAdvanced);
    input.addEventListener("input", saveAdvanced);
  });
  dom.cleanupInput.addEventListener("change", saveAdvanced);

  dom.randomSeedBtn.addEventListener("click", () => {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    dom.seedInput.value = String(buffer[0]);
    saveAdvanced();
    toast("New seed set. It is shared across strengths for each prompt.", "ok", 4000);
  });

  dom.startBtn.addEventListener("click", startJob);
  dom.cancelBtn.addEventListener("click", cancelJob);
  dom.cancelJobBtn.addEventListener("click", cancelJob);
  dom.downloadAllBtn.addEventListener("click", () => {
    if (state.job) downloadJob(state.job.id);
  });
  dom.openOutputBtn.addEventListener("click", () => openFolder("output"));
  dom.openJobOutputBtn.addEventListener("click", () => openFolder("output"));
  dom.removeTestedBtn = $("removeTestedBtn");
  dom.removeTestedBtn.addEventListener("click", () => state.job && removeTestedLoras(state.job));

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!dom.startBtn.disabled) startJob();
    }
  });
}

async function init() {
  cacheDom();
  const savedTheme = localStorage.getItem("lt_theme") || "neon";
  applyTheme(savedTheme);
  state.showUnsupported = localStorage.getItem("lt_show_unsupported") === "1";
  wireEvents();
  try {
    setVersion("1.01");
  } catch (_error) {
    /* ignore */
  }
  await Promise.all([loadStatus(false), loadJobs()]);
}

document.addEventListener("DOMContentLoaded", init);
