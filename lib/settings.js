import { UC } from './nai.js';

export const EXT_KEY = 'nano_nai';

export function defaultParams() {
    return {
        promptFront:
            '1.7::artist:mamezou::, 0.5::kawakami_rokkaku::, 0.8::artist:kojima_saya::, year 2024, year 2025, 0.5::satou kibi::, 0.3::quasarcake::',
        promptMid: '',
        promptBack:
            'rating:sensitive, nsfw, uncensored, masterpiece, highres, absurdres, newest, 4k, extremely detailed, 8k wallpaper, ultra-detailed, cinematic, anime',
        sensitive: false,
        uncensored: false,
        fullBody: false,
        adultBoost: false,
        negative: UC.heavy,
        ucPreset: 'heavy',
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        steps: 28,
        scale: 5,
        cfgRescale: 0,
        seed: null,
        seedLocked: false,
        stepsLocked: false,
        scaleLocked: false,
        cfgRescaleLocked: false,
        varietyPlus: false,
        decrisper: false,
        useCoords: false,
        characters: [],
        refPath: '',
        refStrength: 0.7,
        refNoise: 0,
        authorRules: '',
    };
}

export function blankSettings() {
    return {
        enabled: false,
        apiBase: 'https://api.idlecloud.cc',
        apiKey: '',
        writerMode: 'st',
        writerBase: '',
        writerKey: '',
        writerModel: '',
        presets: [],
        defaults: defaultParams(),
        byChar: {},
    };
}

function mergeParams(raw) {
    const base = defaultParams();
    if (!raw || typeof raw !== 'object') return base;
    const next = { ...base, ...raw };
    next.characters = Array.isArray(raw.characters)
        ? raw.characters.map((c) => ({
            id: String(c.id || uid()),
            name: String(c.name || ''),
            enabled: c.enabled !== false,
            prompt: String(c.prompt || ''),
            uc: String(c.uc || ''),
            x: Number(c.x ?? 0.5),
            y: Number(c.y ?? 0.5),
        }))
        : [];
    delete next.presets;
    delete next.byChar;
    delete next.enabled;
    return next;
}

export function uid() {
    return Math.random().toString(36).slice(2, 10);
}

export function readSettings(extensionSettings) {
    const raw = extensionSettings[EXT_KEY];
    const blank = blankSettings();
    if (!raw || typeof raw !== 'object') {
        extensionSettings[EXT_KEY] = blank;
        return blank;
    }
    raw.enabled = !!raw.enabled;
    raw.apiBase = raw.apiBase || blank.apiBase;
    raw.apiKey = raw.apiKey || '';
    raw.writerMode = raw.writerMode === 'custom' ? 'custom' : 'st';
    raw.writerBase = raw.writerBase || '';
    raw.writerKey = raw.writerKey || '';
    raw.writerModel = raw.writerModel || '';
    raw.presets = Array.isArray(raw.presets) ? raw.presets : [];
    raw.defaults = mergeParams(raw.defaults);
    raw.byChar = raw.byChar && typeof raw.byChar === 'object' ? raw.byChar : {};
    for (const key of Object.keys(raw.byChar)) raw.byChar[key] = mergeParams(raw.byChar[key]);
    extensionSettings[EXT_KEY] = raw;
    return raw;
}

export function paramsFor(settings, key) {
    if (key && settings.byChar[key]) return settings.byChar[key];
    return settings.defaults;
}

export function hasOwn(settings, key) {
    return !!(key && settings.byChar[key]);
}
