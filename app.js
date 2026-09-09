// 每日养分 前端逻辑（双模式：有后端=真实自动抓取+SSE推送；无后端=浏览器端代理抓取+本地存储+种子兜底）
// 国内热点的热度算法从 heat-core.js 引入 —— 与服务端 hotnews.js 是同一份实现，不会分叉
import {
  HOT_SOURCES as HEAT_SOURCES, WORLD_SOURCES as HEAT_SOURCES_WORLD, TOP_N as HEAT_TOP_N,
  parseSource as heatParseSource, cleanCandidates as heatClean,
  clusterAll as heatCluster, repOf as heatRepOf,
  scoreCluster as heatScore, pickDiverse as heatPickDiverse,
  extractSummaryFromHtml as heatExtractSummary, clip as heatClip,
  NO_SUMMARY_HINT
} from './heat-core.js';

const $ = (s) => document.querySelector(s);
const content = $('#content');
const state = {
  current: 'books',
  booksMode: 'daily',
  englishMode: 'daily',
  books: null,
  english: null,
  insights: [],
  favQuotes: [],
  backend: true,
  seed: null
};

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}
function todayStr() { return new Date().toLocaleDateString('zh-CN'); }
function todayKey() { return new Date().toISOString().slice(0, 10); }
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function triggerFade() {
  content.classList.remove('fade');
  void content.offsetWidth;
  content.classList.add('fade');
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ---------- 后端探测 ----------
// 严格探测：静态托管会把未知路径回退成 200 + index.html，
// 因此必须校验 content-type 为 JSON 且能解析出预期字段，否则一律判定无后端。
async function detectBackend() {
  state.backend = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/api/settings', { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (r.ok) {
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('json')) {
        const j = await r.json();
        state.backend = !!(j && typeof j === 'object' && ('pushTime' in j || 'pushEnabled' in j));
      }
    }
  } catch { state.backend = false; }
  try { if (!state.backend) showModeNotice(); } catch {}
}
function showModeNotice() {
  const b = $('#pushBanner');
  const d = (state.seed && state.seed.date) ? state.seed.date : '';
  b.innerHTML = `<span class="pb-close" id="pbCloseMode">✕</span>
    <div class="pb-title">ℹ️ 在线独立版${d ? ' · 内容快照 ' + d : ''}</div>
    <pre>新闻/书籍/英语显示的是已抓取好的内容快照，打开即可读；同时会在后台尝试拉取更新，成功会自动刷新。
感悟灵感保存在本机浏览器（本设备可回溯）。
如需「每日 07:00 自动抓取 + 定时推送 + 多端同步」，在电脑上运行后端：node server/server.js</pre>`;
  b.classList.remove('hidden');
  const c = $('#pbCloseMode');
  if (c) c.onclick = () => b.classList.add('hidden');
}

// ---------- 浏览器端实时抓取（无后端兜底，best-effort）----------
const PROXIES = [
  (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://thingproxy.freeboard.io/fetch/' + u
];
// 单个代理 5s 超时；全部失败即返回空串，由调用方走种子兜底。
// 绝不让用户为一次抓取等待超过 5s。
async function proxyFetch(url) {
  for (const p of PROXIES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(p(url), { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) { const txt = await r.text(); if (txt && txt.length > 20) return txt; }
    } catch { /* 试下一个 */ }
    clearTimeout(t);
  }
  return '';
}
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
function summarize(s, max = 90) {
  let t = stripTags(s).replace(/https?:\/\/\S+/g, '').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}
function parseFeedClient(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const nodes = Array.from(doc.querySelectorAll('item, entry'));
    const out = [];
    for (const n of nodes) {
      const title = stripTags(n.querySelector('title')?.textContent || '');
      let link = n.querySelector('link')?.getAttribute('href') || stripTags(n.querySelector('link')?.textContent || '');
      const desc = n.querySelector('description')?.textContent || n.querySelector('summary')?.textContent || n.querySelector('content')?.textContent || '';
      if (!title || !link) continue;
      out.push({ title, link: stripTags(link), summary: summarize(desc), source: '', pub: '' });
      if (out.length >= 10) break;
    }
    return out;
  } catch { return []; }
}
// （书籍封面改用豆瓣真实封面 + 本地 SVG 兜底，已不再依赖 Open Library / Google Books 前端升级）
const ENGLISH_SOURCES = [
  'https://learningenglish.voanews.com/api/f=1/',
  'https://www.bbc.co.uk/learningenglish/feeds/leigh-answer-question',
  'https://bookriot.com/feed/'
];
function seedBooks() { return (state.seed && state.seed.books) || null; }
function seedOral() { return (state.seed && state.seed.oral) || []; }
function seedNews(cat) { return (state.seed && state.seed.news && state.seed.news[cat]) || []; }

function daySeed(date) {
  let h = 0; const s = date.replace(/-/g, '');
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function pickOral(seed, n) {
  const arr = seedOral(); if (!arr.length) return [];
  const start = seed % arr.length; const out = [];
  for (let i = 0; i < n; i++) out.push(arr[(start + i) % arr.length]);
  return out;
}

// 独立模式：书籍金句（直接读取 build 时固化的真实书单：2 本新书 + 3 句名言；按日缓存在本机）
function standaloneBooks() {
  const today = todayKey();
  const cacheKey = 'dn_books_' + today;
  const cached = lsGet(cacheKey);
  if (cached && cached.books && cached.books.length) return cached;
  const seed = seedBooks();
  if (seed && seed.books && seed.books.length) { lsSet(cacheKey, seed); return seed; }
  return { date: today, books: [], quotes: [], source: 'curated', dataSources: [] };
}
// 独立模式：新闻（种子秒开 + 后台并行升级；绝不串行等待多个源）
const NEWS_SOURCES = {
  domestic: ['https://www.chinanews.com.cn/rss/scroll-news.xml', 'http://www.people.com.cn/rss/politics.xml'],
  world: ['https://www.chinanews.com.cn/rss/world.xml', 'https://feeds.bbci.co.uk/zhongwen/simp/index.xml'],
  medical: ['https://www.chinanews.com.cn/rss/health.xml', 'http://www.jkb.com.cn/rss/jkb.xml'],
  ai: ['https://www.qbitai.com/feed', 'https://36kr.com/feed', 'https://sspai.com/feed']
};
const NEWS_KEYS = ['domestic', 'world', 'medical', 'ai'];
// 种子里的国内热点带 heat/crossCount 等字段，seedNewsCat 负责把 newsMeta 的源信息一起还原
function seedNewsCat(key) {
  const cat = { title: TITLES[key], items: seedNews(key).map(x => ({ ...x })) };
  const meta = (state.seed && state.seed.newsMeta && state.seed.newsMeta[key]) || null;
  if (meta) Object.assign(cat, meta);
  return cat;
}
function seedNewsResult() {
  const r = { categories: {} };
  for (const key of NEWS_KEYS) r.categories[key] = seedNewsCat(key);
  return r;
}
async function standaloneNews() {
  const today = todayKey();
  const cached = lsGet('dn_news_' + today);
  if (cached && cached.categories) return cached;
  kickNewsUpgrade(today);
  return seedNewsResult();
}
let newsUpgrading = false;
async function kickNewsUpgrade(today) {
  if (newsUpgrading) return; newsUpgrading = true;
  try {
    const result = { categories: {} };
    let gained = 0;
    await Promise.all(NEWS_KEYS.map(async (key) => {
      // 国内热点走完整热度管线（六源 + 事件聚类 + 热度排序 + 真实摘要）
      if (key === 'domestic') {
        try {
          const hot = await clientHotDomestic();
          if (hot && hot.items.length >= 5) {
            gained++;
            result.categories[key] = {
              title: TITLES[key], hot: true,
              items: hot.items, sourceList: hot.sourceList, sourceStat: hot.sourceStat
            };
            return;
          }
        } catch { /* 失败保留种子快照 */ }
        result.categories[key] = seedNewsCat(key);
        return;
      }
      // 国际热点走完整热度管线（12 源 + 事件聚类 + 热度排序 + 真实摘要）
      if (key === 'world') {
        try {
          const hot = await clientHotWorld();
          if (hot && hot.items.length >= 5) {
            gained++;
            result.categories[key] = {
              title: TITLES[key], hot: true,
              items: hot.items, sourceList: hot.sourceList, sourceStat: hot.sourceStat
            };
            return;
          }
        } catch { /* 失败保留种子快照 */ }
        result.categories[key] = seedNewsCat(key);
        return;
      }
      let items = []; const seen = new Set();
      const res = await Promise.allSettled(NEWS_SOURCES[key].map(s => proxyFetch(s)));
      for (const x of res) {
        if (x.status !== 'fulfilled' || !x.value) continue;
        for (const it of parseFeedClient(x.value)) {
          const k = it.title; if (seen.has(k)) continue; seen.add(k); items.push(it);
        }
      }
      if (items.length) { gained++; result.categories[key] = { title: TITLES[key], items: items.slice(0, 10) }; }
      else result.categories[key] = seedNewsCat(key);
    }));
    if (gained > 0) {
      lsSet('dn_news_' + today, result);
      if (NEWS_KEYS.includes(state.current)) { await renderNews(state.current); toast('已抓取今日最新新闻'); }
    }
  } catch { /* 静默失败，保留种子 */ } finally { newsUpgrading = false; }
}

// ---------- 客户端国内热点管线（无后端时用，算法与服务端完全一致）----------
// 浏览器直连这些站点会被 CORS 拦，所以统一走 proxyFetch 的公共代理。
// 列表页 6 个请求并发；摘要只补 Top10，且失败不影响热度榜展示。
async function clientHotDomestic() {
  const texts = await Promise.allSettled(HEAT_SOURCES.map(s => proxyFetch(s.url)));
  let all = [];
  const sourceStat = {};
  texts.forEach((r, i) => {
    const src = HEAT_SOURCES[i];
    const txt = (r.status === 'fulfilled' && r.value) ? r.value : '';
    const arr = txt ? heatParseSource(txt, src) : [];
    sourceStat[src.name] = arr.length;
    all = all.concat(arr);
  });
  all = heatClean(all);
  if (all.length < 8) return null;   // 代理大面积失败，交回种子快照

  const clusters = heatCluster(all);
  const ranked = clusters
    .map(c => ({ c, s: heatScore(c) }))
    .sort((a, b) => b.s.heat - a.s.heat);
  const picked = heatPickDiverse(ranked, HEAT_TOP_N, 3);

  // 补真实摘要：写回簇代表对象，之后用同一批簇重算分数（不可再聚类，否则交叉数被抹平）
  await Promise.allSettled(picked.map(async (p) => {
    const it = heatRepOf(p.c);
    if (it.summary && it.summary.length >= 30) { it.summary = heatClip(it.summary); return; }
    const html = await proxyFetch(it.link);
    const s = heatExtractSummary(html, it.title);
    it.summary = s ? heatClip(s) : (it.summary ? heatClip(it.summary) : NO_SUMMARY_HINT);
  }));

  const items = picked
    .map(p => heatScore(p.c))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, HEAT_TOP_N)
    .map((it, i) => ({ ...it, rankNo: i + 1 }));

  return {
    items, sourceStat,
    sourceList: HEAT_SOURCES.map(s => ({ name: s.name, home: s.home }))
  };
}
// 独立模式：国际热点管线（无后端时用，算法与服务端完全一致，intl=英文标题/国际关键词）
async function clientHotWorld() {
  const texts = await Promise.allSettled(HEAT_SOURCES_WORLD.map(s => proxyFetch(s.url)));
  let all = [];
  const sourceStat = {};
  texts.forEach((r, i) => {
    const src = HEAT_SOURCES_WORLD[i];
    const txt = (r.status === 'fulfilled' && r.value) ? r.value : '';
    const arr = txt ? heatParseSource(txt, src) : [];
    sourceStat[src.name] = arr.length;
    all = all.concat(arr);
  });
  all = heatClean(all);
  if (all.length < 8) return null;   // 代理大面积失败，交回种子快照

  const clusters = heatCluster(all);
  const ranked = clusters
    .map(c => ({ c, s: heatScore(c, true) }))
    .sort((a, b) => b.s.heat - a.s.heat);
  const picked = heatPickDiverse(ranked, HEAT_TOP_N, 3);

  await Promise.allSettled(picked.map(async (p) => {
    const it = heatRepOf(p.c);
    if (it.summary && it.summary.length >= 30) { it.summary = heatClip(it.summary); return; }
    const html = await proxyFetch(it.link);
    const s = heatExtractSummary(html, it.title);
    it.summary = s ? heatClip(s) : (it.summary ? heatClip(it.summary) : NO_SUMMARY_HINT);
  }));

  const items = picked
    .map(p => heatScore(p.c, true))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, HEAT_TOP_N)
    .map((it, i) => ({ ...it, rankNo: i + 1 }));

  return {
    items, sourceStat,
    sourceList: HEAT_SOURCES_WORLD.map(s => ({ name: s.name, home: s.home }))
  };
}
// 独立模式：英语（口语来自本地 52 句库，必有内容；新闻种子秒开 + 后台升级）
function seedEnglishNews() {
  const sn = state.seed && state.seed.english && state.seed.english.news;
  if (sn && sn.title) return sn;
  return {
    title: 'The Power of Daily Reading',
    summary: 'Reading a little every day builds knowledge steadily and quietly changes how you think.',
    link: 'https://www.bbc.co.uk/learningenglish', source: '内置'
  };
}
async function standaloneEnglish(mode) {
  const today = todayKey();
  const cached = lsGet('dn_eng_' + today);
  const oral = pickOral(daySeed(today), 10);
  if (cached && cached.news) {
    return { date: today, news: cached.news, oral: cached.oral && cached.oral.length ? cached.oral : oral, history: engHistory(), mode };
  }
  const news = seedEnglishNews();
  lsSet('dn_eng_' + today, { news, oral });
  kickEnglishUpgrade(today, oral);
  return { date: today, news, oral, history: engHistory(), mode };
}
let engUpgrading = false;
async function kickEnglishUpgrade(today, oral) {
  if (engUpgrading) return; engUpgrading = true;
  try {
    const cur = lsGet('dn_eng_' + today);
    if (cur && cur.news && cur.news.content && cur.news.content.length) return; // 种子已含全文，无需后台升级
    const res = await Promise.allSettled(ENGLISH_SOURCES.map(s => proxyFetch(s)));
    for (const x of res) {
      if (x.status !== 'fulfilled' || !x.value) continue;
      const items = parseFeedClient(x.value).filter(it => !/[\u4e00-\u9fff]/.test(it.title));
      if (items.length) {
        lsSet('dn_eng_' + today, { news: items[0], oral });
        if (state.current === 'english') { await renderEnglish(); toast('已更新今日英语新闻'); }
        break;
      }
    }
  } catch { /* 静默失败，保留种子 */ } finally { engUpgrading = false; }
}
function engHistory() {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const it = lsGet('dn_eng_' + d);
    if (it) out.push({ date: d, news: it.news, oral: it.oral });
  }
  return out;
}

// ---------- 数据加载（按模式分支）----------
async function loadBooks() {
  if (state.backend) return api('/api/books?mode=' + state.booksMode);
  return standaloneBooks();
}
async function loadNews() {
  if (state.backend) return api('/api/news');
  return standaloneNews();
}
async function loadEnglish() {
  if (state.backend) return api('/api/english?mode=' + state.englishMode);
  return standaloneEnglish(state.englishMode);
}
async function loadInsights() {
  if (state.backend) { const r = await api('/api/insights'); return r.list || []; }
  return lsGet('dn_insights') || [];
}
async function saveInsight(text, image) {
  if (state.backend) { const r = await api('/api/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, image }) }); return r.list; }
  const list = lsGet('dn_insights') || [];
  list.unshift({ id: Date.now() + Math.random().toString(36).slice(2, 6), text: text.slice(0, 2000), image: (image || '').slice(0, 200000), date: todayKey(), ts: new Date().toISOString() });
  lsSet('dn_insights', list.slice(0, 1000));
  return list;
}
async function delInsight(id) {
  if (state.backend) { const r = await api('/api/insights/' + id, { method: 'DELETE' }); return r.list; }
  const list = (lsGet('dn_insights') || []).filter(x => x.id !== id);
  lsSet('dn_insights', list);
  return list;
}

// ---------- 模块标题 ----------
const TITLES = {
  books: '书籍金句', domestic: '国内热点', world: '国际热点',
  medical: '医疗进展', ai: 'AI热点', english: '英语积累', insights: '感悟灵感'
};

// ---------- 渲染调度（单向：事件→render，render 之间不互调）----------
async function renderModule(key) {
  $('#moduleTitle').textContent = TITLES[key];
  setActiveNav(key);
  try {
    if (key === 'books') return await renderBooks();
    if (key === 'english') return await renderEnglish();
    if (key === 'insights') return await renderInsights();
    if (['domestic', 'world', 'medical', 'ai'].includes(key)) return await renderNews(key);
  } catch (err) {
    // 兜底：绝不让页面停在「加载中」
    showRenderError(key, err);
  }
}
function showRenderError(key, err) {
  const msg = (err && err.message) ? err.message : String(err || '未知错误');
  content.innerHTML = `<div class="module-head"><div><h2 class="m-title">${escapeHtml(TITLES[key] || '内容')}</h2>
    <p class="m-sub">加载遇到问题，已停止等待</p></div></div>
    <div class="card"><p class="book-sum">这个板块加载失败了：<b>${escapeHtml(msg)}</b></p>
    <p class="book-sum">通常是网络或数据源暂时不通。你可以点下面的按钮重试。</p>
    <button class="link-btn" id="retryBtn">重试</button></div>`;
  const btn = $('#retryBtn');
  if (btn) btn.onclick = () => renderModule(key);
  triggerFade();
}
function setActiveNav(key) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.key === key));
}

// ---------- 书籍推荐 ----------
async function renderBooks() {
  setContentLoading('书籍金句', '正在获取今日书籍金句…');
  await loadFavQuotes();
  const data = await loadBooks();
  state.books = data;
  if (!data || !data.books || !data.books.length) {
    content.innerHTML = `<div class="module-head"><div><h2 class="m-title">书籍金句</h2>
      <p class="m-sub">每日 07:00 自动更新</p></div></div>
      <p class="empty">暂无可读内容，点右上角「刷新」重新抓取</p>`;
    triggerFade(); return;
  }
  const srcLabel = data.source === 'douban' ? '豆瓣实时抓取' : '精选书库兜底';
  const ds = (data.dataSources || []).map(s =>
    `<a class="hot-src-chip" href="${escapeHtml(s.home)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`).join('');
  const quotes = (data.quotes || []).map(q => quoteCard(q, 'daily')).join('');
  const favCount = getFavQuotes().length;
  content.innerHTML = `
    <div class="module-head">
      <div><h2 class="m-title">书籍金句</h2>
      <p class="m-sub">${escapeHtml(data.date)} · 每日 07:00 自动更新 · 来源：${escapeHtml(srcLabel)}</p></div>
    </div>
    ${ds ? `<div class="hot-srcbar"><span class="hot-srcbar-label">数据源</span>${ds}</div>` : ''}
    <h3 class="sub-h">📖 今日两本新书 <span class="sub-note">（近 3 年内出版 · 高分）</span></h3>
    <div class="book-grid">${data.books.map(bookCard).join('')}</div>
    <h3 class="sub-h">💡 今日三句金句 <span class="sub-note">（点击右侧★收藏）</span></h3>
    <div class="quote-grid">${quotes}</div>
    <h3 class="sub-h">⭐ 我的名言收藏夹 <span class="fav-count" id="favCount">${favCount}</span></h3>
    <div id="favSection"></div>
    <p class="empty">封面来自豆瓣读书；「阅读链接」一键跳转豆瓣书籍页，可查看详情、试读与购买。</p>`;
  renderFavSection();
  triggerFade();
}
// 书籍卡片：封面(豆瓣图 + SVG 兜底) + 新书/经典徽章 + 评分 + 作者简介 + 内容梗概 + 阅读链接
function bookCard(b) {
  if (!b) return '';
  const badge = b.tag === 'new'
    ? '<span class="book-badge new">🆕 新书</span>'
    : '<span class="book-badge classic">📚 经典</span>';
  const cv = coverFor(b);
  const cover = `<div class="book-cover gen" data-bt="${escapeHtml(b.title)}">${svgCover(b)}${cv
    ? `<img class="cover-img" src="${escapeHtml(cv)}" alt="${escapeHtml(b.title)} 封面" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">`
    : ''}</div>`;
  const rating = b.rating ? `<span class="pill">★ ${b.rating}</span>` : '';
  const rc = b.ratingCount ? `<span class="pill">${formatCount(b.ratingCount)}人评价</span>` : '';
  const pub = b.pubDate ? `<span class="pill">${escapeHtml(b.pubDate)} 出版</span>` : '';
  const link = b.link ? `<a class="link-btn" href="${escapeHtml(b.link)}" target="_blank" rel="noopener">阅读链接 ↗</a>` : '';
  return `<div class="book-card">
    ${cover}
    <div class="book-head">${badge}<div class="book-title">${escapeHtml(b.title)}</div></div>
    <div class="book-author">${escapeHtml(b.author || '佚名')}</div>
    <div class="book-meta">${rating}${rc}${pub}</div>
    <div class="book-sum"><b>作者简介</b>　${escapeHtml(b.authorBio || '—')}</div>
    <div class="book-sum"><b>内容梗概</b>　${escapeHtml(b.summary || '—')}</div>
    ${link}
  </div>`;
}
// ---------- 名言收藏夹（后端持久化优先，无后端走 localStorage）----------
const QUOTE_FAV_KEY = 'dn_quote_favs';
// 进入模块时调用：有后端则从 /api/quotes/fav 拉取，否则读本地
async function loadFavQuotes() {
  if (state.backend) {
    try { const r = await api('/api/quotes/fav'); state.favQuotes = (r && Array.isArray(r.list)) ? r.list : []; }
    catch { state.favQuotes = []; }
  } else {
    state.favQuotes = getFavQuotesLocal();
  }
  return state.favQuotes;
}
function getFavQuotesLocal() {
  try { const a = JSON.parse(localStorage.getItem(QUOTE_FAV_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
// 当前收藏列表（内存缓存，渲染统一从此读取）
function getFavQuotes() { return state.favQuotes || []; }
function isFavQ(q) { return getFavQuotes().some(x => x.text === q.text); }
// 切换收藏：乐观更新内存，有后端则 POST 同步，无后端写 localStorage
async function toggleFavQ(q) {
  const favs = state.favQuotes.slice();
  const i = favs.findIndex(x => x.text === q.text);
  let nowFav;
  if (i >= 0) { favs.splice(i, 1); nowFav = false; } else { favs.unshift({ text: q.text, author: q.author, bio: q.bio, bg: q.bg }); nowFav = true; }
  state.favQuotes = favs;
  if (state.backend) {
    try {
      const r = await api('/api/quotes/fav', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q.text, author: q.author, bio: q.bio, bg: q.bg }) });
      if (r && Array.isArray(r.list)) state.favQuotes = r.list;
    } catch { /* 保留乐观值，下次进入模块时重载修正 */ }
  } else {
    localStorage.setItem(QUOTE_FAV_KEY, JSON.stringify(favs.slice(0, 200)));
  }
  return nowFav;
}
// 小星星图标（右侧收藏按钮）：实心=已收藏，描边=未收藏
function favStarSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M12 2.6l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.95 6.1 20.77l1.13-6.57L2.45 9.54l6.6-.96z"
      fill="${filled ? '#f5b301' : 'none'}" stroke="${filled ? '#f5b301' : '#9aa7b8'}" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}
async function toggleQuoteFav(btn) {
  const q = { text: btn.dataset.text, author: btn.dataset.author, bio: btn.dataset.bio, bg: btn.dataset.bg };
  const nowFav = await toggleFavQ(q);
  btn.classList.toggle('on', nowFav);
  btn.title = nowFav ? '取消收藏' : '收藏这句';
  btn.innerHTML = favStarSvg(nowFav);
  const c = document.getElementById('favCount'); if (c) c.textContent = state.favQuotes.length;
  renderFavSection();
}
function renderFavSection() {
  const el = document.getElementById('favSection');
  if (!el) return;
  const favs = getFavQuotes();
  if (!favs.length) {
    el.innerHTML = `<p class="empty fav-empty">还没有收藏的名言。点击任意金句右侧的小星星 ★，它就会出现在这里。</p>`;
    return;
  }
  el.innerHTML = `<div class="quote-grid">${favs.map(q => quoteCard(q, 'fav')).join('')}</div>`;
}
// 金句卡片：名言 + 名人 + 简介 + 背景 + 右侧收藏星（mode: 'daily' 今日金句 / 'fav' 收藏夹内）
function quoteCard(q, mode) {
  if (!q) return '';
  const fav = mode === 'fav' || isFavQ(q);
  const star = `<button class="fav-star ${fav ? 'on' : ''}" type="button" title="${fav ? '取消收藏' : '收藏这句'}"
    data-text="${escapeHtml(q.text)}" data-author="${escapeHtml(q.author)}" data-bio="${escapeHtml(q.bio || '')}" data-bg="${escapeHtml(q.bg || '')}">${favStarSvg(fav)}</button>`;
  return `<div class="quote-card ${mode === 'fav' ? 'fav' : ''}">
    <div class="quote-body">
      <div class="quote-mark">“</div>
      <div class="quote-text">${escapeHtml(q.text)}</div>
      <div class="quote-author">—— ${escapeHtml(q.author)}</div>
      <div class="quote-bio"><b>简介</b>　${escapeHtml(q.bio || '—')}</div>
      <div class="quote-bg"><b>背景</b>　${escapeHtml(q.bg || '—')}</div>
    </div>
    ${star}
  </div>`;
}
// 人数格式化（中文习惯：万）
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

// ---------- 书籍封面 ----------
// 策略：本地 SVG 生成封面兜底（零请求、100% 显示），再后台尝试真实封面并「验证可加载」后替换。
// 注意：豆瓣图床对第三方站点返回 403（防盗链），故不使用豆瓣拼接 URL。
const COVER_PALETTES = [
  ['#dbeafe', '#93c5fd', '#1e3a8a'], ['#e0f2fe', '#7dd3fc', '#0c4a6e'],
  ['#e0e7ff', '#a5b4fc', '#312e81'], ['#ccfbf1', '#5eead4', '#115e59'],
  ['#fce7f3', '#f9a8d4', '#831843'], ['#fef3c7', '#fcd34d', '#78350f'],
  ['#ede9fe', '#c4b5fd', '#4c1d95'], ['#dcfce7', '#86efac', '#14532d']
];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000; return h; }
function wrapTitle(t, per, max) {
  const s = String(t || '').trim(); const lines = [];
  for (let i = 0; i < s.length && lines.length < max; i += per) lines.push(s.slice(i, i + per));
  if (lines.length === max && s.length > per * max) lines[max - 1] = lines[max - 1].slice(0, per - 1) + '…';
  return lines;
}
// 生成书籍封面（内联 SVG，不发任何网络请求）
function svgCover(b) {
  const p = COVER_PALETTES[hashStr(b.title || '') % COVER_PALETTES.length];
  const lines = wrapTitle(b.title, 7, 4);
  const fs = lines.length >= 4 ? 25 : lines.length === 3 ? 28 : 31;
  const startY = 150 - ((lines.length - 1) * (fs + 8)) / 2;
  const gid = 'g' + hashStr(b.title || '');
  const titleSvg = lines.map((l, i) =>
    `<text x="168" y="${startY + i * (fs + 8)}" font-size="${fs}" font-weight="700" fill="${p[2]}" text-anchor="middle" font-family="system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">${escapeHtml(l)}</text>`
  ).join('');
  const author = escapeHtml(String(b.author || '').slice(0, 14));
  return `<svg class="cover-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeHtml(b.title)}封面">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p[0]}"/><stop offset="100%" stop-color="${p[1]}"/>
    </linearGradient></defs>
    <rect width="300" height="400" fill="url(#${gid})"/>
    <rect x="0" y="0" width="14" height="400" fill="${p[2]}" opacity="0.85"/>
    <circle cx="268" cy="358" r="52" fill="${p[2]}" opacity="0.07"/>
    <line x1="52" y1="72" x2="268" y2="72" stroke="${p[2]}" stroke-width="2" opacity="0.35"/>
    ${titleSvg}
    <line x1="110" y1="300" x2="230" y2="300" stroke="${p[2]}" stroke-width="1.5" opacity="0.3"/>
    <text x="168" y="326" font-size="16" fill="${p[2]}" opacity="0.75" text-anchor="middle" font-family="system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">${author}</text>
  </svg>`;
}
// 封面：种子已内置豆瓣真实封面 URL；直接采用，加载失败（防盗链等）时由下方 SVG 兜底露出。
// 不再过滤 doubanio —— 配合 referrerpolicy="no-referrer" 多数浏览器可正常加载。
function coverFor(b) {
  const u = b && b.cover;
  return /^https?:\/\//.test(u || '') ? u : '';
}

// ---------- 新闻 ----------
// 国内热点六大权威源（用于页头说明，与后端 hotnews.js 保持一致）
const HOT_SOURCE_LIST = [
  { name: '人民网', home: 'https://www.people.com.cn' },
  { name: '新华网', home: 'https://www.xinhuanet.com' },
  { name: '中国新闻网', home: 'https://www.chinanews.com' },
  { name: '中国经济网', home: 'https://www.ce.cn' },
  { name: '澎湃新闻', home: 'https://www.thepaper.cn' },
  { name: '网易新闻', home: 'https://news.163.com' }
];

async function renderNews(key) {
  setContentLoading(TITLES[key], '正在获取新闻…');
  const news = await loadNews();
  const cat = news.categories ? news.categories[key] : null;
  const items = (cat && cat.items) ? cat.items : [];
  // 国内/国际/医疗进展：按热度排序展示热度值 + 摘要（后端/种子已带 heat 字段）
  const isHot = ['domestic', 'world', 'medical'].includes(key) && items.some(it => Number(it.heat) > 0);
  if (isHot) return renderHotNews(cat, items);

  const label = key === 'ai' ? '查看原链接 / 教程 ↗' : '查看原链接 ↗';
  content.innerHTML = `
    <div class="module-head"><div><h2 class="m-title">${TITLES[key]}</h2>
    <p class="m-sub">每日 07:00 自动更新 · 已过滤广告与无效内容</p></div></div>
    <div class="news-list">
      ${items.length ? items.map(it => newsItem(it, label)).join('') : '<p class="empty">暂无可读内容，点右上角「刷新」重新抓取</p>'}
    </div>`;
  triggerFade();
}
function newsItem(it, label) {
  return `<div class="news-item">
    <a class="news-title" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
    <div class="news-sum">${escapeHtml(it.summary)}</div>
    <div class="news-foot">
      <span class="news-src">${escapeHtml(it.source)}${it.pub ? ' · ' + escapeHtml(it.pub) : ''}</span>
      <a class="link-btn" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${label}</a>
    </div>
  </div>`;
}

// ---------- 国内热点（热度排序视图）----------
function heatLevel(h) {
  if (h >= 85) return 'lv3';   // 沸
  if (h >= 75) return 'lv2';   // 热
  if (h >= 65) return 'lv1';   // 温
  return 'lv0';
}
function heatWord(h) {
  if (h >= 85) return '沸';
  if (h >= 75) return '热';
  if (h >= 65) return '温';
  return '平';
}
function renderHotNews(cat, items) {
  const srcList = (cat && cat.sourceList && cat.sourceList.length) ? cat.sourceList : HOT_SOURCE_LIST;
  const crossN = items.filter(it => Number(it.crossCount) > 1).length;
  content.innerHTML = `
    <div class="module-head">
      <div>
        <h2 class="m-title">${escapeHtml(cat && cat.title ? cat.title : '热点')}</h2>
        <p class="m-sub">按热度排序 · 多源交叉验证${crossN ? ' · 其中 ' + crossN + ' 条为多源同时报道' : ''}</p>
      </div>
    </div>
    <div class="hot-srcbar">
      <span class="hot-srcbar-label">数据源</span>
      ${srcList.map(s => `<a class="hot-src-chip" href="${escapeHtml(s.home)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`).join('')}
    </div>
    <div class="hot-list">
      ${items.length ? items.map((it, i) => hotItem(it, i + 1)).join('') : '<p class="empty">暂无可读内容，点右上角「刷新」重新抓取</p>'}
    </div>
    <p class="hot-tip">热度值综合：多源交叉报道数 · 媒体权威度 · 首页编辑排位 · 发布新鲜度 · 时政民生关键词 · 用户互动量</p>`;
  triggerFade();
}
function hotItem(it, no) {
  const h = Math.max(0, Math.min(99, Math.round(Number(it.heat) || 0)));
  const lv = heatLevel(h);
  const cross = Number(it.crossCount) || 1;
  const reports = Number(it.reportCount) || 1;
  const srcs = Array.isArray(it.sources) && it.sources.length ? it.sources : [it.source];
  const crossTag = cross > 1
    ? `<span class="hot-cross" title="${escapeHtml(srcs.join('、'))} 同时报道">${cross} 源交叉 · ${reports} 篇</span>`
    : '';
  return `<div class="hot-item ${lv}">
    <div class="hot-left">
      <div class="hot-no">${no}</div>
      <div class="heat-badge ${lv}">
        <span class="heat-num">${h}</span>
        <span class="heat-word">${heatWord(h)}</span>
      </div>
      <div class="heat-bar"><i style="height:${h}%"></i></div>
    </div>
    <div class="hot-body">
      <a class="hot-title" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
      <div class="hot-sum">${escapeHtml(it.summary || '')}</div>
      <div class="hot-foot">
        <span class="hot-meta">${escapeHtml(srcs.join(' · '))}${crossTag ? '' : ''}</span>
        ${crossTag}
        <a class="link-btn hot-link" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">查看原链接 ↗</a>
      </div>
    </div>
  </div>`;
}

// ---------- 英语积累 ----------
async function renderEnglish() {
  const mode = state.englishMode;
  setContentLoading('英语积累', '正在获取英语养分…');
  const data = await loadEnglish();
  state.english = data;
  if (mode === 'history') {
    content.innerHTML = `
      <div class="module-head"><div><h2 class="m-title">英语积累</h2><p class="m-sub">历史每日</p></div>
      <button class="seg" id="engToggle">← 返回今日</button></div>
      ${data.history.map(historyDayEnglish).join('')}`;
    $('#engToggle').onclick = () => { state.englishMode = 'daily'; renderEnglish(); };
    triggerFade();
    return;
  }
  const n = data.news || {};
  const isSpeech = n.type === 'speech';
  const paras = (n.content && n.content.length) ? n.content : [n.summary].filter(Boolean);
  const coverHtml = (isSpeech && n.cover)
    ? `<img class="eng-cover" src="${escapeHtml(n.cover)}" alt="cover" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>`
    : '';
  const linkHref = escapeHtml(isSpeech ? (n.videoLink || n.link || '#') : (n.link || '#'));
  const linkLabel = isSpeech ? '🎬 观看演讲 ↗' : '查看原链接 ↗';
  content.innerHTML = `
    <div class="module-head"><div><h2 class="m-title">英语积累</h2>
    <p class="m-sub">${data.date} · 每日 07:00 更新</p></div>
    <button class="seg" id="engToggle">累积回溯</button></div>
    <div class="card eng-news">
      <div class="eng-news-head"><span class="tag">${isSpeech ? '英语演讲' : '英语新闻'}</span>
        <span class="eng-src">${escapeHtml(n.source || '')}</span></div>
      ${coverHtml}
      <div class="eng-news-title">${escapeHtml(n.title || '')}</div>
      ${n.summary ? `<div class="eng-news-sum">${escapeHtml(n.summary)}</div>` : ''}
      <div class="eng-controls">
        <button class="mini-btn" id="engPlay">🔊 ${isSpeech ? '跟读' : '朗读全文'}</button>
        <button class="mini-btn" id="engStop">⏹ 停止</button>
        <button class="mini-btn" id="engTrans">🌐 翻译</button>
      </div>
      <div class="eng-content">${paras.map((p, k) => `<p class="eng-para" data-i="${k}">${escapeHtml(p)}</p>`).join('')}</div>
      <a class="link-btn" href="${linkHref}" target="_blank" rel="noopener">${linkLabel}</a>
      ${dataSourcesHtml(n)}
    </div>
    <h3 class="sub-h">今日地道口语 · ${data.oral.length} 句</h3>
    <div class="oral-list">${data.oral.map((o, i) => oralItem(o, i)).join('')}</div>`;
  $('#engToggle').onclick = () => { state.englishMode = 'history'; renderEnglish(); };
  $('#engPlay').onclick = () => speakParagraphs(paras);
  $('#engStop').onclick = () => stopSpeak();
  $('#engTrans').onclick = async () => {
    const btn = $('#engTrans');
    if (btn.dataset.on === '1') {
      content.querySelectorAll('.eng-para-zh').forEach(e => e.remove());
      btn.dataset.on = '0'; btn.textContent = '🌐 翻译';
      return;
    }
    btn.dataset.on = '1'; btn.textContent = '🌐 隐藏翻译';
    for (const el of content.querySelectorAll('.eng-para')) {
      const k = Number(el.dataset.i);
      if (el.nextElementSibling && el.nextElementSibling.classList.contains('eng-para-zh')) continue;
      const zhEl = document.createElement('div');
      zhEl.className = 'eng-para-zh';
      zhEl.textContent = '翻译中…';
      el.after(zhEl);
      zhEl.textContent = await translate(paras[k]);
    }
  };
  content.querySelectorAll('.eng-para').forEach(el => {
    el.onclick = () => speakOne(Number(el.dataset.i), paras[Number(el.dataset.i)]);
  });
  bindEnglish();
  triggerFade();
}
function oralItem(o, i) {
  return `<div class="oral-item">
    <div class="oral-en" data-i="${i}">${escapeHtml(o.en)}</div>
    <div class="oral-zh">${escapeHtml(o.zh)}</div>
    <div class="oral-actions">
      <button class="mini-btn" data-act="speak" data-i="${i}">🔊 朗读</button>
      <button class="mini-btn" data-act="trans" data-i="${i}">翻译</button>
    </div>
    <div class="oral-trans hidden" id="oralTrans${i}"></div>
  </div>`;
}
function historyDayEnglish(h) {
  const n = h.news || {};
  const isSpeech = n.type === 'speech';
  const paras = (n.content && n.content.length) ? n.content : [n.summary].filter(Boolean);
  const preview = paras.slice(0, 2).map(p => `<p class="eng-para">${escapeHtml(p)}</p>`).join('');
  const link = isSpeech ? (n.videoLink || n.link) : n.link;
  return `<div class="history-day"><div class="history-date">${h.date}</div>
    <div class="card eng-news">
      <div class="eng-news-head"><span class="tag">${isSpeech ? '英语演讲' : '英语新闻'}</span><span class="eng-src">${escapeHtml(n.source || '')}</span></div>
      <div class="eng-news-title">${escapeHtml(n.title || '')}</div>
      ${n.summary ? `<div class="eng-news-sum">${escapeHtml(n.summary)}</div>` : ''}
      <div class="eng-content">${preview}</div>
      ${link ? `<a class="link-btn" href="${escapeHtml(link)}" target="_blank" rel="noopener">${isSpeech ? '🎬 观看演讲 ↗' : '查看原链接 ↗'}</a>` : ''}
    </div>
    <div class="oral-list">${h.oral.map((o, i) => oralItem(o, i)).join('')}</div>
  </div>`;
}
function bindEnglish() {
  content.querySelectorAll('[data-act="speak"]').forEach(b => b.onclick = () => speak(state.english.oral[b.dataset.i].en, 'en-US'));
  content.querySelectorAll('[data-act="trans"]').forEach(b => b.onclick = async () => {
    const i = b.dataset.i; const el = $('#oralTrans' + i);
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
    el.textContent = '翻译中…'; el.classList.remove('hidden');
    el.textContent = await translate(state.english.oral[i].en);
  });
}

// ---------- 语音 / 翻译 ----------
function speak(text, lang = 'en-US') {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
  if (!text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang; u.rate = 0.95; u.pitch = 1;
  window.speechSynthesis.speak(u);
}

// 逐段跟读：顺序朗读并高亮当前段落
let engAbort = false;
function clearSpeaking() {
  content.querySelectorAll('.eng-para.speaking').forEach(e => e.classList.remove('speaking'));
}
function stopSpeak() {
  engAbort = true;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  clearSpeaking();
}
function speakParagraphs(paras, lang = 'en-US') {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
  if (!paras || !paras.length) return;
  window.speechSynthesis.cancel();
  engAbort = false;
  let k = 0;
  const step = () => {
    if (engAbort || k >= paras.length) { clearSpeaking(); return; }
    const el = content.querySelector('.eng-para[data-i="' + k + '"]');
    if (el) { el.classList.add('speaking'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    const u = new SpeechSynthesisUtterance(paras[k]);
    u.lang = lang; u.rate = 0.92; u.pitch = 1;
    u.onend = () => { if (el) el.classList.remove('speaking'); k++; step(); };
    u.onerror = () => { if (el) el.classList.remove('speaking'); k++; step(); };
    window.speechSynthesis.speak(u);
  };
  step();
}
function speakOne(i, text, lang = 'en-US') {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
  engAbort = true; window.speechSynthesis.cancel(); clearSpeaking();
  const el = content.querySelector('.eng-para[data-i="' + i + '"]');
  if (el) el.classList.add('speaking');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang; u.rate = 0.92; u.pitch = 1;
  u.onend = () => { if (el) el.classList.remove('speaking'); };
  window.speechSynthesis.speak(u);
}

// 翻译：长文分块 + localStorage 缓存，避免重复请求
function loadTransCache() { try { return JSON.parse(localStorage.getItem('dn_trans') || '{}'); } catch { return {}; } }
const _transCache = loadTransCache();
function chunkText(text, max = 450) {
  if (text.length <= max) return [text];
  const parts = []; let cur = '';
  for (const w of text.split(/(\s+)/)) {
    if (cur.length + w.length > max && cur.trim()) { parts.push(cur.trim()); cur = ''; }
    cur += w;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [text];
}
async function translate(text) {
  if (!text) return '';
  if (_transCache[text]) return _transCache[text];
  try {
    const chunks = chunkText(text);
    let out = '';
    for (const c of chunks) {
      const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(c) + '&langpair=en|zh-CN');
      const j = await r.json();
      out += (j && j.responseData && j.responseData.translatedText) ? j.responseData.translatedText : '';
    }
    out = out.trim() || '（翻译暂不可用）';
    _transCache[text] = out;
    try { localStorage.setItem('dn_trans', JSON.stringify(_transCache)); } catch {}
    return out;
  } catch { return '（翻译失败，请检查网络）'; }
}
function dataSourcesHtml(n) {
  const ds = n.dataSources;
  if (!ds || !ds.length) return '';
  const items = ds.map(s => `<span class="ds${s.listOnly ? ' ds-off' : ''}">${escapeHtml(s.name)}${s.listOnly ? ' · 源不可达' : ''}</span>`).join('');
  return `<div class="eng-sources">数据源：${items}</div>`;
}

// ---------- 感悟灵感 ----------
async function renderInsights() {
  setContentLoading('感悟灵感', '');
  const list = await loadInsights();
  state.insights = list;
  content.innerHTML = `
    <div class="module-head"><div><h2 class="m-title">感悟灵感</h2>
    <p class="m-sub">${todayStr()} · 随时记录你的新想法${state.backend ? '' : '（本机浏览器保存）'}</p></div></div>
    <div class="card ins-input">
      <textarea id="insText" class="ins-area" placeholder="此刻有什么灵感？写下一句话、一个想法…（最多 2000 字）" maxlength="2000"></textarea>
      <div class="ins-actions">
        <label class="file-btn">📷 图片<input type="file" id="insImg" accept="image/*" hidden></label>
        <span class="img-hint" id="imgHint"></span>
        <button class="btn" id="saveIns">保存灵感</button>
      </div>
    </div>
    <h3 class="sub-h">历史灵感（${list.length}）</h3>
    <div class="ins-list">
      ${list.length ? list.map(insItem).join('') : '<p class="empty">还没有灵感，记下第一条吧～</p>'}
    </div>`;
  let imgData = '';
  $('#insImg').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    imgData = await compressImage(f);
    $('#imgHint').textContent = imgData ? '已选图片 ✓' : '图片读取失败';
  };
  $('#saveIns').onclick = async () => {
    const text = $('#insText').value.trim();
    if (!text && !imgData) { toast('写点什么，或选一张图'); return; }
    const res = await saveInsight(text, imgData);
    state.insights = res;
    $('#insText').value = ''; imgData = ''; $('#imgHint').textContent = '';
    renderInsights(); toast('灵感已保存');
  };
  content.querySelectorAll('.ins-del').forEach(b => b.onclick = async () => {
    state.insights = await delInsight(b.dataset.id);
    renderInsights();
  });
  triggerFade();
}
function insItem(it) {
  return `<div class="ins-item">
    <button class="ins-del" data-id="${it.id}">删除</button>
    <div class="ins-date">${escapeHtml(it.date)}${it.ts ? ' ' + escapeHtml(it.ts.slice(11, 16)) : ''}</div>
    ${it.text ? `<div class="ins-text">${escapeHtml(it.text)}</div>` : ''}
    ${it.image ? `<img class="ins-img" src="${it.image}" alt="灵感图片"/>` : ''}
  </div>`;
}
function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 800; let w = img.width, h = img.height;
        if (w > max) { h = Math.round(h * max / w); w = max; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL('image/jpeg', 0.8)); } catch { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = reader.result;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

// ---------- 加载占位 ----------
function setContentLoading(title, sub) {
  $('#moduleTitle').textContent = title;
  content.innerHTML = `<div class="module-head"><div><h2 class="m-title">${escapeHtml(title)}</h2>
    <p class="m-sub">${escapeHtml(sub)}</p></div></div><p class="empty">加载中…</p>`;
}

// ---------- 推送横幅 + SSE（仅后端模式）----------
function showBanner(p) {
  const b = $('#pushBanner');
  const books = (p.books && p.books.length) ? p.books.join('\n') : '（暂无）';
  b.innerHTML = `<span class="pb-close" id="pbClose">✕</span>
    <div class="pb-title">📬 今日养分 · ${escapeHtml(p.time)}（${escapeHtml(p.reason)}）</div>
    <pre>📚 书籍金句：\n${escapeHtml(books)}
📰 新闻 ${p.newsCount || 0} 条
🗣 英语新闻：${escapeHtml(p.english || '—')} ｜ 口语 ${p.oralCount || 0} 句
💡 感悟已积累 ${p.insightsCount || 0} 条

${escapeHtml(p.newsText || '')}</pre>`;
  b.classList.remove('hidden');
  $('#pbClose').onclick = () => b.classList.add('hidden');
}
function onPush(p) {
  showBanner(p);
  toast('收到今日养分推送');
  renderModule(state.current);
}
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('push', (e) => { try { onPush(JSON.parse(e.data)); } catch {} });
  es.onerror = () => { /* 自动重连 */ };
}

// ---------- 设置（仅后端模式有效）----------
async function openSettings() {
  if (!state.backend) { toast('独立模式无后端，无法设置定时推送'); return; }
  const s = await api('/api/settings');
  $('#pushEnabled').checked = !!s.pushEnabled;
  $('#pushTime').value = s.pushTime || '07:00';
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const { log } = await api('/api/pushlog');
  const ul = $('#pushLogList');
  ul.innerHTML = '';
  (log || []).slice(0, 15).forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(p.time)}</b> · ${escapeHtml(p.reason)}<br>书籍 ${p.bookCount || 0} · 新闻 ${p.newsCount || 0} · 口语 ${p.oralCount || 0}`;
    ul.appendChild(li);
  });
  $('#settingsModal').classList.remove('hidden');
}

// ---------- 事件绑定 ----------
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => {
  state.current = b.dataset.key; renderModule(state.current); closeDrawer();
}));
$('#refreshBtn').addEventListener('click', async () => {
  $('#refreshBtn').textContent = '刷新中…';
  try {
    if (state.backend) {
      api('/api/news/refresh'); api('/api/books/refresh?mode=' + state.booksMode); api('/api/english/refresh?mode=' + state.englishMode);
      await renderModule(state.current);
      toast('已触发今日养分刷新');
    } else {
      // 独立模式：清掉今日缓存并强制后台重新抓取
      const today = todayKey();
      ['dn_news_', 'dn_books_', 'dn_eng_'].forEach(p => { try { localStorage.removeItem(p + today); } catch {} });
      newsUpgrading = engUpgrading = false;
      await renderModule(state.current);
      toast('已重新抓取，成功会自动刷新');
    }
  } catch (e) { toast('刷新失败：' + (e && e.message ? e.message : '未知错误')); }
  $('#refreshBtn').textContent = '↻ 刷新';
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('#settingsModal').classList.add('hidden'); });
$('#saveSettings').addEventListener('click', async () => {
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pushEnabled: $('#pushEnabled').checked, pushTime: $('#pushTime').value }) });
  toast('设置已保存');
});
$('#testPush').addEventListener('click', async () => {
  const r = await api('/api/push/now', { method: 'POST' });
  if (r.ok) toast('已触发测试推送');
});
function openDrawer() { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show'); }
function closeDrawer() { $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('show'); }
$('#menuToggle').addEventListener('click', openDrawer);
$('#overlay').addEventListener('click', closeDrawer);

// ---------- PWA 注册 ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

// ---------- 初始化 ----------
async function init() {
  $('#todayDate').textContent = todayStr();
  // 种子数据：校验必须是合法对象，避免静态托管回退 HTML 导致解析异常
  try {
    const r = await fetch('seed.json', { headers: { Accept: 'application/json' } });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const j = (r.ok && (ct.includes('json') || ct.includes('text/plain'))) ? await r.json() : null;
    state.seed = (j && typeof j === 'object' && (j.books || j.news)) ? j : null;
  } catch { state.seed = null; }
  await detectBackend();
  try { state.insights = await loadInsights(); } catch { state.insights = []; }
  await renderModule('books');
  // 事件委托：收藏星星按钮（模块作用域下内联 onclick 不可见，统一在此代理）
  content.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-star');
    if (btn) { e.preventDefault(); toggleQuoteFav(btn); }
  });
  if (state.backend) {
    try {
      const { log } = await api('/api/pushlog');
      if (log && log.length && log[0].time && log[0].time.startsWith(new Date().toLocaleDateString('zh-CN'))) showBanner(log[0]);
    } catch {}
    connectSSE();
  }
}
init();
