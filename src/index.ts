/**
 * yammbo-social — Cloudflare Worker replacing the n8n workflow
 * `social-publish-daily` (socialPubDaily01).
 *
 * Cron (Mon-Sat 09:00 UTC): pick a service + visual style, write copy with
 * Groq, generate feed (1:1) + story (9:16) images with Imagen 4, store them in
 * R2 (served at /t/<file> so Meta can fetch them), publish to Instagram +
 * Facebook via the Graph API, and mirror both images to Telegram.
 *
 * /run endpoint (x-run-key auth): manual trigger. mode=dry generates + uploads
 * + Telegrams WITHOUT publishing to IG/FB (for previewing safely).
 */
import templates from './style-templates.json';

export interface Env {
  SOCIAL_TMP: R2Bucket;
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  META_PAGE_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  IG_BUSINESS_ID: string;
  FB_PAGE_ID: string;
  IMAGEN_MODEL: string;
  GROQ_MODEL: string;
  PUBLIC_BASE: string;
  RUN_KEY: string;
}

type Tpl = typeof templates;
const tpl = templates as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

// ───────────────────────── 1. pick service + style ─────────────────────────
function pickContext(styleOverride?: string, serviceOverride?: string) {
  const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getUTCDay()];
  const service =
    serviceOverride && tpl.service_metadata[serviceOverride]
      ? serviceOverride
      : tpl.round_robin[dayShort];
  if (!service) return null;

  const styleKeys = Object.keys(tpl.styles);
  const styleKey = styleOverride && tpl.styles[styleOverride] ? styleOverride : rnd(styleKeys);
  const style = tpl.styles[styleKey];
  const palette = rnd(style.palette_pools);
  const pillar = rnd(tpl.pillars);
  const density = rnd(style.best_density);
  const runId =
    new Date().toISOString().slice(0, 10).replace(/-/g, '') +
    '-' + service + '-' + Math.random().toString(36).slice(2, 8);

  return {
    runId, service, styleKey, style, styleFull: style, palette, pillar, density,
    serviceMeta: tpl.service_metadata[service],
    NEVER_MENTION: service === 'Flow' ? ['n8n', 'self-hosted automation'] : [],
  };
}

// ───────────────────────── 2. build groq prompt ─────────────────────────
function buildGroqPrompt(env: Env, d: any) {
  const sm = d.serviceMeta;
  const pillarBriefs: Record<string, string> = {
    feature: 'Highlight ONE concrete capability of the product. Be specific. Use numbers/details when natural.',
    pain_point: 'Name a frustrating problem the target audience faces, then frame the product as the relief. Empathetic, not preachy.',
    tip: 'Share a small, actionable insight or rule-of-thumb the audience can apply today. Educational, not salesy.',
    lifestyle: 'Paint a vibe / a moment / a feeling of using the product. Aspirational, sensory, human.',
  };
  const densitySpec: Record<string, any> = {
    sparse: { headline: '2-5 words, very punchy', subline: false, body: false },
    medium: { headline: '4-8 words', subline: '8-14 words explaining the headline', body: false },
    rich: { headline: '4-8 words', subline: '8-14 words', body: '1-2 short sentences + 2 micro-bullets' },
  };
  const spec = densitySpec[d.density];
  const forbidden = [
    'leverage', 'synergy', 'robust', 'cutting-edge', 'imagine', 'picture this',
    "in today's fast-paced world", 'revolutionize', 'game-changer', 'seamless',
    'unlock', 'unleash', 'elevate', 'empower', 'best-in-class', 'next-generation',
  ];
  if (d.NEVER_MENTION.length) forbidden.push(...d.NEVER_MENTION);

  const system = [
    'You are a senior B2B SaaS copywriter for Yammbo, a software ecosystem with 6 products: Yammbo Web (drag-and-drop website builder with AI), Yammbo POS (restaurant point-of-sale with KDS, inventory, tables), Yammbo Music (music streaming with hybrid radio), Yammbo Store (online storefront builder for ecommerce), Yammbo Bot (AI replies for Instagram, Facebook, and WhatsApp), and Yammbo Flow (workflow automation for founders and ops teams).',
    '',
    'Tone: confident, plainspoken, professional. American English. Never salesy, never corporate-speak.',
    '',
    'NEVER use these words/phrases: ' + forbidden.join(', '),
    ...(d.NEVER_MENTION.length ? ['CRITICAL: never mention or hint at these technologies/brands: ' + d.NEVER_MENTION.join(', ')] : []),
    '',
    'Output STRICT JSON only — no markdown, no code fences, no commentary. Schema:',
    '{',
    '  "headline": string,            // ' + spec.headline + ', all caps, no period at end unless stylistic',
    '  "subline": ' + (spec.subline ? 'string             // ' + spec.subline + ', sentence case' : 'null'),
    '  "body":    ' + (spec.body ? 'string                // ' + spec.body : 'null'),
    '  "caption": string,             // 500-900 chars Instagram caption with 3-5 short paragraphs separated by blank lines (\\n\\n). Conversational and substantive: open with a hook, deliver concrete value with examples or a brief story, end with a soft CTA. No hashtags inside (those go in the hashtags array). No markdown, no emojis.',
    '  "hashtags":[string]            // exactly 5-7 hashtags. Each must start with #. No spaces inside a tag.',
    '}',
  ].join('\n');

  const user = [
    'Service: Yammbo ' + d.service + ' (' + sm.url + ')',
    'Tagline: ' + sm.tagline,
    'Audience: ' + sm.audience,
    'Content pillar: ' + d.pillar.toUpperCase(),
    'Pillar brief: ' + pillarBriefs[d.pillar],
    'Visual style this post will use: ' + d.style.label + ' — ' + d.style.vibe,
    'Text density: ' + d.density + ' (headline ' + spec.headline + (spec.subline ? ', plus a subline' : '') + (spec.body ? ', plus body + bullets' : '') + ')',
    '',
    'Write the post copy now. Return ONLY the JSON object — no preamble, no explanation.',
  ].join('\n');

  return {
    model: env.GROQ_MODEL,
    temperature: 0.8,
    // gpt-oss bills reasoning against max_tokens: at the default effort a rich
    // post spent 1026 of 1269 tokens thinking and the JSON came back truncated,
    // which Groq rejects with 400 json_validate_failed. Low effort plus the
    // wider ceiling keeps a full post around 350 tokens.
    max_tokens: 1000,
    ...(/^openai\/gpt-oss/.test(env.GROQ_MODEL) ? { reasoning_effort: 'low' } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
}

// ───────────────────────── 3. call groq + parse ─────────────────────────
async function generateCopy(env: Env, d: any): Promise<any> {
  const req = buildGroqPrompt(env, d);
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(req),
  });
  if (!resp.ok) throw new Error('Groq HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const j: any = await resp.json();
  let content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq missing content: ' + JSON.stringify(j).slice(0, 300));
  content = String(content).trim();
  if (content.startsWith('```')) content = content.replace(/^```(json)?\n?/, '').replace(/```\s*$/, '').trim();
  let copy: any;
  try { copy = JSON.parse(content); } catch { throw new Error('Groq non-JSON: ' + content.slice(0, 300)); }
  for (const k of ['headline', 'caption', 'hashtags']) if (copy[k] == null) throw new Error('Groq missing ' + k);
  if (!Array.isArray(copy.hashtags)) throw new Error('hashtags not array');
  if (d.density === 'sparse') { copy.subline = null; copy.body = null; }
  if (d.density === 'medium') { copy.body = null; }
  return copy;
}

// ───────────────────────── 4. build imagen prompts ─────────────────────────
function buildFeedPrompt(d: any, c: any): string {
  const sf = d.styleFull, sk = d.styleKey, pal = d.palette, svc = d.service;
  const svcLower = svc.toLowerCase(), svcUpper = svc.toUpperCase();
  const headlineWords = String(c.headline || '').split(/\s+/).length;
  const nLines = headlineWords >= 6 ? '3' : (headlineWords >= 4 ? '2' : '1');

  let sublineBlock = '';
  if (c.subline) sublineBlock += `Below the headline a smaller ${pal.text} subtitle reads '${c.subline}'. `;
  if (c.body) sublineBlock += `Then a small body paragraph reads '${String(c.body).replace(/\n/g, ' ')}'. `;

  let subjectScene = '', ctaText = '', deviceScene = '', uiLabels = '';
  if (sf.cta_pool && sf.device_scenes) {
    ctaText = rnd(sf.cta_pool[svc] || ['Get Started']);
    deviceScene = sf.device_scenes[svc] || '';
    uiLabels = (sf.ui_labels && sf.ui_labels[svc]) || '';
  } else if (sf.subject_scenes) {
    subjectScene = sf.subject_scenes[svc] || '';
  } else if (sf.subject_objects) {
    subjectScene = sf.subject_objects[svc] || '';
  }

  const repl: Record<string, string> = {
    '{HEADLINE}': c.headline, '{n_lines}': nLines, '{subline_block}': sublineBlock,
    '{bg}': pal.bg, '{accent}': pal.accent, '{text_color}': pal.text,
    '{service}': svc, '{SERVICE_UPPER}': svcUpper, '{service_lower}': svcLower,
    '{subject_scene}': subjectScene, '{object_list}': subjectScene,
    '{cta_text}': ctaText, '{device_scene}': deviceScene, '{ui_labels}': uiLabels,
  };
  let prompt = sf.prompt_template as string;
  for (const [k, v] of Object.entries(repl)) prompt = prompt.split(k).join(v || '');
  return prompt.replace(/\s+/g, ' ').trim();
}

function buildStoryPrompt(feedPrompt: string): string {
  let v = feedPrompt
    .replace(/Square 1:1/gi, 'Vertical 9:16 mobile-format')
    .replace(/social media marketing poster/gi, 'social media story poster')
    .replace(/social marketing graphic/gi, 'social story graphic')
    .replace(/marketing graphic/gi, 'story-format marketing graphic')
    .replace(/Layout: illustration occupies the right two-thirds; left third is a vertical text block/gi, 'Layout: text block at the top third, illustration occupies the bottom two-thirds')
    .replace(/Left half of the frame: solid /gi, 'Top half of the frame: solid ')
    .replace(/Right half: clean pale off-white background/gi, 'Bottom half: clean pale off-white background')
    .replace(/On the left half:/gi, 'On the top half:')
    .replace(/On the right half:/gi, 'On the bottom half:')
    .replace(/Left side of the frame:/gi, 'Top area of the frame:')
    .replace(/Right side of the frame:/gi, 'Lower area of the frame:')
    .replace(/upper-left region/gi, 'top region')
    .replace(/upper-left corner/gi, 'top area');
  return 'Vertical 9:16 mobile-first composition for social-media stories. ' + v;
}

// ───────────────────────── 5. call imagen ─────────────────────────
// Image generation via Gemini 3.1 Flash Image ("Nano Banana 2"; 2.5 shuts down
// 2026-10-02) — renders UI text legibly. Same Gemini API key. 3.1 answers JPEG
// where 2.5 answered PNG, so the mime type travels with the bytes.
async function callImagen(env: Env, prompt: string, aspectRatio: string): Promise<{ data: string; mime: string; ext: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.IMAGEN_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
    }),
  });
  if (!resp.ok) throw new Error('Image gen HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const j: any = await resp.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p: any) => p?.inlineData?.data);
  if (!img) {
    const fr = j?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error('Image gen no image (finish=' + fr + '): ' + JSON.stringify(j).slice(0, 250));
  }
  const mime = String(img.inlineData.mimeType || 'image/png');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return { data: img.inlineData.data as string, mime, ext };
}

// ───────────────────────── 6. r2 upload ─────────────────────────
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function uploadR2(env: Env, key: string, b64: string, contentType: string): Promise<string> {
  await env.SOCIAL_TMP.put(key, b64ToBytes(b64), { httpMetadata: { contentType } });
  return `${env.PUBLIC_BASE}/${key}`;
}

// Signature for the public "cancel" link: HMAC-SHA256(RUN_KEY, id), first 32 hex.
async function adSig(env: Env, id: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RUN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(id)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ───────────────────────── 7. meta publish ─────────────────────────
async function metaPost(env: Env, path: string, params: Record<string, string>): Promise<any> {
  // params go in the BODY (form-encoded), not the query string — long captions
  // (~900 chars + hashtags) overflow the URL and Meta rejects with code 1.
  const resp = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j: any = await resp.json();
  if (!resp.ok || j.error) throw new Error('Meta ' + path + ' error: ' + JSON.stringify(j.error || j).slice(0, 300));
  return j;
}

async function metaDelete(env: Env, id: string): Promise<void> {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` },
  });
  const j: any = await resp.json();
  if (!resp.ok || j.error) throw new Error('Meta delete error: ' + JSON.stringify(j.error || j).slice(0, 200));
}

async function igPublish(env: Env, imageUrl: string, caption: string, isStory: boolean): Promise<string> {
  const params: Record<string, string> = { image_url: imageUrl };
  if (!isStory) params.caption = caption;
  if (isStory) params.media_type = 'STORIES';
  const container = await metaPost(env, `${env.IG_BUSINESS_ID}/media`, params);
  // poll container status until FINISHED (max ~40s)
  for (let i = 0; i < 10; i++) {
    await sleep(4000);
    const st = await fetch(`https://graph.facebook.com/v21.0/${container.id}?fields=status_code`, {
      headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` },
    }).then((r) => r.json() as any);
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR') throw new Error('IG container error: ' + JSON.stringify(st));
  }
  const pub = await metaPost(env, `${env.IG_BUSINESS_ID}/media_publish`, { creation_id: container.id });
  return pub.id as string;
}

// FB Page story: upload the photo unpublished, then publish it as a story.
// (FB feed is NOT posted here — it arrives via the IG->FB cross-post.)
async function fbStory(env: Env, imageUrl: string): Promise<void> {
  const photo = await metaPost(env, `${env.FB_PAGE_ID}/photos`, { url: imageUrl, published: 'false' });
  await metaPost(env, `${env.FB_PAGE_ID}/photo_stories`, { photo_id: photo.id });
}

// ───────────────────────── 8. telegram mirror ─────────────────────────
async function tgPhoto(env: Env, imageUrl: string, caption: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: imageUrl, caption: caption.slice(0, 1024) }),
  });
}

// ───────────────────────── main pipeline ─────────────────────────
async function runDaily(env: Env, dryRun = false, styleOverride?: string, serviceOverride?: string): Promise<any> {
  const d = pickContext(styleOverride, serviceOverride);
  // Sunday has no service in the round robin. Cloudflare fires the cron anyway,
  // and a day off is not a failure -- it used to throw and page Telegram weekly.
  if (!d) {
    console.log('STEP pick: no service scheduled today, skipping');
    return { skipped: 'no service scheduled for today' };
  }
  console.log('STEP pick', d.service, d.styleKey, d.density);
  const copy = await generateCopy(env, d);
  console.log('STEP groq ok:', copy.headline);
  const captionFull = (copy.caption || '').trim() + '\n\n' + (copy.hashtags || []).join(' ');

  const feedPrompt = buildFeedPrompt(d, copy);
  const feed = await callImagen(env, feedPrompt, '1:1');
  const feedB64 = feed.data;
  console.log('STEP imagen feed ok bytes:', feedB64.length);
  const feedUrl = await uploadR2(env, `${d.runId}-feed.${feed.ext}`, feedB64, feed.mime);
  console.log('STEP r2 feed ok:', feedUrl);

  await sleep(3000); // space Imagen calls (rate limit ~5 QPM)
  const storyPrompt = buildStoryPrompt(feedPrompt);
  const story = await callImagen(env, storyPrompt, '9:16');
  const storyB64 = story.data;
  console.log('STEP imagen story ok bytes:', storyB64.length);
  const storyUrl = await uploadR2(env, `${d.runId}-story.${story.ext}`, storyB64, story.mime);
  console.log('STEP r2 story ok:', storyUrl);

  const result: any = { runId: d.runId, service: d.service, style: d.styleKey, headline: copy.headline, feedUrl, storyUrl, dryRun };

  if (!dryRun) {
    // IG feed (auto cross-posts to the FB page feed) + IG story
    await igPublish(env, feedUrl, captionFull, false); result.igFeed = 'ok';
    await igPublish(env, storyUrl, captionFull, true); result.igStory = 'ok';
    // FB page story (the FB feed is covered by the IG->FB cross-post)
    try { await fbStory(env, storyUrl); result.fbStory = 'ok'; }
    catch (e: any) { result.fbStory = 'error: ' + e.message; }
  }

  await tgPhoto(env, feedUrl, `${dryRun ? '🧪 DRY-RUN' : '📸 Publicado IG+FB'} · ${d.service} · ${d.styleKey}\n\n${captionFull}`);
  await tgPhoto(env, storyUrl, `${dryRun ? '🧪 DRY-RUN story' : '📲 Story (WhatsApp Status ready)'} · ${d.service}`);
  return result;
}

// ───────────────────────── handlers ─────────────────────────
export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // await (not waitUntil): the scheduled invocation gets the full duration
    // budget; waitUntil is capped ~30s "after invocation end" and was killing
    // the pipeline before Telegram/publish.
    try {
      await runDaily(env, false);
    } catch (e: any) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: '🟠 <b>SOCIAL POST FAILED</b>\n' + String(e.message || e).slice(0, 400), parse_mode: 'HTML' }),
      });
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const seg = url.pathname.replace(/^\/+/, '');

    // Serve temp images from R2 so Meta can fetch them.
    if (req.method === 'GET' && seg.startsWith('t/')) {
      const key = seg.slice(2);
      const obj = await env.SOCIAL_TMP.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    if (req.method === 'GET' && seg === '') return new Response('yammbo-social ok', { status: 200 });

    // Manual trigger: POST /run?mode=dry|real  (x-run-key auth)
    if (req.method === 'POST' && seg === 'run') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const dry = url.searchParams.get('mode') !== 'real';
      const style = url.searchParams.get('style') || undefined;
      const service = url.searchParams.get('service') || undefined;
      try {
        const r = await runDaily(env, dry, style, service);
        return new Response(JSON.stringify(r, null, 2), { headers: { 'content-type': 'application/json' } });
      } catch (e: any) {
        return new Response('error: ' + (e.message || e), { status: 500 });
      }
    }

    // Cancel link from the Telegram preview: /cancel-ad?id=..&sig=.. (signed, no run-key:
    // it opens in the owner's browser). Writes cancelled/<id>; /publish-ad refuses it.
    if (req.method === 'GET' && seg === 'cancel-ad') {
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]{6,80}$/.test(id) || url.searchParams.get('sig') !== (await adSig(env, id))) return new Response('enlace no válido', { status: 403 });
      const pub = await env.SOCIAL_TMP.head(`published/${id}`);
      if (!pub) await env.SOCIAL_TMP.put(`cancelled/${id}`, new Date().toISOString());
      const msg = pub ? 'Demasiado tarde: esta publicación ya salió.' : '✅ Publicación cancelada. No se subirá nada.';
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:600 20px system-ui;padding:40px;text-align:center">${msg}</body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Status of a scheduled ad for the VPS (x-run-key auth).
    if (req.method === 'GET' && seg === 'ad-status') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const id = url.searchParams.get('id') || '';
      const [c, p] = await Promise.all([env.SOCIAL_TMP.head(`cancelled/${id}`), env.SOCIAL_TMP.head(`published/${id}`)]);
      return new Response(JSON.stringify({ id, cancelled: !!c, published: !!p, sig: await adSig(env, id) }), { headers: { 'content-type': 'application/json' } });
    }

    // Read-only audience/engagement snapshot for account decisions (x-run-key auth).
    if (req.method === 'GET' && seg === 'meta-insights') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const g = (p: string) => fetch(`https://graph.facebook.com/v21.0/${p}`, { headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` } }).then((r) => r.json());
      const ig = env.IG_BUSINESS_ID;
      const [acct, media, country, city, reach] = await Promise.all([
        g(`${ig}?fields=username,followers_count,follows_count,media_count`),
        g(`${ig}/media?fields=timestamp,like_count,comments_count,media_type&limit=30`),
        g(`${ig}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country`),
        g(`${ig}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city`),
        g(`${ig}/insights?metric=reach&period=day&metric_type=total_value&since=${Math.floor(Date.now() / 1000) - 28 * 86400}&until=${Math.floor(Date.now() / 1000)}`),
      ]);
      return new Response(JSON.stringify({ acct, media, country, city, reach }, null, 1), { headers: { 'content-type': 'application/json' } });
    }

    // Read-only health check of the Meta page token and linked accounts (x-run-key auth).
    if (req.method === 'GET' && seg === 'meta-check') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const g = (p: string) => fetch(`https://graph.facebook.com/v21.0/${p}`, { headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` } }).then((r) => r.json());
      const page: any = await g(`${env.FB_PAGE_ID}?fields=id,name`);
      const ig: any = await g(`${env.IG_BUSINESS_ID}?fields=id,username,website,followers_count`);
      const lim: any = await g(`${env.IG_BUSINESS_ID}/content_publishing_limit?fields=quota_usage,config`);
      return new Response(JSON.stringify({ page, ig, publishingLimit: lim }, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // Publish a ready-made ad from the VPS ad factory (x-run-key auth).
    // Body: { id, caption, feed_b64, story_b64 } — JPEG base64 (IG accepts JPEG only).
    // Order: IG feed (the post that matters), then IG story, then FB story; a story
    // failure is reported but does not undo the feed. FB feed arrives through the
    // page's IG->FB cross-post, as with the daily run. A marker in R2 refuses a
    // second publish of the same id (the VPS job can be re-run by hand).
    if (req.method === 'POST' && seg === 'publish-ad') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const b: any = await req.json().catch(() => ({}));
      if (!b.id || !/^[\w-]{6,80}$/.test(b.id) || !b.caption || !b.feed_b64 || !b.story_b64) return new Response('missing id/caption/feed_b64/story_b64', { status: 400 });
      const dry = url.searchParams.get('mode') !== 'real';
      const marker = `published/${b.id}`;
      if (!dry && (await env.SOCIAL_TMP.head(marker))) return new Response(JSON.stringify({ error: 'already published', id: b.id }), { status: 409, headers: { 'content-type': 'application/json' } });
      if (await env.SOCIAL_TMP.head(`cancelled/${b.id}`)) return new Response(JSON.stringify({ error: 'cancelled', id: b.id }), { status: 409, headers: { 'content-type': 'application/json' } });
      const out: any = { id: b.id, dry };
      try {
        out.feedUrl = await uploadR2(env, `ad-${b.id}-feed.jpg`, b.feed_b64, 'image/jpeg');
        out.storyUrl = await uploadR2(env, `ad-${b.id}-story.jpg`, b.story_b64, 'image/jpeg');
        if (dry) return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
        await env.SOCIAL_TMP.put(marker, new Date().toISOString());   // before posting: a retry must not double-post
        const mediaId = await igPublish(env, out.feedUrl, b.caption, false);
        const pl: any = await fetch(`https://graph.facebook.com/v21.0/${mediaId}?fields=permalink`, { headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` } }).then((r) => r.json());
        out.igFeed = { id: mediaId, permalink: pl.permalink || null };
      } catch (e: any) {
        out.error = 'feed: ' + (e.message || e);
        return new Response(JSON.stringify(out, null, 2), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      try { out.igStory = await igPublish(env, out.storyUrl, '', true); } catch (e: any) { out.igStoryError = String(e.message || e).slice(0, 300); }
      try { await fbStory(env, out.storyUrl); out.fbStory = 'ok'; } catch (e: any) { out.fbStoryError = String(e.message || e).slice(0, 300); }
      return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // FB story test: publish a page story from an existing R2 image (x-run-key auth)
    if (req.method === 'POST' && seg === 'fbstorytest') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const img = url.searchParams.get('img');
      if (!img) return new Response('missing img param', { status: 400 });
      try {
        await fbStory(env, img);
        return new Response('fb story published ok\n', { status: 200 });
      } catch (e: any) {
        return new Response('fb story error: ' + (e.message || e), { status: 500 });
      }
    }

    // Image POC: generate an arbitrary image (prompt + aspectRatio) to R2. For blog-cover experiments.
    if (req.method === 'POST' && seg === 'imgtest') {
      if (!env.RUN_KEY || req.headers.get('x-run-key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      const body: any = await req.json().catch(() => ({}));
      if (!body.prompt) return new Response('missing prompt', { status: 400 });
      try {
        const img = await callImagen(env, body.prompt, body.aspectRatio || '1:1');
        const key = 'imgtest-' + Math.random().toString(36).slice(2, 9) + '.' + img.ext;
        const u = await uploadR2(env, key, img.data, img.mime);
        return new Response(JSON.stringify({ url: u }, null, 2), { headers: { 'content-type': 'application/json' } });
      } catch (e: any) {
        return new Response('error: ' + (e.message || e), { status: 500 });
      }
    }

    return new Response('method not allowed', { status: 405 });
  },
};
