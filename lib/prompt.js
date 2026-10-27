import { IMAGE_BG_RULES, IMAGE_MULTI_RULES, IMAGE_SHOT_RULES, IMAGE_SYSTEM } from './prompt-text.js';
import { assignCharTags, extractJsonObject, presenceFromTags, resolveAbsentIds, sanitizeNaiTags } from './tags.js';

export function isV5Model(model) {
    return model === 'nai-diffusion-5-full' || model === 'nai-diffusion-5-curated';
}

export function imageTagBudget(model) {
    return isV5Model(model) ? 110 : 45;
}

export function imageWriteMaxTokens(model) {
    return isV5Model(model) ? 700 : 500;
}

export function imageLengthRules(model, adultBoost) {
    const n = imageTagBudget(model);
    const adult = isV5Model(model)
        ? '成人提示词加强开着：可以写 40–110 组。够用就停，禁止为凑满上限再堆，也不要压成十几组。'
        : '成人提示词加强开着：可以写 25–45 组。够用就停，禁止为凑满上限再堆，也不要压成十几组。';
    return `【篇幅——必须遵守】
组 = 逗号隔开的一段。from behind 是 1 组，不是两个词。
这一轮新加的 tag 合计必须不超过 ${n} 组（多人则 base 与各人 chars 加起来必须不超过 ${n}）。超过就是错。
日常大约 12–25 组。${adultBoost ? `\n${adult}` : ''}
表情必须 2–3 组：哭留一个，脸红留一个，嘴或眼留镜头上最显眼的一个。翻白眼替换其中之一，不另加。不要连写近义情绪词。不要写看不见的情绪抽象词。对白里的现场脏污、残留可以写。
衣服只写变化，不要把用户正面提示词里已有的成衣名再写一遍。同一变化只写一次。
场景 1–2 组。有地点了不要再堆室内、材质、封闭空间。
对白里的动作和状态都可以写。同一意思不要连写近义。词库按需取，禁止把一整类抄进输出。
补全顺序用来查漏，不要为填满清单再堆。`;
}

function multiInsertInstruction(characters, inline = false) {
    const roster = characters.map((c, i) => `${i + 1}. ${c.name.trim() || `角色${i + 1}`}`).join('\n');
    const head = inline
        ? '<<<PROMPT>>> 里只输出 JSON（不要 markdown）'
        : '输出 JSON（不要 markdown）';
    return `${head}：{"base":"这一镜真正画出来的人数、场景、镜头、光线","chars":{"在场者名单上的中文名":"该人动作表情姿势"},"absent":["不在场的角色名"]}
角色名单：
${roster}
chars 只写这一镜在场的人，键逐字用名单上的中文名。不在场的放进 absent，不要给键。不必每个人都写。`;
}

export function writerSystem(params) {
    const insert = enabledSlots(params).length > 0;
    const extra = [
        params.adultBoost
            ? '成人提示词加强：开。这是最高优先级之一。对白里的动作、部位、体液必须写成具体真 tag，不要收成 ass focus / naughty face。无关内容仍不要加。只输出标签，不要解释。'
            : '成人提示词加强：关。对白里看得见的仍写具体真 tag，不要额外堆没写到的器官特写。完全没有性/血腥的场面不要加 nsfw。只输出标签，不要解释。',
        imageLengthRules(params.model, params.adultBoost),
        insert ? IMAGE_MULTI_RULES : '',
        params.authorRules?.trim()
            ? `【生图规则·作者指令·压过前面的默认】\n下面是用户给写 tag 的规则，只约束怎么写，禁止把这段原文抄进 tag。\n和前面的默认冲突时，以这里为准。\n${params.authorRules.trim()}`
            : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    return `${IMAGE_SYSTEM}\n\n${extra}`;
}

export function enabledSlots(params) {
    return (params.characters || []).filter((c) => c.enabled && (c.name || c.prompt || c.uc));
}

export function writerUser(params, brief) {
    const slots = enabledSlots(params);
    const insert = slots.length > 0;
    const names = slots.map((c) => c.name).filter(Boolean).join('、');
    const format = insert
        ? multiInsertInstruction(slots)
        : '只输出英文 tag 一行，地点写最前。禁止 JSON。';
    const turnUser = insert
        ? `这一轮用户（只用来判断谁在场；姿势、动作、衣服仍只认本镜）：\n${brief.turnUser || '（无）'}\n\n`
        : '';
    return `角色：${names || '（未命名）'}
外貌已由用户写好，不要重复（含发色瞳色体型种族整套衣服）。
成人提示词加强：${params.adultBoost ? '开' : '关'}
多人：${insert ? '是' : '否'}　插入模式：${insert ? 'insert' : '单人'}

${IMAGE_SHOT_RULES}

${IMAGE_BG_RULES}

${insert ? `${IMAGE_MULTI_RULES}\n\n` : ''}写法：先抽出本镜里最显眼的动作/部位，写成具体真 tag，不要收成 ass focus、naughty face 这种安全词。空格真 tag，禁止下划线。不要写画师质量词和外貌。
用户已发生的动作优先于角色回里写软了的版本，必须写成已经发生，不要停在入口。
成人开着：把画面写成具体真 tag，不要保守。「不要硬塞」只挡住完全无关的内容。
成人关着：对白里看得见的仍写，不额外堆没写到的特写；完全没有性/血腥则不加 nsfw。
只输出标签，不要解释。

${imageLengthRules(params.model, params.adultBoost)}

本镜（姿势、镜头、正在做的事只认这段）：
${brief.shot || '（无）'}

${turnUser}${brief.memory ? `长期记忆（只继承没被推翻的状态，不含地点）：\n${brief.memory}\n` : ''}残留参考（不要继承已结束的动作/体位/朝向，也不要用它决定谁在场）：
${brief.residual || '（无）'}

上一镜地点（对白看不出人在哪时才用，只借人所在的地方）：
${brief.prevScene || '（无）'}

${format}`;
}

export function chatImageTail(params, prevScene) {
    const slots = enabledSlots(params);
    const insert = slots.length > 0;
    const format = insert
        ? multiInsertInstruction(slots, true)
        : '<<<PROMPT>>> 里只输出英文 tag 一行。禁止 JSON。';
    const adult = params.adultBoost
        ? '【成人提示词加强】开。对白里的动作、部位、体液必须写成具体真 tag，不要收成 ass focus / naughty face。无关内容仍不要加。'
        : '【成人提示词加强】关。对白里看得见的仍写具体真 tag，不额外堆没写到的器官特写。完全没有性/血腥的场面不要加 nsfw。';
    const author = params.authorRules?.trim()
        ? `【生图规则·作者指令·压过前面的默认】\n下面是用户给写 tag 的规则，只约束怎么写，禁止把这段原文抄进 tag。\n和前面的默认冲突时，以这里为准。\n${params.authorRules.trim()}`
        : '';
    return `${IMAGE_SYSTEM}

${IMAGE_SHOT_RULES}

${IMAGE_BG_RULES}

${insert ? `${IMAGE_MULTI_RULES}\n\n` : ''}上一镜地点（对白看不出人在哪时才用，只借人所在的地方）：
${String(prevScene || '').trim() || '（无）'}

${adult}

${imageLengthRules(params.model, params.adultBoost)}
${author ? `\n${author}\n` : ''}
【输出顺序——必须遵守，覆盖「只输出标签」】
1. 先写完整角色扮演正文（若开启状态栏，放在正文最后）。正文里禁止出现 tag、禁止出现 <<<PROMPT>>>。
2. 正文全部结束后另起一行，只输出：
<<<PROMPT>>>
（生图内容，见下）
<<<END>>>
写到 <<<PROMPT>>> 之后仍须遵守上面的格式、词库、正反例、成人开关，只输出 tag 或 JSON，不要解释。

${format}`;
}

export function splitChatPrompt(full) {
    const text = String(full || '');
    const start = text.search(/<<<\s*PROMPT\s*>>>/i);
    if (start < 0) return { visible: text, prompt: null, started: false };
    const after = text.slice(start).replace(/^<<<\s*PROMPT\s*>>>/i, '');
    const end = after.search(/<<<\s*END\s*>>>/i);
    const prompt = (end < 0 ? after : after.slice(0, end)).trim();
    const tail = end < 0 ? '' : after.slice(end).replace(/^<<<\s*END\s*>>>/i, '');
    const visible = `${text.slice(0, start).replace(/\s+$/, '')}${tail.replace(/^\s+/, tail.trim() ? '\n' : '')}`.trim();
    return { visible, prompt, started: true };
}

export function parseTagOutput(text, params) {
    const slots = enabledSlots(params);
    const insert = slots.length > 0;
    const roster = slots.map((c) => ({ id: c.id, name: (c.name || '').trim() }));
    const json = extractJsonObject(text);
    if (json && (json.base != null || json.chars != null)) {
        const rawChars = {};
        const src = json.chars && typeof json.chars === 'object' ? json.chars : {};
        for (const [k, v] of Object.entries(src)) rawChars[k] = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
        const { mapped, leftover } = assignCharTags(rawChars, roster);
        const base = sanitizeNaiTags([String(json.base || ''), leftover].filter(Boolean).join(', '));
        const absent = resolveAbsentIds(json.absent, roster);
        const presence = presenceFromTags(Object.keys(mapped), absent);
        if (!insert) {
            const absentSet = new Set(absent);
            const extras = Object.entries(mapped)
                .filter(([id]) => !absentSet.has(id))
                .map(([, tags]) => tags)
                .filter(Boolean);
            return { base: sanitizeNaiTags([base, ...extras].filter(Boolean).join(', ')), chars: {}, presence };
        }
        return { base, chars: mapped, presence };
    }
    return { base: sanitizeNaiTags(String(text || '').replace(/\n/g, ', ')), chars: {}, presence: undefined };
}
