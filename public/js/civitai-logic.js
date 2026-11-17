// Deliberately conservative: prompt strings are NOT proof of a reproducible workflow.
function parseObject(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try { return JSON.parse(t); } catch { return value; }
}
function isGraph(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (Array.isArray(candidate)) return candidate.length > 0 && candidate.some(n => n && typeof n === 'object' && ('class_type' in n || ('type' in n && 'id' in n)));
  if (Array.isArray(candidate.nodes) && candidate.nodes.length > 0) {
    return candidate.nodes.some(n => n && typeof n === 'object' && ('type' in n || 'class_type' in n));
  }
  // ComfyUI API prompt format: node IDs -> {class_type, inputs}.
  const entries = Object.entries(candidate);
  return entries.length > 0 && entries.some(([k,v]) => /^\d+$/.test(k) && v && typeof v === 'object' && typeof v.class_type === 'string' && v.inputs && typeof v.inputs === 'object');
}
export function extractWorkflow(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const queue = [meta];
  const seen = new Set();
  for (let i=0; i<queue.length; i++) {
    const obj = parseObject(queue[i]);
    if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    if (isGraph(obj)) return obj;
    for (const k of ['comfy','workflow','Workflow','comfyuiWorkflow','comfyWorkflow','comfyui','ComfyUI','extra_pnginfo','extra','prompt','Prompt','api_prompt','generationData','metadata']) {
      if (obj[k] != null) queue.push(obj[k]);
    }
  }
  return null;
}
export function workflowTier(meta) {
  if (!meta || typeof meta !== 'object') return 'none';
  if (extractWorkflow(meta)) return 'graph';
  const keys = ['prompt','negativePrompt','seed','steps','sampler','cfgScale','resources','civitaiResources','workflow'];
  return keys.some(k => meta[k] !== undefined && meta[k] !== null) ? 'params' : 'none';
}
/** LoRA file name -> comparable stem ("QWEN Loras/A2R_2509.safetensors" -> "a2r_2509"). */
export const fileStem = (name) => String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, '').trim().toLowerCase();
/**
 * Civitai lists linked resources in civitaiResources (with version IDs) and,
 * for many ComfyUI uploads, in additionalResources (file names + strength only).
 */
export function resourcesOf(image) {
  const meta = image?.meta || {};
  const linked = Array.isArray(meta.civitaiResources) ? meta.civitaiResources : [];
  const files = Array.isArray(meta.additionalResources)
    ? meta.additionalResources.filter(r => r && typeof r === 'object' && r.name)
      .map(r => ({ type: r.type, name: r.name, weight: r.strength ?? r.weight ?? null, fromFile: true }))
    : [];
  return [...linked, ...files];
}
export function hasResourceType(image, type) {
  return resourcesOf(image).some(r => {
    const value = String(r.type || '').toLowerCase();
    return type === 'checkpoint' ? (value === 'checkpoint' || value === 'model') : (value === 'lora' || value === 'locon' || value === 'lycoris');
  });
}
export function matchesImage(image, opts, blocked = new Set()) {
  if (!image || blocked.has(String(image.username || '').toLowerCase())) return false;
  const tier = workflowTier(image.meta);
  if (opts.workflow === 'graph' && tier !== 'graph') return false;
  if (opts.workflow === 'params' && tier === 'none') return false;
  if (opts.resourceType === 'mine') {
    // "Uses a LoRA from My LoRAs": the caller supplies the set of owned version IDs.
    const owned = opts.ownedVersionIds || new Set();
    const names = opts.ownedNames || new Set();
    if (!resourcesOf(image).some(r => owned.has(Number(r.modelVersionId)) || (r.name && names.has(fileStem(r.name))))) return false;
  } else if (opts.resourceType !== 'all' && !hasResourceType(image, opts.resourceType)) return false;
  if (opts.minLikes && (Number(image.stats?.likeCount) || 0) < Number(opts.minLikes)) return false;
  if (opts.orientation === 'portrait' && !(image.height > image.width)) return false;
  if (opts.orientation === 'landscape' && !(image.width > image.height)) return false;
  if (opts.orientation === 'square' && !(Math.abs(image.width - image.height) / Math.max(image.width || 1, image.height || 1) < .12)) return false;
  if (opts.text?.trim()) {
    const terms = opts.text.toLowerCase().split(/\s+/).filter(Boolean);
    const meta = image.meta || {};
    const blob = [image.username, image.baseModel, meta.prompt, meta.negativePrompt,
      JSON.stringify(meta), ...resourcesOf(image).map(r => `${r.name || ''} ${r.type || ''}`)].filter(v => typeof v === 'string').join(' ').toLowerCase();
    if (!terms.every(term => blob.includes(term))) return false;
  }
  return true;
}
