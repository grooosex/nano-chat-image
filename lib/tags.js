/** NovelAI tag cleanup. Ported from nanochat src/lib/nai-tags.ts. */

const FACE_KEEP = /[\^:;><]_[^,\s]|_[wWmMoO]_|\\m\/|\^_\^|:_\^|;_;/;

const FORBIDDEN_EXACT = new Set([
    'masterpiece',
    'best quality',
    'amazing quality',
    'absurdres',
    'very aesthetic',
    'highres',
    'newest',
    '4k',
    '8k',
    '8k wallpaper',
    'extremely detailed',
    'ultra-detailed',
    'cinematic',
    'no text',
    'worst quality',
    'low quality',
    'artist collaboration',
    'loli',
    'shota',
    'child',
    'teen',
    'underage',
    'toddler',
    'kid',
    'children',
]);

const AUTO_TAGS = new Set(['uncensored', 'full body', 'rating:sensitive', 'rating: sensitive', 'fur dataset']);

function isForbidden(tag) {
    const t = tag.trim().toLowerCase();
    if (!t) return true;
    if (FORBIDDEN_EXACT.has(t)) return true;
    if (/\bartist\s*:/.test(t)) return true;
    if (/^year 202\d$/.test(t)) return true;
    if (/^year_202\d$/.test(t)) return true;
    return false;
}

function unSnake(tag) {
    const t = tag.trim();
    if (t.length < 10 && FACE_KEEP.test(t)) return t;
    return t.replace(/_/g, ' ');
}

export function splitNaiTags(raw) {
    const out = [];
    let buf = '';
    let inWeight = false;
    const s = raw || '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === ':' && s[i + 1] === ':') {
            inWeight = !inWeight;
            buf += '::';
            i++;
            continue;
        }
        if (c === ',' && !inWeight) {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
}

function normKey(tag) {
    return unSnake(tag).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extractJsonObject(raw) {
    let s = (raw || '').trim();
    s = s.replace(/^```(?:json|text|tags)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const json = JSON.parse(s.slice(start, end + 1));
        if (json && typeof json === 'object' && !Array.isArray(json)) return json;
    } catch {
        /* ignore */
    }
    return null;
}

function asTagStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(asTagStr).filter(Boolean).join(', ');
    if (typeof v === 'object') return Object.values(v).map(asTagStr).filter(Boolean).join(', ');
    return String(v);
}

export function flattenMaybeJson(raw) {
    const json = extractJsonObject(raw);
    if (!json || (!('base' in json) && !('chars' in json))) return raw;
    const parts = [asTagStr(json.base)];
    const chars = json.chars;
    if (chars && typeof chars === 'object') {
        for (const v of Object.values(chars)) parts.push(asTagStr(v));
    }
    return parts.filter(Boolean).join(', ');
}

export function sanitizeNaiTags(raw, opts) {
    let s = (raw || '').trim();
    if (!s) return '';
    s = s.replace(/^```(?:json|text|tags)?\s*/i, '').replace(/\s*```$/i, '').trim();
    s = s.replace(/^(?:here are (?:the )?tags:?|tags:?|prompt:?)\s*/i, '');
    s = s.replace(/^["']|["']$/g, '').trim();
    if (s.includes('{') && /"base"\s*:|"chars"\s*:/.test(s)) s = flattenMaybeJson(s);

    const strip = opts?.stripForbidden !== false;
    const seen = new Set();
    const out = [];
    for (let part of splitNaiTags(s)) {
        part = unSnake(part).replace(/\s+/g, ' ').trim();
        if (!part) continue;
        if (
            !/^[-0-9.]+::/.test(part) &&
            !part.startsWith('Text:') &&
            !part.startsWith('source#') &&
            !part.startsWith('target#') &&
            !part.startsWith('mutual#')
        ) {
            part = part.toLowerCase();
        }
        if (strip && isForbidden(part)) continue;
        const key = part.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(part);
    }
    return out.join(', ');
}

export function extractGrokTail(stored, params) {
    const cleaned = sanitizeNaiTags(flattenMaybeJson(stored));
    if (!cleaned) return '';
    const drop = new Set();
    for (const src of [params.promptFront, params.promptMid, params.promptBack]) {
        for (const t of splitNaiTags(src || '')) {
            const k = normKey(t);
            if (k) drop.add(k);
        }
    }
    for (const t of AUTO_TAGS) drop.add(t);
    const kept = splitNaiTags(cleaned).filter((t) => !drop.has(normKey(t)) && !isForbidden(t));
    return kept.join(', ');
}

export function assignCharTags(rawChars, characters) {
    const mapped = {};
    const used = new Set();
    const unmatched = [];

    const resolve = (key) => {
        const k = key.trim().toLowerCase();
        if (!k) return undefined;
        const byName = characters.find((c) => !used.has(c.id) && c.name && c.name.toLowerCase() === k);
        if (byName) return byName.id;
        const byId = characters.find((c) => !used.has(c.id) && c.id.toLowerCase() === k);
        if (byId) return byId.id;
        const m = k.match(/^(?:char|character|角色)\s*[_#.\-]?\s*(\d+)$/i);
        if (m) {
            const c = characters[Number(m[1]) - 1];
            if (c && !used.has(c.id)) return c.id;
        }
        return undefined;
    };

    for (const [key, val] of Object.entries(rawChars || {})) {
        const tags = sanitizeNaiTags(val);
        if (!tags) continue;
        const id = resolve(key);
        if (id) {
            mapped[id] = tags;
            used.add(id);
        } else unmatched.push(tags);
    }
    return { mapped, leftover: unmatched.join(', ') };
}

export function resolveAbsentIds(absent, characters) {
    const names = Array.isArray(absent) ? absent.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const ids = [];
    for (const n of names) {
        const k = n.toLowerCase();
        const hit =
            characters.find((c) => c.name && c.name.toLowerCase() === k) ||
            characters.find((c) => c.id.toLowerCase() === k) ||
            (() => {
                const m = k.match(/^(?:char|character|角色)\s*[_#.\-]?\s*(\d+)$/i);
                return m ? characters[Number(m[1]) - 1] : undefined;
            })();
        if (hit && !ids.includes(hit.id)) ids.push(hit.id);
    }
    return ids;
}

export function presenceFromTags(mappedIds, absentIds) {
    if (mappedIds.length) {
        const absent = new Set(absentIds);
        return { mode: 'exact', ids: mappedIds.filter((id) => !absent.has(id)) };
    }
    if (absentIds.length) return { mode: 'off', ids: absentIds };
    return undefined;
}

export function keepPresentTails(charTails, presence) {
    if (!presence) return charTails || {};
    if (presence.mode === 'exact') {
        const on = new Set(presence.ids);
        const next = {};
        for (const [k, v] of Object.entries(charTails || {})) if (on.has(k)) next[k] = v;
        return next;
    }
    const off = new Set(presence.ids);
    const next = { ...(charTails || {}) };
    for (const id of off) delete next[id];
    return next;
}
