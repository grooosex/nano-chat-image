import { drawImage, modelLabel, MODELS, NOISE, randomSeed, RESOLUTIONS, SAMPLERS, samplerShort, testConnection, UC, COOLDOWN_MS, FULLBODY_TAG, SENSITIVE_PREFIX, UNCENSORED_TAG } from './lib/nai.js';
import { imageWriteMaxTokens, parseTagOutput, writerSystem, writerUser } from './lib/prompt.js';
import { hasOwn, paramsFor, readSettings, uid } from './lib/settings.js';
import { extractGrokTail, keepPresentTails, sanitizeNaiTags } from './lib/tags.js';

const SLOT = 'nano-nai-slot';
let booted = false;
let arm = null;
let cooldownUntil = 0;
let saveTimer = 0;
const aborts = new Map();

function ctx() {
    if (!globalThis.SillyTavern?.getContext) throw new Error('酒馆还没准备好');
    return SillyTavern.getContext();
}

function settings() {
    return readSettings(ctx().extensionSettings);
}

function toast(msg, kind = 'error') {
    const fn = globalThis.toastr?.[kind] || globalThis.toastr?.info;
    if (fn) fn(msg, '聊天生图');
    else console.warn('[聊天生图]', msg);
}

function storyText(raw) {
    return String(raw || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\n*状态栏:[\s\S]*$/, '')
        .trim();
}

function formatLine(m) {
    const text = storyText(m?.mes);
    if (!text || m?.extra?.isSmallSys) return '';
    if (m.is_user) return `用户：${text}`;
    if (m.is_system) return text ? `旁白：${text}` : '';
    return `${m.name || '角色'}：${text}`;
}

function memoryText() {
    try {
        const c = ctx();
        const meta = c.chatMetadata || {};
        if (typeof meta.memory === 'string' && meta.memory.trim()) return meta.memory.trim().slice(0, 1800);
        const ext = c.extensionSettings?.memory;
        if (typeof ext === 'string') return ext.trim().slice(0, 1800);
        if (typeof ext?.prompt === 'string') return ext.prompt.trim().slice(0, 1800);
    } catch {
        /* ignore */
    }
    return '';
}

function briefFor(chat, mesId) {
    const shot = storyText(chat[mesId]?.mes);
    const residual = chat.slice(Math.max(0, mesId - 4), mesId).map(formatLine).filter(Boolean).join('\n');
    let turnUser = '';
    for (let i = mesId - 1; i >= 0; i--) {
        if (chat[i]?.is_user) {
            turnUser = storyText(chat[i].mes);
            break;
        }
    }
    let prevScene = '';
    for (let i = mesId - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const imgs = m.extra?.nano_nai?.images || [];
        const hit = [...imgs].reverse().find((g) => g.status === 'done' && g.prompt);
        prevScene = (hit?.prompt || '').trim();
        break;
    }
    return { shot, residual, turnUser, prevScene, memory: memoryText() };
}

function profileKeyFromMessage(message) {
    if (message?.original_avatar) return message.original_avatar;
    const c = ctx();
    if (c.groupId) return '';
    const ch = c.characterId != null ? c.characters?.[c.characterId] : null;
    return ch?.avatar || '';
}

function editKey() {
    const value = document.getElementById('nano-nai-who')?.value || '__default__';
    return value === '__default__' ? '' : value;
}

function liveParams(message) {
    const key = profileKeyFromMessage(message);
    return structuredClone(paramsFor(settings(), key));
}

function mutateEdit(fn) {
    const s = settings();
    const key = editKey();
    const target = key ? (s.byChar[key] ||= structuredClone(s.defaults)) : s.defaults;
    fn(target);
    ctx().saveSettingsDebounced();
    paintOwnBadge();
}

function ensurePack(msg) {
    msg.extra = msg.extra && typeof msg.extra === 'object' ? msg.extra : {};
    if (!msg.extra.nano_nai || !Array.isArray(msg.extra.nano_nai.images)) {
        msg.extra.nano_nai = { images: [], active: 0, forGen: '' };
    }
    return msg.extra.nano_nai;
}

function commit(mesId) {
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg) return;
    const swipe = msg.swipe_info?.[msg.swipe_id];
    if (swipe && msg.extra) swipe.extra = structuredClone(msg.extra);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { ctx().saveChat(); } catch (e) { console.warn(e); }
    }, 400);
}

function jobKey(mesId, msg) {
    return `${ctx().chatId || 'chat'}:${mesId}:${msg?.swipe_id ?? 0}`;
}

function phaseText(img) {
    if (!img) return '';
    if (img.status === 'writing') return '写提示词中';
    if (img.status === 'uploading') return '上传中';
    if (img.status === 'generating') return '生图中';
    if (img.status === 'receiving') return '回传中';
    if (img.status === 'cooldown') return img.error || '冷却中';
    if (img.status === 'error') return prettyError(img.error);
    return '';
}

function prettyError(error) {
    const raw = String(error || '').trim();
    if (!raw) return '生图失败';
    if (/too many concurrent|rate limit|429/i.test(raw)) return '请求太频繁';
    if (/<!doctype|<html|internal server error/i.test(raw)) return '中转站返回了异常页面';
    return raw;
}

function imgUrl(path) {
    if (!path) return '';
    if (/^(https?:|data:|\/)/.test(path)) return path;
    return `/${path}`;
}

function svg(path) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

const ICONS = {
    refresh: svg('M21 12a9 9 0 1 1-2.2-5.8M21 3v6h-6'),
    spark: svg('M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z'),
    down: svg('M12 4v12m0 0l-5-5m5 5l5-5M5 20h14'),
    wand: svg('M4 20l8-8M14 6l4-2 2 4-2 4-4 2-4-2 4-6z'),
};

function mountAll() {
    document.querySelectorAll('#chat .mes').forEach((node) => {
        const id = Number(node.getAttribute('mesid'));
        if (!Number.isNaN(id)) paintCard(id, node);
    });
}

function mountOne(id) {
    const node = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (node) paintCard(Number(id), node);
}

function paintCard(mesId, node) {
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!node || !msg || msg.is_user || msg.is_system) return;
    const pack = msg.extra?.nano_nai;
    const enabled = settings().enabled;
    const block = node.querySelector('.mes_block') || node;
    let slot = block.querySelector(`.${SLOT}`);
    if (!enabled && !(pack?.images?.length)) {
        slot?.remove();
        return;
    }
    if (!slot) {
        slot = document.createElement('div');
        slot.className = SLOT;
        const text = block.querySelector('.mes_text');
        if (text) text.insertAdjacentElement('afterend', slot);
        else block.appendChild(slot);
    }
    slot.replaceChildren(renderCard(mesId, msg));
}

function visibleImage(pack) {
    const images = pack?.images || [];
    const running = images.find((g) => g.status !== 'done' && g.status !== 'error');
    if (running) return running;
    if (!images.length) return null;
    const idx = Math.max(0, Math.min(pack.active || 0, images.length - 1));
    return images[idx];
}

function renderCard(mesId, msg) {
    const pack = msg.extra?.nano_nai || { images: [], active: 0 };
    const img = visibleImage(pack);
    const card = el('div', 'nano-nai-card');
    const done = (pack.images || []).filter((g) => g.status === 'done');
    if (img?.status === 'done') {
        const meta = el('div', 'nano-nai-meta', `${modelLabel(img.model)}  ${img.width}×${img.height}  ${img.steps}步  ${samplerShort(img.sampler)}  ${img.seed}`);
        card.append(meta);
    }
    const frame = el('div', 'nano-nai-frame');
    if (img?.status === 'done' && img.path) {
        const pic = document.createElement('img');
        pic.alt = '';
        pic.referrerPolicy = 'no-referrer';
        pic.src = imgUrl(img.path);
        frame.append(pic);
        if (done.length > 1) {
            const left = el('button', 'nano-nai-hit left');
            left.type = 'button';
            left.setAttribute('aria-label', '上一张');
            left.addEventListener('click', () => stepImage(mesId, -1));
            const right = el('button', 'nano-nai-hit right');
            right.type = 'button';
            right.setAttribute('aria-label', '下一张');
            right.addEventListener('click', () => stepImage(mesId, 1));
            frame.append(left, right);
        }
    } else {
        const ph = el('div', 'nano-nai-ph');
        const label = el('span', '', phaseText(img) || (settings().enabled ? '这一楼还没有配图' : '生图已关'));
        ph.append(label);
        if (img && img.status !== 'done' && img.status !== 'error') {
            const cancel = el('button', 'nano-nai-chip', '取消');
            cancel.type = 'button';
            cancel.addEventListener('click', () => cancelJob(mesId));
            ph.append(cancel);
        }
        frame.append(ph);
        if (img?.aspect) frame.style.aspectRatio = img.aspect;
    }
    card.append(frame);
    if (img?.status === 'error') card.append(el('div', 'nano-nai-err', phaseText(img)));

    const actions = el('div', 'nano-nai-actions');
    const busy = img && img.status !== 'done' && img.status !== 'error' ? img.source : '';
    actions.append(
        actionButton('重新生成', ICONS.refresh, busy === 'same', !done.length, () => {
            if (busy === 'same') return cancelJob(mesId);
            void run(mesId, 'same');
        }),
        actionButton(busy === 'rewrite' || busy === 'auto' ? phaseText(img) : '换提示词生成', ICONS.spark, busy === 'rewrite' || busy === 'auto', false, () => {
            if (busy === 'rewrite' || busy === 'auto') return cancelJob(mesId);
            void run(mesId, 'rewrite');
        }),
        actionButton('下载', ICONS.down, false, img?.status !== 'done', () => { if (img?.path) void downloadImage(img); }),
        actionButton(busy === 'custom' ? phaseText(img) : '自定义修改', ICONS.wand, busy === 'custom', !settings().enabled, () => openCustom(mesId)),
    );
    card.append(actions);
    return card;
}

function actionButton(label, icon, busy, disabled, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = busy ? 'busy' : '';
    btn.disabled = busy ? false : disabled;
    btn.innerHTML = icon;
    btn.append(el('span', '', busy && label ? label : label));
    btn.addEventListener('click', onClick);
    return btn;
}

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function stepImage(mesId, dir) {
    const msg = ctx().chat?.[mesId];
    const pack = msg?.extra?.nano_nai;
    if (!pack?.images?.length) return;
    const doneIdx = pack.images.map((g, i) => (g.status === 'done' ? i : -1)).filter((i) => i >= 0);
    if (doneIdx.length < 2) return;
    const cur = doneIdx.indexOf(pack.active);
    const next = doneIdx[(cur + dir + doneIdx.length) % doneIdx.length];
    pack.active = next;
    commit(mesId);
    mountOne(mesId);
}

function cancelJob(mesId) {
    const msg = ctx().chat?.[mesId];
    aborts.get(jobKey(mesId, msg))?.abort();
}

async function downloadImage(img) {
    const url = imgUrl(img.path);
    if (/^https?:/i.test(url)) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.click();
        return;
    }
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${img.seed || 'nai'}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function openCustom(mesId) {
    if (!settings().enabled) {
        toast('生图已关');
        return;
    }
    const msg = ctx().chat?.[mesId];
    if (!msg) return;
    const params = liveParams(msg);
    const pack = msg.extra?.nano_nai;
    const img = visibleImage(pack) || pack?.images?.at(-1);
    const insert = (params.characters || []).some((c) => c.enabled);
    const box = document.createElement('div');
    box.className = 'nano-nai-modal';
    const dialog = el('div', 'nano-nai-dialog');
    dialog.append(el('h3', '', '自定义修改提示词'));
    dialog.append(el('p', 'nano-nai-note', insert
        ? '总提示追加到「正面提示词.中」后面，各角色追加到对应角色正面提示词后面。'
        : '这段会追加到「正面提示词.中」后面。'));
    const base = el('textarea');
    base.value = img ? (extractGrokTail(img.prompt || '', params) || img.prompt || '') : '';
    dialog.append(el('div', '', '总提示（正面提示词.中）'));
    dialog.append(base);
    const charBoxes = [];
    if (insert) {
        for (const ch of params.characters.filter((c) => c.enabled)) {
            dialog.append(el('div', '', `${ch.name || '角色'} 正面提示词`));
            const area = el('textarea');
            area.value = img?.charTails?.[ch.id] || '';
            dialog.append(area);
            charBoxes.push([ch.id, area]);
        }
    }
    const row = el('div', 'nano-nai-row');
    const cancel = el('button', '', '取消');
    cancel.type = 'button';
    const ok = el('button', 'primary', '按这个生成');
    ok.type = 'button';
    cancel.addEventListener('click', () => box.remove());
    ok.addEventListener('click', () => {
        const tails = {};
        for (const [id, area] of charBoxes) tails[id] = area.value;
        box.remove();
        void run(mesId, 'custom', { text: base.value, charTails: tails });
    });
    row.append(cancel, ok);
    dialog.append(row);
    box.append(dialog);
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
    document.body.append(box);
}

async function run(mesId, mode, custom) {
    const s = settings();
    if (!s.enabled) {
        toast('生图已关');
        return;
    }
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg || msg.is_user) return;
    const key = jobKey(mesId, msg);
    if ([...aborts.keys()].some((k) => k.startsWith(key) && aborts.get(k) && !aborts.get(k).signal.aborted)) {
        const pack = msg.extra?.nano_nai;
        if (pack?.images?.some((g) => g.status !== 'done' && g.status !== 'error')) return;
    }
    aborts.get(key)?.abort();
    const ac = new AbortController();
    aborts.set(key, ac);
    const params = liveParams(msg);
    const pack = ensurePack(msg);
    const prev = [...pack.images].reverse().find((g) => g.prompt || g.charTails);
    const img = {
        id: uid(),
        status: mode === 'custom' || (mode === 'same' && prev?.prompt) ? 'uploading' : 'writing',
        source: mode,
        prompt: '',
        charTails: {},
        model: params.model,
        width: params.width,
        height: params.height,
        steps: params.steps,
        sampler: params.sampler,
        seed: params.seedLocked && params.seed != null ? Number(params.seed) : randomSeed(),
        path: '',
        error: '',
        aspect: `${params.width} / ${params.height}`,
        createdAt: Date.now(),
    };
    pack.images.push(img);
    pack.active = pack.images.length - 1;
    const patch = (p) => {
        Object.assign(img, p);
        commit(mesId);
        mountOne(mesId);
    };
    patch({});
    try {
        if (!s.apiKey.trim()) throw new Error('还没连接 NAI 中转站');
        let grokTail = '';
        let charTails = {};
        if (mode === 'custom') {
            grokTail = sanitizeNaiTags(custom?.text || '', { stripForbidden: false });
            for (const [k, v] of Object.entries(custom?.charTails || {})) {
                const t = sanitizeNaiTags(v, { stripForbidden: false });
                if (t) charTails[k] = t;
            }
        } else if (mode === 'same' && prev?.prompt) {
            grokTail = extractGrokTail(prev.prompt, params) || prev.prompt;
            charTails = { ...(prev.charTails || {}) };
        } else {
            patch({ status: 'writing' });
            const parsed = await writeTags(params, briefFor(c.chat, mesId), ac.signal);
            grokTail = parsed.base;
            charTails = keepPresentTails(parsed.chars, parsed.presence);
        }
        if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!grokTail && !Object.keys(charTails).length) throw new Error('提示词写失败');
        patch({ status: 'uploading', prompt: grokTail, charTails });
        await waitCooldown(ac.signal, (sec) => patch({ status: 'cooldown', error: `${sec}s` }));
        const ref = await loadRef(params);
        const result = await drawImage({
            baseUrl: s.apiBase,
            apiKey: s.apiKey,
            params,
            grokTail,
            charTails,
            seed: img.seed,
            ref,
            signal: ac.signal,
            onPhase: (status) => patch({ status }),
        });
        cooldownUntil = Date.now() + COOLDOWN_MS;
        paintCooldown();
        patch({ status: 'receiving' });
        const path = result.b64 ? await savePng(result.b64, result.seed) : result.remoteUrl;
        if (!path) throw new Error('中转站没有返回图片');
        patch({ status: 'done', path, seed: result.seed, prompt: grokTail, charTails, error: '' });
    } catch (e) {
        const message = ac.signal.aborted || e?.name === 'AbortError' ? '已取消' : (e instanceof Error ? e.message : '生图失败');
        if (message === '已取消' && !img.path) {
            const idx = pack.images.indexOf(img);
            if (idx >= 0) pack.images.splice(idx, 1);
            pack.active = Math.max(0, pack.images.length - 1);
            commit(mesId);
            mountOne(mesId);
        } else {
            patch({ status: 'error', error: message });
            if (message !== '已取消') toast(message);
        }
    } finally {
        if (aborts.get(key) === ac) aborts.delete(key);
        paintCooldown();
    }
}

async function writeTags(params, brief, signal) {
    const system = writerSystem(params);
    const user = writerUser(params, brief);
    const s = settings();
    let text = '';
    if (s.writerMode === 'custom') {
        text = await customComplete(s, system, user, imageWriteMaxTokens(params.model), signal);
    } else {
        const c = ctx();
        if (typeof c.generateRaw !== 'function') throw new Error('这个酒馆版本不能安静写词，请填专用写词接口');
        text = await c.generateRaw({
            systemPrompt: system,
            prompt: user,
            responseLength: imageWriteMaxTokens(params.model),
            trimNames: false,
        });
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return parseTagOutput(String(text || ''), params);
}

async function customComplete(s, system, user, maxTokens, signal) {
    const base = (s.writerBase || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('还没填专用写词接口');
    if (!s.writerModel) throw new Error('还没选写词模型，先点连接');
    const anthropic = /\/anthropic\b/i.test(base);
    let url = base.replace(/\/(chat\/completions|messages)$/i, '');
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (anthropic) {
        if (!/\/v1$/i.test(url)) url += '/v1';
        url += '/messages';
        headers['x-api-key'] = s.writerKey || '';
        headers['anthropic-version'] = '2023-06-01';
        body = {
            model: s.writerModel,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
        };
    } else {
        if (!/\/v1$/i.test(url)) url += '/v1';
        url += '/chat/completions';
        headers.Authorization = `Bearer ${s.writerKey || ''}`;
        body = {
            model: s.writerModel,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
            temperature: 0.7,
        };
    }
    const res = await fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new Error(apiErrorText(raw, res.status));
    const json = JSON.parse(raw);
    if (anthropic) {
        const blocks = Array.isArray(json.content) ? json.content : [];
        return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
    }
    return json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
}

function apiErrorText(raw, status) {
    try {
        const j = JSON.parse(raw);
        const msg = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : '');
        if (msg) return String(msg).slice(0, 180);
    } catch {
        /* keep raw */
    }
    return (raw || `写词接口 ${status}`).slice(0, 180);
}

function writerModelUrls(base) {
    let url = base.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '');
    const urls = [];
    if (/\/anthropic$/i.test(url)) {
        urls.push(`${url.slice(0, -'/anthropic'.length)}/models`);
        urls.push(`${url}/v1/models`);
    } else if (/\/v1$/i.test(url)) {
        urls.push(`${url}/models`);
    } else {
        urls.push(`${url}/v1/models`, `${url}/models`);
    }
    return [...new Set(urls)];
}

async function listWriterModels(base, key) {
    let last = '没有拿到模型列表';
    for (const url of writerModelUrls(base)) {
        let res;
        try {
            res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'x-api-key': key,
                    Accept: 'application/json',
                },
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : '';
            if (/failed to fetch|networkerror|load failed/i.test(msg)) {
                throw new Error('浏览器拦下了写词接口，换一个允许网页访问的地址');
            }
            throw e;
        }
        const raw = await res.text();
        if (!res.ok) {
            last = apiErrorText(raw, res.status);
            continue;
        }
        let json;
        try { json = JSON.parse(raw); } catch { last = '模型列表不是 JSON'; continue; }
        const data = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
        const ids = data.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
        if (ids.length) return ids;
        last = '接口连上了，但没有返回模型';
    }
    throw new Error(last);
}

function fillWriterModels(ids, selected) {
    const select = document.getElementById('nano-nai-writer-model');
    if (!select) return;
    const cur = selected || '';
    const list = [...new Set((ids || []).filter(Boolean))];
    if (cur && !list.includes(cur)) list.unshift(cur);
    select.replaceChildren();
    if (!list.length) {
        select.append(new Option('先点连接', ''));
        return;
    }
    for (const id of list) select.append(new Option(id, id));
    select.value = list.includes(cur) ? cur : list[0];
}

function waitCooldown(signal, onTick) {
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const left = cooldownUntil - Date.now();
            if (left <= 0) {
                resolve();
                return;
            }
            onTick(Math.ceil(left / 1000));
            setTimeout(tick, 250);
        };
        tick();
    });
}

async function loadRef(params) {
    if (!params.refPath) return undefined;
    const res = await fetch(imgUrl(params.refPath));
    if (!res.ok) throw new Error('参考图读不出来');
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0));
    return {
        image: btoa(binary),
        strength: clamp(params.refStrength ?? 0.7, 0.01, 0.99),
        noise: clamp(params.refNoise ?? 0, 0, 0.99),
    };
}

async function savePng(b64, seed, format = 'png') {
    const headers = ctx().getRequestHeaders();
    const h = headers instanceof Headers ? new Headers(headers) : { ...headers };
    if (h instanceof Headers) h.set('Content-Type', 'application/json');
    else h['Content-Type'] = 'application/json';
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
            image: b64,
            format,
            ch_name: 'nano-nai',
            filename: `nai_${seed}_${Date.now()}`,
        }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 160) || '图片保存失败');
    const data = await res.json();
    if (!data.path) throw new Error('图片保存失败');
    return data.path;
}

function onGenerationStarted(type, _params, dryRun) {
    if (dryRun || type === 'quiet') return;
    arm = { type: type || 'normal' };
}

async function onGenerationEnded() {
    const job = arm;
    arm = null;
    if (!job || !settings().enabled) return;
    if (job.type === 'quiet' || job.type === 'impersonate') return;
    const c = ctx();
    const mesId = c.chat.length - 1;
    const msg = c.chat[mesId];
    if (!msg || msg.is_user || msg.is_system || msg.extra?.isSmallSys) return;
    if (!storyText(msg.mes)) return;
    const stamp = String(msg.gen_finished || '');
    const pack = ensurePack(msg);
    if (job.type !== 'continue' && pack.forGen && pack.forGen !== stamp) {
        pack.images = [];
        pack.active = 0;
    }
    pack.forGen = stamp || String(Date.now());
    commit(mesId);
    await run(mesId, 'auto');
}

function characterChoices() {
    const c = ctx();
    const opts = [{ value: '__default__', label: '默认模板（没单独存过的角色用这份）' }];
    if (c.groupId) {
        const group = c.groups?.find((g) => g.id === c.groupId);
        for (const avatar of group?.members || []) {
            const ch = c.characters?.find((x) => x.avatar === avatar);
            opts.push({ value: avatar, label: ch?.name || avatar });
        }
    } else if (c.characterId != null && c.characters?.[c.characterId]) {
        const ch = c.characters[c.characterId];
        if (ch.avatar) opts.push({ value: ch.avatar, label: ch.name || '当前角色' });
    }
    return opts;
}

function paintCooldown() {
    const node = document.getElementById('nano-nai-cool');
    if (!node) return;
    const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (!settings().enabled) {
        node.textContent = '生图已关';
        node.className = 'nano-nai-note';
        return;
    }
    if (left > 0) {
        node.textContent = `${left}s`;
        node.className = 'nano-nai-status-wait';
    } else {
        node.textContent = '可生图';
        node.className = 'nano-nai-status-ok';
    }
}

function paintOwnBadge() {
    const node = document.getElementById('nano-nai-own');
    if (!node) return;
    const key = editKey();
    node.textContent = !key ? '正在改默认模板' : hasOwn(settings(), key) ? '已按这个角色保存' : '还没单独存过，改动后才会单独保存';
}

function selectedParams() {
    return paramsFor(settings(), editKey());
}

function refreshWho() {
    const select = document.getElementById('nano-nai-who');
    if (!select) return;
    const prev = select.value;
    const opts = characterChoices();
    select.replaceChildren();
    for (const o of opts) {
        const node = document.createElement('option');
        node.value = o.value;
        node.textContent = o.label;
        select.append(node);
    }
    const prefer = opts.some((o) => o.value === prev)
        ? prev
        : (opts.find((o) => o.value !== '__default__')?.value || '__default__');
    select.value = prefer;
    loadForm();
}

function loadForm() {
    const p = selectedParams();
    const set = (id, value) => {
        const node = document.getElementById(id);
        if (node && document.activeElement !== node) node.value = value ?? '';
    };
    set('nano-nai-front', p.promptFront);
    set('nano-nai-mid', p.promptMid);
    set('nano-nai-back', p.promptBack);
    set('nano-nai-negative', p.negative);
    set('nano-nai-steps', p.steps);
    set('nano-nai-scale', p.scale);
    set('nano-nai-cfg', p.cfgRescale);
    set('nano-nai-seed', p.seed ?? '');
    set('nano-nai-author', p.authorRules || '');
    set('nano-nai-ref-strength', p.refStrength ?? 0.7);
    set('nano-nai-ref-noise', p.refNoise ?? 0);
    const model = document.getElementById('nano-nai-model');
    const sampler = document.getElementById('nano-nai-sampler');
    const noise = document.getElementById('nano-nai-noise');
    const res = document.getElementById('nano-nai-res');
    if (model) model.value = p.model;
    if (sampler) sampler.value = p.sampler;
    if (noise) noise.value = p.noiseSchedule;
    if (res) {
        const hit = [...res.options].find((o) => o.value === `${p.width}x${p.height}`);
        res.value = hit ? hit.value : '';
    }
    paintChip('nano-nai-sensitive', p.sensitive);
    paintChip('nano-nai-uncensored', p.uncensored);
    paintChip('nano-nai-full', p.fullBody);
    paintChip('nano-nai-boost', p.adultBoost);
    paintChip('nano-nai-variety', p.varietyPlus);
    paintChip('nano-nai-decrisper', p.decrisper);
    paintChip('nano-nai-coords', p.useCoords);
    paintLock('steps', p.stepsLocked);
    paintLock('scale', p.scaleLocked);
    paintLock('cfg', p.cfgRescaleLocked);
    paintLock('seed', p.seedLocked);
    const refNote = document.getElementById('nano-nai-ref-note');
    if (refNote) refNote.textContent = p.refPath ? '已有参考图' : '还没有参考图';
    paintPresets(p);
    paintChars(p);
    paintOwnBadge();
    const portrait = p.height >= p.width;
    paintChip('nano-nai-portrait', portrait);
    paintChip('nano-nai-landscape', !portrait);
}

function paintChip(id, on) {
    const node = document.getElementById(id);
    if (node) node.classList.toggle('on', !!on);
}

function paintLock(name, locked) {
    const node = document.getElementById(`nano-nai-lock-${name}`);
    const input = document.getElementById(`nano-nai-${name}`);
    if (node) node.classList.toggle('on', !!locked);
    if (input && name !== 'seed') input.disabled = !!locked;
}

function paintPresets() {
    const select = document.getElementById('nano-nai-preset');
    if (!select) return;
    const cur = select.value;
    select.replaceChildren(new Option('(无)', ''));
    for (const preset of settings().presets) select.append(new Option(preset.name, preset.id));
    if ([...select.options].some((o) => o.value === cur)) select.value = cur;
}

function paintChars(p) {
    const host = document.getElementById('nano-nai-chars');
    if (!host) return;
    host.replaceChildren();
    (p.characters || []).forEach((ch, index) => {
        const box = el('div', 'nano-nai-char');
        const head = el('div', 'nano-nai-row');
        const name = document.createElement('input');
        name.type = 'text';
        name.value = ch.name;
        name.placeholder = `角色${index + 1} 名字`;
        name.addEventListener('input', () => mutateEdit((params) => { params.characters[index].name = name.value; }));
        const enabled = el('button', `nano-nai-chip${ch.enabled ? ' on' : ''}`, ch.enabled ? '参与' : '不参与');
        enabled.type = 'button';
        enabled.addEventListener('click', () => mutateEdit((params) => { params.characters[index].enabled = !params.characters[index].enabled; loadForm(); }));
        const del = el('button', 'nano-nai-chip', '删除');
        del.type = 'button';
        del.addEventListener('click', () => mutateEdit((params) => { params.characters.splice(index, 1); loadForm(); }));
        head.append(name, enabled, del);
        const prompt = document.createElement('textarea');
        prompt.value = ch.prompt;
        prompt.placeholder = '角色正面提示词';
        prompt.addEventListener('input', () => mutateEdit((params) => { params.characters[index].prompt = prompt.value; }));
        const uc = document.createElement('textarea');
        uc.value = ch.uc;
        uc.placeholder = '角色负面';
        uc.addEventListener('input', () => mutateEdit((params) => { params.characters[index].uc = uc.value; }));
        box.append(head, prompt, uc);
        if (p.useCoords) {
            const row = el('div', 'nano-nai-row');
            row.append(el('span', 'nano-nai-note', 'x'), num(ch.x, (v) => mutateEdit((params) => { params.characters[index].x = v; })), el('span', 'nano-nai-note', 'y'), num(ch.y, (v) => mutateEdit((params) => { params.characters[index].y = v; })));
            box.append(row);
        }
        host.append(box);
    });
}

function num(value, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.05';
    input.min = '0';
    input.max = '1';
    input.value = String(value ?? 0.5);
    input.style.maxWidth = '88px';
    input.addEventListener('input', () => onChange(Number(input.value)));
    return input;
}

function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEnd(s, tag) {
    const core = tag.replace(/,\s*$/, '').trim();
    const re = new RegExp(`(?:,\\s*)?${escRe(core)}\\s*,?\\s*$`, 'i');
    let cur = s.trimEnd();
    for (let i = 0; i < 4; i++) {
        const next = cur.replace(re, '').replace(/[,\s]+$/g, '').trimEnd();
        if (next === cur) break;
        cur = next;
    }
    return cur;
}

function appendTag(s, tag) {
    const t = s.trimEnd();
    if (!t) return tag;
    if (t.endsWith(',')) return `${t} ${tag}`;
    return `${t}, ${tag}`;
}

function bindField(id, apply) {
    const node = document.getElementById(id);
    node?.addEventListener('input', () => mutateEdit((p) => apply(p, node)));
    node?.addEventListener('change', () => mutateEdit((p) => apply(p, node)));
}

function buildPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('nano-nai-settings')) return;
    const root = el('div', 'nano-nai-settings');
    root.id = 'nano-nai-settings';
    root.innerHTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>聊天生图</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="nano-nai-body">
      <label class="nano-nai-switch"><span><b>总开关</b><div class="nano-nai-note">关掉之后不再写词、不再请求中转站。已经生成的图还留着。</div></span><input id="nano-nai-enabled" type="checkbox"></label>
      <div class="nano-nai-row"><span id="nano-nai-cool" class="nano-nai-note">可生图</span></div>
      <h4>中转站</h4>
      <label class="nano-nai-field">地址<input id="nano-nai-base" type="text" placeholder="https://api.idlecloud.cc"></label>
      <label class="nano-nai-field">API Key<input id="nano-nai-key" type="password" autocomplete="off"></label>
      <div class="nano-nai-row"><button type="button" class="nano-nai-btn" id="nano-nai-test">测试连接</button></div>
      <h4>写提示词</h4>
      <label class="nano-nai-field">来源
        <select id="nano-nai-writer-mode">
          <option value="st">跟酒馆当前连接（不带角色卡和预设）</option>
          <option value="custom">专用接口</option>
        </select>
      </label>
      <label class="nano-nai-field">专用接口地址<input id="nano-nai-writer-base" type="text" placeholder="https://api.deepseek.com/anthropic"></label>
      <label class="nano-nai-field">专用接口 Key<input id="nano-nai-writer-key" type="password" autocomplete="off"></label>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-btn" id="nano-nai-writer-test">连接</button>
        <span id="nano-nai-writer-status" class="nano-nai-note">还没连接</span>
      </div>
      <label class="nano-nai-field">模型<select id="nano-nai-writer-model"></select></label>
      <div class="nano-nai-note">地址里带 /anthropic 就按 Anthropic 接口写词。点连接后在这里选模型。来源会改成「专用接口」。</div>
      <h4>当前角色</h4>
      <label class="nano-nai-field">参数套<select id="nano-nai-who"></select></label>
      <div id="nano-nai-own" class="nano-nai-note"></div>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-chip" id="nano-nai-portrait">竖图</button>
        <button type="button" class="nano-nai-chip" id="nano-nai-landscape">横图</button>
        <button type="button" class="nano-nai-chip" id="nano-nai-boost">成人提示词</button>
        <button type="button" class="nano-nai-btn" id="nano-nai-clear">清除这个角色的单独参数</button>
      </div>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-chip" id="nano-nai-sensitive">成人</button>
        <button type="button" class="nano-nai-chip" id="nano-nai-uncensored">无码</button>
        <button type="button" class="nano-nai-chip" id="nano-nai-full">全身</button>
      </div>
      <div class="nano-nai-note">「成人」是敏感分级，加在后段前面。「成人提示词」只影响写词够不够具体。补全（打字联想）这版没有。</div>
      <h4>正面提示词.前</h4>
      <textarea id="nano-nai-front"></textarea>
      <h4>正面提示词.中</h4>
      <div class="nano-nai-row">
        <label class="nano-nai-field">角色选择<select id="nano-nai-preset"></select></label>
        <button type="button" class="nano-nai-btn" id="nano-nai-preset-save">保存角色</button>
      </div>
      <textarea id="nano-nai-mid"></textarea>
      <h4>正面提示词.后</h4>
      <textarea id="nano-nai-back"></textarea>
      <h4>负面提示词</h4>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-chip" data-uc="heavy">重</button>
        <button type="button" class="nano-nai-chip" data-uc="light">轻</button>
        <button type="button" class="nano-nai-chip" data-uc="human">人形</button>
      </div>
      <textarea id="nano-nai-negative"></textarea>
      <h4>模型</h4>
      <select id="nano-nai-model"></select>
      <label class="nano-nai-field">分辨率<select id="nano-nai-res"></select></label>
      <div class="nano-nai-row">
        <label class="nano-nai-field">采样器<select id="nano-nai-sampler"></select></label>
        <label class="nano-nai-field">噪声表<select id="nano-nai-noise"></select></label>
      </div>
      <label class="nano-nai-field">步数 <button type="button" class="nano-nai-chip" id="nano-nai-lock-steps">锁定</button><input id="nano-nai-steps" type="number" min="1" max="50"></label>
      <label class="nano-nai-field">提示词引导 <button type="button" class="nano-nai-chip" id="nano-nai-lock-scale">锁定</button><input id="nano-nai-scale" type="number" min="0" max="10" step="0.1"></label>
      <label class="nano-nai-field">CFG rescale <button type="button" class="nano-nai-chip" id="nano-nai-lock-cfg">锁定</button><input id="nano-nai-cfg" type="number" min="0" max="1" step="0.01"></label>
      <label class="nano-nai-field">种子 <button type="button" class="nano-nai-chip" id="nano-nai-lock-seed">锁定</button><input id="nano-nai-seed" type="number" placeholder="空着则随机"></label>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-chip" id="nano-nai-variety">Variety+</button>
        <button type="button" class="nano-nai-chip" id="nano-nai-decrisper">Decrisper</button>
      </div>
      <h4>参考图</h4>
      <div class="nano-nai-note" id="nano-nai-ref-note">还没有参考图</div>
      <input id="nano-nai-ref" type="file" accept="image/*">
      <div class="nano-nai-row">
        <label class="nano-nai-field">强度<input id="nano-nai-ref-strength" type="number" min="0.01" max="0.99" step="0.01"></label>
        <label class="nano-nai-field">噪声<input id="nano-nai-ref-noise" type="number" min="0" max="0.99" step="0.01"></label>
        <button type="button" class="nano-nai-btn" id="nano-nai-ref-clear">去掉参考图</button>
      </div>
      <h4>角色提示词（V4 / V5）</h4>
      <div class="nano-nai-note">不加角色槽时，模型写的整段接在「正面提示词.中」后面。加了槽，总提示仍接在中段后面，每个人的动作接到自己的角色栏后面。</div>
      <div class="nano-nai-row">
        <button type="button" class="nano-nai-chip" id="nano-nai-coords">自定义位置</button>
        <button type="button" class="nano-nai-btn" id="nano-nai-add-char">添加角色</button>
      </div>
      <div id="nano-nai-chars"></div>
      <h4>写词额外规则</h4>
      <textarea id="nano-nai-author" placeholder="只约束怎么写 tag，不会被抄进提示词"></textarea>
    </div>
  </div>
</div>`;
    host.append(root);
    fillSelect('nano-nai-model', MODELS.map((m) => [m.id, m.label]));
    fillSelect('nano-nai-sampler', SAMPLERS.map((m) => [m.id, m.label]));
    fillSelect('nano-nai-noise', NOISE.map((m) => [m.id, m.label]));
    const res = document.getElementById('nano-nai-res');
    res.append(new Option('当前尺寸', ''));
    for (const r of RESOLUTIONS) res.append(new Option(r.label, `${r.w}x${r.h}`));

    const s = settings();
    document.getElementById('nano-nai-enabled').checked = !!s.enabled;
    document.getElementById('nano-nai-base').value = s.apiBase;
    document.getElementById('nano-nai-key').value = s.apiKey;
    document.getElementById('nano-nai-writer-mode').value = s.writerMode;
    document.getElementById('nano-nai-writer-base').value = s.writerBase;
    document.getElementById('nano-nai-writer-key').value = s.writerKey;
    fillWriterModels(s.writerModels || [], s.writerModel);

    document.getElementById('nano-nai-enabled').addEventListener('change', (e) => {
        settings().enabled = e.target.checked;
        ctx().saveSettingsDebounced();
        paintCooldown();
        mountAll();
    });
    for (const [id, key] of [['nano-nai-base', 'apiBase'], ['nano-nai-key', 'apiKey'], ['nano-nai-writer-base', 'writerBase'], ['nano-nai-writer-key', 'writerKey']]) {
        document.getElementById(id).addEventListener('input', (e) => {
            settings()[key] = e.target.value;
            ctx().saveSettingsDebounced();
        });
    }
    document.getElementById('nano-nai-writer-model').addEventListener('change', (e) => {
        settings().writerModel = e.target.value;
        ctx().saveSettingsDebounced();
    });
    document.getElementById('nano-nai-writer-test').addEventListener('click', async () => {
        const cur = settings();
        const status = document.getElementById('nano-nai-writer-status');
        status.textContent = '连接中';
        status.className = 'nano-nai-note';
        try {
            if (!cur.writerBase.trim()) throw new Error('还没填专用接口地址');
            if (!cur.writerKey.trim()) throw new Error('还没填专用接口 Key');
            const ids = await listWriterModels(cur.writerBase, cur.writerKey);
            cur.writerModels = ids;
            if (!ids.includes(cur.writerModel)) cur.writerModel = ids[0];
            cur.writerMode = 'custom';
            document.getElementById('nano-nai-writer-mode').value = 'custom';
            fillWriterModels(ids, cur.writerModel);
            ctx().saveSettingsDebounced();
            status.textContent = `已连接，${ids.length} 个模型`;
            status.className = 'nano-nai-status-ok';
            toast('写词接口连上了', 'success');
        } catch (e) {
            status.textContent = e instanceof Error ? e.message : '连不上';
            status.className = 'nano-nai-status-wait';
            toast(status.textContent);
        }
    });
    document.getElementById('nano-nai-writer-mode').addEventListener('change', (e) => {
        settings().writerMode = e.target.value;
        ctx().saveSettingsDebounced();
    });
    document.getElementById('nano-nai-test').addEventListener('click', async () => {
        const cur = settings();
        const result = await testConnection(cur.apiBase, cur.apiKey);
        toast(result.ok ? '中转站连上了' : (result.error || '连不上'), result.ok ? 'success' : 'error');
    });
    document.getElementById('nano-nai-who').addEventListener('change', loadForm);
    document.getElementById('nano-nai-clear').addEventListener('click', () => {
        const key = editKey();
        if (!key) {
            toast('默认模板不能删，改回出厂要自己贴回去', 'info');
            return;
        }
        delete settings().byChar[key];
        ctx().saveSettingsDebounced();
        loadForm();
    });
    bindField('nano-nai-front', (p, n) => { p.promptFront = n.value; });
    bindField('nano-nai-mid', (p, n) => { p.promptMid = n.value; });
    bindField('nano-nai-back', (p, n) => { p.promptBack = n.value; });
    bindField('nano-nai-negative', (p, n) => { p.negative = n.value; p.ucPreset = 'custom'; });
    bindField('nano-nai-author', (p, n) => { p.authorRules = n.value; });
    bindField('nano-nai-steps', (p, n) => { if (!p.stepsLocked) p.steps = Number(n.value) || p.steps; });
    bindField('nano-nai-scale', (p, n) => { if (!p.scaleLocked) p.scale = Number(n.value); });
    bindField('nano-nai-cfg', (p, n) => { if (!p.cfgRescaleLocked) p.cfgRescale = Number(n.value); });
    bindField('nano-nai-seed', (p, n) => { p.seed = n.value === '' ? null : Number(n.value); });
    bindField('nano-nai-ref-strength', (p, n) => { p.refStrength = Number(n.value); });
    bindField('nano-nai-ref-noise', (p, n) => { p.refNoise = Number(n.value); });
    bindField('nano-nai-model', (p, n) => { p.model = n.value; });
    bindField('nano-nai-sampler', (p, n) => { p.sampler = n.value; });
    bindField('nano-nai-noise', (p, n) => { p.noiseSchedule = n.value; });
    document.getElementById('nano-nai-res').addEventListener('change', (e) => {
        const [w, h] = e.target.value.split('x').map(Number);
        if (!w || !h) return;
        mutateEdit((p) => { p.width = w; p.height = h; });
        loadForm();
    });
    document.getElementById('nano-nai-sensitive').addEventListener('click', () => mutateEdit((p) => {
        p.sensitive = !p.sensitive;
        const rest = p.promptBack.replace(/^\s*rating:\s*sensitive,\s*nsfw,\s*uncensored,\s*/i, '').trim();
        p.promptBack = p.sensitive ? (rest ? `${SENSITIVE_PREFIX} ${rest}` : SENSITIVE_PREFIX) : rest;
        loadForm();
    }));
    document.getElementById('nano-nai-uncensored').addEventListener('click', () => mutateEdit((p) => {
        p.uncensored = !p.uncensored;
        let front = stripEnd(stripEnd(p.promptFront, FULLBODY_TAG), UNCENSORED_TAG);
        if (p.uncensored) front = appendTag(front, UNCENSORED_TAG);
        if (p.fullBody) front = appendTag(front, FULLBODY_TAG);
        p.promptFront = front;
        loadForm();
    }));
    document.getElementById('nano-nai-full').addEventListener('click', () => mutateEdit((p) => {
        p.fullBody = !p.fullBody;
        let front = stripEnd(stripEnd(p.promptFront, FULLBODY_TAG), UNCENSORED_TAG);
        if (p.uncensored) front = appendTag(front, UNCENSORED_TAG);
        if (p.fullBody) front = appendTag(front, FULLBODY_TAG);
        p.promptFront = front;
        loadForm();
    }));
    document.getElementById('nano-nai-boost').addEventListener('click', () => mutateEdit((p) => { p.adultBoost = !p.adultBoost; loadForm(); }));
    document.getElementById('nano-nai-variety').addEventListener('click', () => mutateEdit((p) => { p.varietyPlus = !p.varietyPlus; loadForm(); }));
    document.getElementById('nano-nai-decrisper').addEventListener('click', () => mutateEdit((p) => { p.decrisper = !p.decrisper; loadForm(); }));
    document.getElementById('nano-nai-coords').addEventListener('click', () => mutateEdit((p) => { p.useCoords = !p.useCoords; loadForm(); }));
    for (const name of ['steps', 'scale', 'cfg', 'seed']) {
        document.getElementById(`nano-nai-lock-${name}`).addEventListener('click', () => mutateEdit((p) => {
            const field = name === 'cfg' ? 'cfgRescaleLocked' : `${name}Locked`;
            p[field] = !p[field];
            loadForm();
        }));
    }
    document.getElementById('nano-nai-portrait').addEventListener('click', () => mutateEdit((p) => {
        if (p.width > p.height) [p.width, p.height] = [p.height, p.width];
        loadForm();
    }));
    document.getElementById('nano-nai-landscape').addEventListener('click', () => mutateEdit((p) => {
        if (p.height > p.width) [p.width, p.height] = [p.height, p.width];
        loadForm();
    }));
    root.querySelectorAll('[data-uc]').forEach((btn) => {
        btn.addEventListener('click', () => mutateEdit((p) => {
            p.ucPreset = btn.dataset.uc;
            p.negative = UC[btn.dataset.uc];
            loadForm();
        }));
    });
    document.getElementById('nano-nai-preset').addEventListener('change', (e) => {
        const preset = settings().presets.find((x) => x.id === e.target.value);
        if (!preset) return;
        mutateEdit((p) => { p.promptMid = preset.mid; });
        loadForm();
    });
    document.getElementById('nano-nai-preset-save').addEventListener('click', () => {
        const name = prompt('角色名', '');
        if (!name) return;
        const mid = document.getElementById('nano-nai-mid').value;
        settings().presets.push({ id: uid(), name: name.trim(), mid });
        ctx().saveSettingsDebounced();
        paintPresets();
    });
    document.getElementById('nano-nai-add-char').addEventListener('click', () => mutateEdit((p) => {
        p.characters.push({ id: uid(), name: '', enabled: true, prompt: '', uc: '', x: 0.5, y: 0.5 });
        loadForm();
    }));
    document.getElementById('nano-nai-ref').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const b64 = await fileToB64(file);
        const format = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
        const path = await savePng(b64, 'ref', format);
        mutateEdit((p) => { p.refPath = path; });
        loadForm();
    });
    document.getElementById('nano-nai-ref-clear').addEventListener('click', () => mutateEdit((p) => { p.refPath = ''; loadForm(); }));
    refreshWho();
}

function fillSelect(id, pairs) {
    const node = document.getElementById(id);
    for (const [value, label] of pairs) node.append(new Option(label, value));
}

function fileToB64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split('base64,').pop() || '');
        reader.onerror = () => reject(new Error('读图失败'));
        reader.readAsDataURL(file);
    });
}

function boot() {
    if (booted) return;
    let c;
    try { c = ctx(); } catch { return; }
    const types = c?.eventTypes || c?.event_types;
    if (!c?.eventSource || !c?.extensionSettings || !types?.GENERATION_ENDED) return;
    booted = true;
    readSettings(c.extensionSettings);
    buildPanel();
    c.eventSource.on(types.GENERATION_STARTED, onGenerationStarted);
    c.eventSource.on(types.GENERATION_ENDED, () => { void onGenerationEnded().catch((e) => console.warn(e)); });
    c.eventSource.on(types.GENERATION_STOPPED, () => { arm = null; });
    c.eventSource.on(types.CHAT_CHANGED, () => { refreshWho(); mountAll(); });
    c.eventSource.on(types.CHARACTER_MESSAGE_RENDERED, (id) => mountOne(id));
    if (types.MESSAGE_UPDATED) c.eventSource.on(types.MESSAGE_UPDATED, (id) => mountOne(id));
    c.eventSource.on(types.MESSAGE_SWIPED, (id) => mountOne(id));
    c.eventSource.on(types.MESSAGE_DELETED, () => mountAll());
    mountAll();
    setInterval(paintCooldown, 500);
}

boot();
setTimeout(boot, 1000);
if (globalThis.SillyTavern?.getContext) {
    try {
        const types = ctx().eventTypes || ctx().event_types;
        ctx().eventSource?.on(types.APP_READY, boot);
    } catch {
        /* boot retry handles this */
    }
}
