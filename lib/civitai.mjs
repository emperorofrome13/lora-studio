// Everything that talks to Civitai: the image/model API proxy used by the
// Civitai tab, and the by-hash lookup used by the LoRA library.

const VERSION = '1.0.0';
const remoteHost = (site) => (site === 'red' ? 'https://civitai.red' : 'https://civitai.com');
// API key: the CIVITAI_TOKEN environment variable wins; otherwise the key saved from the
// Civitai tab (data/settings.json). The key itself is never sent back to the browser.
let savedToken = '';
export function setSavedToken(token) { savedToken = String(token || '').trim(); }
const activeToken = () => String(process.env.CIVITAI_TOKEN || '').trim() || savedToken;
const authHeaders = () => (activeToken() ? { Authorization: `Bearer ${activeToken()}` } : {});

/** What the UI may know about the key: whether one is set, where from, and its last 4 characters. */
export function tokenInfo() {
  const env = String(process.env.CIVITAI_TOKEN || '').trim();
  const t = env || savedToken;
  return { configured: Boolean(t), source: env ? 'env' : savedToken ? 'saved' : null, hint: t ? `…${t.slice(-4)}` : '' };
}

/** Basic shape check for a pasted key. Returns an error message, or null when it looks usable. */
export function checkTokenFormat(token) {
  const t = String(token || '').trim();
  if (!t) return 'Paste your Civitai API key first.';
  if (t.length < 16 || t.length > 200) return 'That does not look like a Civitai API key (wrong length).';
  if (!/^[A-Za-z0-9_\-.]+$/.test(t)) return 'That does not look like a Civitai API key (it should be letters and numbers only).';
  return null;
}

/**
 * One request to Civitai with the key, to catch a mistyped key before saving it.
 * Returns 'ok', 'rejected', or 'unknown' (Civitai could not be reached).
 */
export async function testToken(token) {
  try {
    const r = await fetch('https://civitai.com/api/v1/me', {
      headers: { Accept: 'application/json', 'User-Agent': `LoraStudio/${VERSION}`, Authorization: `Bearer ${String(token).trim()}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403) return 'rejected';
    return r.ok ? 'ok' : 'unknown';
  } catch { return 'unknown'; }
}

const allowedImageKeys = new Set(['cursor', 'modelId', 'modelVersionId', 'username', 'userId', 'sort',
  'period', 'nsfw', 'baseModels', 'tags', 'imageId', 'postId']);
const numericKeys = new Set(['modelId', 'modelVersionId', 'userId', 'imageId', 'postId']);
const allowedSorts = new Set(['Most Reactions', 'Most Comments', 'Most Collected', 'Newest', 'Oldest', 'Random']);
const allowedPeriod = new Set(['AllTime', 'Year', 'Month', 'Week', 'Day']);
const allowedNsfw = new Set(['None', 'Soft', 'Mature', 'X', 'true', 'false']);
const allowedModelTypes = new Set(['Checkpoint', 'LORA']);

function putNumeric(params, key, val) {
  if (val !== null && /^\d+$/.test(val) && Number.isSafeInteger(Number(val)) && Number(val) > 0) params.set(key, val);
}

/** Translate a local /api/civitai/(images|models) request into the upstream URL. */
export function buildUpstreamUrl(requestUrl) {
  const site = requestUrl.searchParams.get('site') === 'red' ? 'red' : 'com';
  const models = requestUrl.pathname.endsWith('/models');
  const upstream = new URL(`${remoteHost(site)}/api/v1/${models ? 'models' : 'images'}`);
  const query = upstream.searchParams;
  if (models) {
    query.set('limit', '100');
    const q = (requestUrl.searchParams.get('q') || '').trim();
    if (q) query.set('query', q);
    const cursor = requestUrl.searchParams.get('cursor');
    if (cursor) query.set('cursor', cursor);
    const type = requestUrl.searchParams.get('modelType');
    if (allowedModelTypes.has(type)) query.set('types', type);
    if (site === 'red') query.set('nsfw', 'true');
    return { upstream, site };
  }
  query.set('limit', String(Math.max(1, Math.min(200, Number(requestUrl.searchParams.get('limit')) || 80))));
  query.set('type', 'image');
  query.set('withMeta', 'true');
  for (const [k, v] of requestUrl.searchParams.entries()) {
    if (!allowedImageKeys.has(k) || !v) continue;
    if (numericKeys.has(k)) putNumeric(query, k, v);
    else if (k === 'sort' && allowedSorts.has(v)) query.set(k, v);
    else if (k === 'period' && allowedPeriod.has(v)) query.set(k, v);
    else if (k === 'nsfw' && allowedNsfw.has(v)) query.set(k, v);
    else if (k === 'tags' && /^\d+(,\d+)*$/.test(v)) query.set(k, v);
    else if (k === 'baseModels' || k === 'cursor' || k === 'username') query.set(k, v);
  }
  // .com is always SFW. On .red, leaving nsfw unset silently returns SFW only.
  query.set('nsfw', site === 'com' ? 'None' : (query.get('nsfw') || 'true'));
  return { upstream, site };
}

export async function proxyCivitai(requestUrl) {
  const { upstream, site } = buildUpstreamUrl(requestUrl);
  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json', 'User-Agent': `LoraStudio/${VERSION} (personal Civitai API viewer)`, ...authHeaders() },
      signal: AbortSignal.timeout(35000),
    });
    const txt = await response.text();
    if (!response.ok) {
      const guidance = response.status === 429 ? 'Too many requests. Wait a moment, then reload the gallery.'
        : [401, 403].includes(response.status) ? 'Access was denied. Check your Civitai API token, account permissions, and regional access.'
        : response.status >= 500 ? 'Civitai is temporarily unavailable. Try again, or select a specific model version.'
        : 'Civitai could not use these filters. Check the filters and apply them again.';
      return { status: response.status, body: { error: `Civitai returned ${response.status}. ${guidance}`, site } };
    }
    try { return { status: 200, body: JSON.parse(txt) }; }
    catch { return { status: 502, body: { error: 'Civitai returned a non-JSON response.' } }; }
  } catch (err) {
    return { status: 502, body: { error: err.name === 'TimeoutError' ? 'Civitai timed out. Try again.' : 'Unable to reach Civitai.', detail: String(err.message || err) } };
  }
}

/**
 * Look a file up by SHA256. Returns:
 *   { found: true, modelId, versionId, ... }  on a match
 *   { found: false }                          when Civitai does not know the hash
 *   null                                      on network/server errors (retry later)
 */
export async function lookupByHash(sha256Hex) {
  try {
    const response = await fetch(`https://civitai.red/api/v1/model-versions/by-hash/${sha256Hex.toUpperCase()}`, {
      headers: { Accept: 'application/json', 'User-Agent': `LoraStudio/${VERSION}`, ...authHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    const checkedAt = new Date().toISOString();
    if (response.status === 404) return { found: false, checkedAt };
    if (!response.ok) return null;
    const data = await response.json();
    const image = Array.isArray(data.images) ? data.images.find((img) => img && img.url && img.type !== 'video') || data.images[0] : null;
    return {
      found: true,
      checkedAt,
      modelId: data.modelId || data.model?.id || null,
      versionId: data.id || null,
      title: data.model?.name || data.name || null,
      versionName: data.name || null,
      type: data.model?.type || null,
      baseModel: data.baseModel || null,
      trainedWords: Array.isArray(data.trainedWords) ? data.trainedWords.filter(Boolean) : [],
      image: image?.url || null,
    };
  } catch {
    return null;
  }
}
