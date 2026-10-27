import { sanitizeNaiTags } from './tags.js';

export const DEFAULT_BASE = 'https://api.idlecloud.cc';
export const COOLDOWN_MS = 20_000;
export const DRAW_TIMEOUT_MS = 600_000;
export const HOP_TIMEOUT_MS = 20_000;
export const POLL_MS = 10_000;

export const SENSITIVE_PREFIX = 'rating: sensitive, nsfw, uncensored,';
export const UNCENSORED_TAG = 'uncensored,';
export const FULLBODY_TAG = '1.5::full body,foot::,';
export const FURRY_TAG = 'fur dataset,';

export const MODELS = [
    { id: 'nai-diffusion-5-full', label: 'NAI V5 Full', family: 'v5' },
    { id: 'nai-diffusion-5-curated', label: 'NAI V5 Curated', family: 'v5' },
    { id: 'nai-diffusion-4-5-full', label: 'NAI V4.5 Full', family: 'v4.5' },
    { id: 'nai-diffusion-4-5-furry', label: 'NAI V4.5 Furry', family: 'v4.5', wire: 'nai-diffusion-4-5-full', furry: true },
    { id: 'nai-diffusion-4-5-curated', label: 'NAI V4.5 Curated', family: 'v4.5' },
    { id: 'nai-diffusion-4-full', label: 'NAI V4 Full', family: 'v4' },
    { id: 'nai-diffusion-4-furry', label: 'NAI V4 Furry', family: 'v4', wire: 'nai-diffusion-4-full', furry: true },
    { id: 'nai-diffusion-4-curated', label: 'NAI V4 Curated', family: 'v4', wire: 'nai-diffusion-4-curated-preview' },
    { id: 'nai-diffusion-3', label: 'NAI V3', family: 'v3' },
    { id: 'nai-diffusion-furry-3', label: 'NAI Furry V3', family: 'v3', furry: true },
];

export const SAMPLERS = [
    { id: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { id: 'k_euler', label: 'Euler' },
    { id: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { id: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { id: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { id: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { id: 'ddim_v3', label: 'DDIM' },
];

export const NOISE = [
    { id: 'karras', label: 'Karras' },
    { id: 'native', label: 'Native' },
    { id: 'exponential', label: 'Exponential' },
    { id: 'polyexponential', label: 'Polyexponential' },
];

export const RESOLUTIONS = [
    { label: '竖图 · 长 704×1472', w: 704, h: 1472 },
    { label: '竖图 · 中 832×1216', w: 832, h: 1216 },
    { label: '竖图 · 大 1024×1536', w: 1024, h: 1536 },
    { label: '横图 · 小 768×512', w: 768, h: 512 },
    { label: '横图 · 中 1216×832', w: 1216, h: 832 },
    { label: '横图 · 大 1536×1024', w: 1536, h: 1024 },
    { label: '方图 · 小 640×640', w: 640, h: 640 },
    { label: '方图 · 中 1024×1024', w: 1024, h: 1024 },
    { label: '方图 · 大 1472×1472', w: 1472, h: 1472 },
];

export const UC = {
    heavy:
        'lowres, artistic error, film grain, scan, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negativeXL, negative, negative_hand-neg, extra digits, fewer digits, bad anatomy, bad hands',
    light:
        'lowres, artistic error, scan, worst quality, bad quality, jpeg artifacts, very displeasing, logo, too many watermarks, negativeXL, negative, bad anatomy, bad hands',
    human:
        'lowres, artistic error, scan, worst quality, bad quality, jpeg artifacts, very displeasing, overly naturalistic, logo, too many watermarks, negativeXL, negative, extra digits, bad anatomy',
};

export function modelMeta(id) {
    return MODELS.find((m) => m.id === id) || MODELS[2];
}

export function modelLabel(id) {
    return modelMeta(id).label;
}

export function samplerShort(id) {
    if (id === 'k_euler_ancestral') return 'Euler A';
    return SAMPLERS.find((s) => s.id === id)?.label || id;
}

function joinParts(...parts) {
    return parts
        .map((s) => String(s || '').trim().replace(/,\s*$/, '').trim())
        .filter(Boolean)
        .join(', ');
}

export function joinPrompt(params, grokTail = '') {
    const furry = !!modelMeta(params.model).furry;
    let front = params.promptFront.trim();
    if (furry && !/fur dataset/i.test(front) && !/fur dataset/i.test(params.promptMid)) {
        front = joinParts(FURRY_TAG, front);
    }
    if (params.uncensored && !/uncensored/i.test(front)) front = joinParts(front, UNCENSORED_TAG);
    if (params.fullBody && !/full body/i.test(front)) front = joinParts(front, FULLBODY_TAG);
    const mid = joinParts(params.promptMid, grokTail);
    let back = params.promptBack.trim();
    if (params.sensitive && !/rating:\s*sensitive/i.test(back)) back = joinParts(SENSITIVE_PREFIX, back);
    return joinParts(front, mid, back);
}

export function varietySigma(w, h) {
    return Math.round(19 * Math.sqrt((w * h) / (768 * 512)) * 100) / 100;
}

export function randomSeed() {
    return Math.floor(Math.random() * 4294967295);
}

export function buildPayload(params, grokTail, charTails, seed) {
    const family = modelMeta(params.model).family;
    const v3 = family === 'v3';
    const chars = (params.characters || []).filter((c) => c.enabled);
    const insert = !v3 && chars.length > 0;
    const charCaptions = chars.map((c) => ({
        char_caption: [c.prompt.trim(), charTails[c.id] || ''].filter(Boolean).join(', '),
        centers: [{ x: Number(c.x) || 0.5, y: Number(c.y) || 0.5 }],
    }));
    const charUc = chars.map((c) => ({
        char_caption: (c.uc || '').trim(),
        centers: [{ x: Number(c.x) || 0.5, y: Number(c.y) || 0.5 }],
    }));
    const base = joinPrompt(params, grokTail);
    const useCoords = !!params.useCoords;
    const characterPrompts = chars.map((c) => ({
        prompt: [c.prompt.trim(), charTails[c.id] || ''].filter(Boolean).join(', '),
        uc: (c.uc || '').trim(),
        center: { x: Number(c.x) || 0.5, y: Number(c.y) || 0.5 },
        enabled: true,
    }));
    const parameters = {
        params_version: family === 'v5' ? 4 : 3,
        width: params.width,
        height: params.height,
        scale: params.scale,
        sampler: params.sampler,
        steps: params.steps,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: false,
        autoSmea: false,
        dynamic_thresholding: !!params.decrisper,
        controlnet_strength: 1,
        legacy: false,
        add_original_image: true,
        cfg_rescale: params.cfgRescale,
        noise_schedule: params.noiseSchedule,
        legacy_v3_extend: false,
        skip_cfg_above_sigma: params.varietyPlus ? varietySigma(params.width, params.height) : null,
        use_coords: useCoords,
        legacy_uc: false,
        normalize_coords: true,
        prompt: base,
        negative_prompt: params.negative,
        seed,
        extra_noise_seed: seed,
        prefer_brownian: params.sampler.includes('ancestral') || params.sampler.includes('sde'),
    };
    if (insert) {
        parameters.characterPrompts = characterPrompts;
        parameters.v4_prompt = {
            caption: { base_caption: base, char_captions: charCaptions },
            use_coords: useCoords,
            use_order: true,
        };
        parameters.v4_negative_prompt = {
            caption: { base_caption: params.negative, char_captions: charUc },
            legacy_uc: false,
        };
    } else if (!v3) {
        parameters.v4_prompt = {
            caption: { base_caption: base, char_captions: [] },
            use_coords: false,
            use_order: true,
        };
        parameters.v4_negative_prompt = {
            caption: { base_caption: params.negative, char_captions: [] },
            legacy_uc: false,
        };
    }
    return {
        input: base,
        model: modelMeta(params.model).wire || params.model,
        action: 'generate',
        parameters,
        seed,
        finalPrompt: base,
        characterPrompts,
        insert,
    };
}

export function buildIdlecloudBody(built, params, img2img) {
    const body = {
        model: built.model,
        positivePrompt: built.finalPrompt,
        negativePrompt: params.negative,
        width: params.width,
        height: params.height,
        steps: params.steps,
        scale: params.scale,
        sampler: params.sampler,
        seed: built.seed,
        noise_schedule: params.noiseSchedule,
        promptGuidanceRescale: params.cfgRescale,
        sm: false,
        sm_dyn: false,
        autoSmea: false,
        decrisp: !!params.decrisper,
        variety: !!params.varietyPlus,
        prefer_brownian: params.sampler.includes('ancestral') || params.sampler.includes('sde'),
        deliberate_euler_ancestral_bug: false,
        legacy: false,
        legacy_uc: false,
        legacy_v3_extend: false,
        use_coords: !!params.useCoords,
        use_upscale_credits: false,
    };
    if (built.insert && built.characterPrompts.length) {
        body.characterPrompts = built.characterPrompts;
        body.v4_prompt_char_captions = built.characterPrompts.map((c) => ({
            char_caption: c.prompt,
            centers: [{ x: c.center.x, y: c.center.y }],
        }));
        body.v4_negative_prompt_char_captions = built.characterPrompts.map((c) => ({
            char_caption: c.uc,
            centers: [{ x: c.center.x, y: c.center.y }],
        }));
    }
    if (img2img) {
        body.action = true;
        body.image = img2img.image;
        body.strength = img2img.strength;
        body.noise = img2img.noise;
    }
    return body;
}

function normalizeBase(url) {
    return (url || DEFAULT_BASE).trim().replace(/\/+$/, '');
}

function looksHtml(text) {
    const t = text.trimStart().slice(0, 80).toLowerCase();
    return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<?xml') || t.includes('<title>internal server error');
}

export function mapIdlecloudError(status, body) {
    if (looksHtml(body)) return '中转站返回了异常页面';
    let code = '';
    let msg = '';
    try {
        const j = JSON.parse(body);
        code = String(j.error || '');
        msg = String(j.message || j.detail || '');
    } catch {
        if (body) msg = body.slice(0, 180);
    }
    if (code === 'NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED') return 'NovelAI V5 本周额度已用完，请改用 V4.5 或等重置';
    if (code === 'NOVELAI_V5_BACKEND_QUOTA_EXHAUSTED') return 'V5 后端额度暂时耗尽，请稍后或改用 V4.5';
    if (status === 401 || status === 403) return 'API Key 无效或档位不够，请重新填写';
    if (status === 402) return '中转站积分不足';
    if (status === 409) return '已有一张图正在生成，请等它完成后再试';
    if (status === 429 || code === 'RATE_LIMITED') {
        return msg || '中转站限制 20 秒内只能提交一次生图，请稍后再试';
    }
    if (status === 504) return '中转站超时，请稍后重试';
    return msg || code || `中转站 ${status}`;
}

function authHeaders(key) {
    return {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json, application/zip, image/png, */*',
    };
}

function parseJob(text) {
    if (!text || looksHtml(text)) return null;
    try {
        const j = JSON.parse(text);
        if (j?.data && typeof j.data === 'object' && !j.job_id && !j.image && !j.image_url) return { ...j, ...j.data };
        return j;
    } catch {
        return null;
    }
}

function imageField(image) {
    if (!image || image.length < 80) return '';
    return image.includes('base64,') ? image.split('base64,').pop() || '' : image;
}

function b64FromBytes(u8) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) binary += String.fromCharCode(...u8.subarray(i, i + chunk));
    return btoa(binary);
}

async function inflateRaw(comp) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不能解压中转站的 zip');
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractPngBytes(u8) {
    if (u8[0] === 0x89 && u8[1] === 0x50) return u8;
    if (!(u8[0] === 0x50 && u8[1] === 0x4b)) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    const start = Math.max(0, u8.length - 22 - 65536);
    for (let i = u8.length - 22; i >= start; i--) {
        if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    let cd = dv.getUint32(eocd + 16, true);
    let png = null;
    for (let n = 0; n < count; n++) {
        if (cd + 46 > u8.length || dv.getUint32(cd, true) !== 0x02014b50) break;
        const method = dv.getUint16(cd + 10, true);
        const compSize = dv.getUint32(cd + 20, true);
        const nameLen = dv.getUint16(cd + 28, true);
        const extraLen = dv.getUint16(cd + 30, true);
        const commentLen = dv.getUint16(cd + 32, true);
        const localOff = dv.getUint32(cd + 42, true);
        const name = new TextDecoder().decode(u8.subarray(cd + 46, cd + 46 + nameLen));
        const localNameLen = dv.getUint16(localOff + 26, true);
        const localExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + localNameLen + localExtraLen;
        const comp = u8.subarray(dataStart, dataStart + compSize);
        let raw = null;
        if (method === 0) raw = comp;
        else if (method === 8) raw = await inflateRaw(comp);
        if (raw && (name.toLowerCase().endsWith('.png') || (raw[0] === 0x89 && raw[1] === 0x50))) {
            png = raw;
            if (name.toLowerCase().endsWith('.png')) return png;
        }
        cd += 46 + nameLen + extraLen + commentLen;
    }
    return png;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function combineSignals(signal, ms) {
    const hop = AbortSignal.timeout(ms);
    if (!signal) return hop;
    return AbortSignal.any([signal, hop]);
}

async function readBody(res) {
    const u8 = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(u8);
    return { u8, text };
}

export async function testConnection(baseUrl, apiKey) {
    const base = normalizeBase(baseUrl);
    const key = (apiKey || '').trim();
    if (!key) return { ok: false, error: '请填写 NAI API Key' };
    try {
        const r = await fetch(`${base}/api/user`, { headers: { Authorization: `Bearer ${key}` } });
        const text = await r.text();
        if (r.status === 401 || r.status === 403) return { ok: false, error: mapIdlecloudError(r.status, text) };
        if (r.ok || r.status === 404) return { ok: true };
        return { ok: r.status < 500, error: mapIdlecloudError(r.status, text) };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '无法连接中转站' };
    }
}

async function hop(url, options, signal) {
    let res;
    try {
        res = await fetch(url, { ...options, signal: combineSignals(signal, HOP_TIMEOUT_MS) });
    } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const name = e?.name || '';
        if (name === 'TimeoutError' || name === 'AbortError') {
            const err = new Error('中转站超时，请稍后重试');
            err.name = 'HopTimeout';
            throw err;
        }
        throw new Error(e instanceof Error ? e.message : '生图请求失败');
    }
    const { u8, text } = await readBody(res);
    return { res, u8, text };
}

function absUrl(base, url) {
    if (/^https?:\/\//i.test(url)) return url;
    return base + (url.startsWith('/') ? url : `/${url}`);
}

export async function drawImage({ baseUrl, apiKey, params, grokTail, charTails, seed, ref, signal, onPhase }) {
    const base = normalizeBase(baseUrl);
    const key = (apiKey || '').trim();
    if (!key) throw new Error('还没连接 NAI 中转站');
    const built = buildPayload(params, sanitizeNaiTags(grokTail, { stripForbidden: false }), charTails || {}, seed);
    const payload = buildIdlecloudBody(built, params, ref);
    onPhase?.('generating');
    const started = Date.now();
    const timedOut = () => Date.now() - started >= DRAW_TIMEOUT_MS;
    const headers = { ...authHeaders(key), 'Content-Type': 'application/json' };

    let submit;
    while (!submit) {
        if (timedOut()) throw new Error('生图超时');
        try {
            const hopRes = await hop(`${base}/api/generate_image`, { method: 'POST', headers, body: JSON.stringify(payload) }, signal);
            if (!hopRes.res.ok) throw new Error(mapIdlecloudError(hopRes.res.status, hopRes.text));
            const png = await extractPngBytes(hopRes.u8);
            if (png && (hopRes.u8[0] === 0x89 || hopRes.u8[0] === 0x50)) {
                onPhase?.('receiving');
                return { b64: b64FromBytes(png), seed: built.seed, finalPrompt: built.finalPrompt };
            }
            if (looksHtml(hopRes.text)) throw new Error('中转站返回了异常页面');
            const j = parseJob(hopRes.text);
            if (!j) throw new Error('中转站返回无法解析');
            const inline = imageField(j.image);
            if (inline) {
                onPhase?.('receiving');
                return { b64: inline, seed: built.seed, finalPrompt: built.finalPrompt };
            }
            if (j.error && !j.job_id && !j.id) throw new Error(j.error);
            submit = j;
        } catch (e) {
            if (e?.name === 'HopTimeout') continue;
            throw e;
        }
    }

    let statusUrl = submit.v5_delivery?.status_url;
    let fileUrl = submit.v5_delivery?.file_url || submit.image_url;
    let v5 = submit.v5_delivery;
    const jobId = submit.job_id || submit.id;
    if (!jobId && !statusUrl && !fileUrl) throw new Error('中转站没有返回任务');

    while (!timedOut()) {
        if (fileUrl) {
            try {
                const fetched = await hop(absUrl(base, fileUrl), { headers: authHeaders(key) }, signal);
                if (!fetched.res.ok) throw new Error(mapIdlecloudError(fetched.res.status, fetched.text));
                const png = await extractPngBytes(fetched.u8);
                if (!png) throw new Error('中转站没有返回图片');
                if (v5?.confirmation_required && v5.confirm_url) {
                    try {
                        await fetch(absUrl(base, v5.confirm_url), {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ sha256: v5.sha256, size_bytes: v5.size_bytes }),
                        });
                    } catch {
                        /* confirm is optional */
                    }
                }
                onPhase?.('receiving');
                return { b64: b64FromBytes(png), seed: built.seed, finalPrompt: built.finalPrompt };
            } catch (e) {
                if (e?.name !== 'HopTimeout') throw e;
            }
            fileUrl = undefined;
        }
        let poll;
        try {
            const url = statusUrl ? absUrl(base, statusUrl) : `${base}/api/get_result/${jobId}`;
            const hopRes = await hop(url, { headers: authHeaders(key) }, signal);
            if (!hopRes.res.ok) throw new Error(mapIdlecloudError(hopRes.res.status, hopRes.text));
            if (looksHtml(hopRes.text)) throw new Error('中转站返回了异常页面');
            poll = parseJob(hopRes.text);
        } catch (e) {
            if (e?.name === 'HopTimeout') continue;
            throw e;
        }
        if (!poll) {
            await sleep(Math.min(POLL_MS, DRAW_TIMEOUT_MS - (Date.now() - started)), signal);
            continue;
        }
        if (poll.status === 'failed' || (poll.error && poll.status !== 'completed' && !poll.image_url && !poll.image && !poll.v5_delivery?.file_url)) {
            throw new Error(poll.error || poll.message || '生成失败');
        }
        if (poll.v5_delivery?.status_url) statusUrl = poll.v5_delivery.status_url;
        const inline = imageField(poll.image);
        if (inline) {
            onPhase?.('receiving');
            return { b64: inline, seed: built.seed, finalPrompt: built.finalPrompt };
        }
        const nextFile = poll.v5_delivery?.file_url || poll.image_url;
        if (nextFile) {
            fileUrl = nextFile;
            v5 = poll.v5_delivery || v5;
            continue;
        }
        const left = DRAW_TIMEOUT_MS - (Date.now() - started);
        if (left <= 0) break;
        await sleep(Math.min(POLL_MS, left), signal);
    }
    throw new Error('生图超时');
}
