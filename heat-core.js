// 国内热点 · 纯算法核心（前后端共享的唯一实现，不含任何网络请求）
// 后端 server/hotnews.js 与 前端 public/app.js 都从这里 import，
// 保证「有后端」和「静态部署」两种模式下的热度算法完全一致，不会分叉。
//
// 职责：文本清洗 → 源定义 → 列表解析 → 事件聚类 → 热度计分 → 摘要提取
// 网络抓取（fetch / 代理 / 超时）由各自的调用方实现。

// ============ 文本清洗 ============
export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    // 各类空白实体（新华网/人民网正文常见 &emsp; 缩进）
    .replace(/&(nbsp|emsp|ensp|thinsp|#160);/g, ' ')
    .replace(/&(mdash|ndash);/g, '—')
    .replace(/&(ldquo|rdquo);/g, '"').replace(/&(lsquo|rsquo);/g, "'")
    .replace(/&hellip;/g, '…').replace(/&middot;/g, '·')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    })
    .replace(/&amp;/g, '&');
}

export function stripHtml(s) {
  return decodeEntities(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function clip(t, max = 120) {
  const s = stripHtml(t).replace(/https?:\/\/\S+/g, '').trim();
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

// ============ 六大权威源 ============
// authority = 权威度权重；linkRe 用于从首页 HTML 里筛出「正文详情页」链接
export const HOT_SOURCES = [
  // 人民网 RSS(politics.xml) 已停更（仍返回数月前旧条目），改用首页实时抓取
  { key: 'people', name: '人民网', home: 'https://www.people.com.cn', authority: 1.00, type: 'html',
    url: 'http://www.people.com.cn/',
    linkRe: /people\.com\.cn\/n1\/20\d{2}\/\d{4}\/c\d+-\d+\.html/i },
  // 新华网 news_politics.xml 同样停更，改抓 news.cn 首页
  { key: 'xinhua', name: '新华网', home: 'https://www.xinhuanet.com', authority: 1.00, type: 'html',
    url: 'https://www.news.cn/',
    linkRe: /^https?:\/\/(www\.)?news\.cn\/[a-z]+\/[a-z0-9/]*20\d{6}\/[0-9a-f]{6,}/i },
  { key: 'chinanews', name: '中国新闻网', home: 'https://www.chinanews.com', authority: 0.90, type: 'rss',
    url: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
  { key: 'ce', name: '中国经济网', home: 'https://www.ce.cn', authority: 0.85, type: 'html',
    url: 'https://www.ce.cn/xwzx/gnsz/gdxw/',
    linkRe: /^https?:\/\/[a-z.]*ce\.cn\/.*\/20\d{4}\/t20\d{6}_\d+\.s?html?$/i },
  { key: 'thepaper', name: '澎湃新闻', home: 'https://www.thepaper.cn', authority: 0.80, type: 'html',
    url: 'https://www.thepaper.cn/channel_25950',
    linkRe: /newsDetail_forward_\d+/ },
  // 网易首页热榜 JSONP，附带评论数（真实用户互动信号）
  { key: 'netease', name: '网易新闻', home: 'https://news.163.com', authority: 0.75, type: 'netease',
    url: 'https://news.163.com/special/0001220O/news_json.js' }
];

// ============ 国际热点 · 12 家权威源 ============
// 说明：路透/美联社/BBC/经济学人/今日美国 在此类网络环境下常被墙或返回 403，抓取失败时自动跳过
// （贡献 0 条），但仍列在「数据源」标签条里，尊重用户指定的权威源清单。其余 8 家为实际数据来源。
// latin:true 的源标题以英文为主（事件聚类与标题过滤走英文词级逻辑，避免把英文标题当成无效）。
export const WORLD_SOURCES = [
  { key: 'xinhua_w', name: '新华网', home: 'https://www.xinhuanet.com', authority: 1.00, type: 'html',
    url: 'https://www.news.cn/world/',
    linkRe: /news\.cn\/world\/20\d{6}\/[0-9a-f]{12,}\/c\.html/i },
  { key: 'chinadaily', name: '中国日报网', home: 'https://www.chinadaily.com.cn', authority: 0.95, type: 'html', latin: true,
    url: 'https://www.chinadaily.com.cn/world/',
    linkRe: /chinadaily\.com\.cn\/a\/20\d{4}\/\d{2}\/WS[0-9a-f]+\.html/i },
  { key: 'haiwainet', name: '海外网', home: 'https://www.haiwainet.cn', authority: 0.92, type: 'html',
    url: 'https://www.haiwainet.cn/',
    linkRe: /news\.haiwainet\.cn\/n\/20\d{2}\/\d{4}\/c\d+-?\d*\.html/i },
  { key: 'cri', name: '国际在线', home: 'https://www.cri.cn', authority: 0.92, type: 'html',
    url: 'https://www.cri.cn/',
    linkRe: /news\.cri\.cn\/20\d{6}\/[0-9a-f-]{20,}\.html/i },
  { key: 'chinanews_w', name: '中国新闻网', home: 'https://www.chinanews.com', authority: 0.90, type: 'rss',
    url: 'https://www.chinanews.com.cn/rss/world.xml' },
  { key: 'cgtn', name: 'CGTN', home: 'https://www.cgtn.com', authority: 0.90, type: 'html', latin: true,
    url: 'https://www.cgtn.com/',
    linkRe: /news\.cgtn\.com\/news\/2026-\d{2}-\d{2}\/[A-Za-z0-9-]+/i },
  { key: 'reuters', name: '路透社', home: 'https://www.reuters.com', authority: 0.95, type: 'html', latin: true,
    url: 'https://www.reuters.com/world/',
    linkRe: /reuters\.com\/world\/[a-z0-9/-]+/i },
  { key: 'ap', name: '美联社', home: 'https://apnews.com', authority: 0.95, type: 'html', latin: true,
    url: 'https://apnews.com/',
    linkRe: /apnews\.com\/article\//i },
  { key: 'bbc', name: 'BBC新闻', home: 'https://www.bbc.com/news', authority: 0.95, type: 'rss', latin: true,
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { key: 'economist', name: '经济学人', home: 'https://www.economist.com', authority: 0.90, type: 'rss', latin: true,
    url: 'https://www.economist.com/latest/rss.xml' },
  { key: 'npr', name: 'NPR', home: 'https://www.npr.org', authority: 0.85, type: 'rss', latin: true,
    url: 'https://feeds.npr.org/1004/rss.xml' },
  { key: 'usatoday', name: '今日美国', home: 'https://www.usatoday.com', authority: 0.80, type: 'rss', latin: true,
    url: 'https://rssfeeds.usatoday.com/usatoday-News' }
];

export const PER_SOURCE = 24;  // 每源候选条数：池子越大，跨源同事件命中率越高
export const TOP_N = 10;

// ============ 医疗进展 · 数据源 ============
// 用户指定 12 家权威源。其中 NHC/NMPA/gov.cn/niha/SinoMed/Web of Science/MedPage Today
// 在当前网络环境下被反爬/登录墙/JS 壳拦截，抓取返回 0 条；以 listOnly 仅列于「数据源」条，
// 尊重用户指定的权威源清单（与国际热点处理被墙源一致）。
// 实际可达并参与热度计算：NHSA 医保局、CMA 中华医学会、健康报、新华网健康（补充可达源）。
export const MEDICAL_SOURCES = [
  // 实际可达并参与热度计算的权威源（静态 HTML 可解析列表页，内容确为医疗健康）
  { key: 'news_health', name: '新华网·健康', home: 'https://www.news.cn/health/', authority: 0.95, type: 'html',
    url: 'https://www.news.cn/health/', linkRe: /\/health\/20\d{6}\/[0-9a-f]{16,}\/c\.html/ },
  { key: 'cctv_health', name: '央视网·健康', home: 'https://jiankang.cctv.com', authority: 0.95, type: 'html',
    url: 'https://jiankang.cctv.com/', linkRe: /jiankang\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/ARTI[^\s?]+\.shtml/i },
  { key: 'chinacdc', name: '中国疾控中心', home: 'https://www.chinacdc.cn', authority: 0.95, type: 'html',
    url: 'https://www.chinacdc.cn/', linkRe: /chinacdc\.cn\/[^\s"']*\/t20\d{6}_\d+\.html/i },
  // 以下为用户指定、首页为 JS 渲染(SPA)或当前网络不可达，静态解析取不到正文链接，
  // 仅列于「数据源」条（listOnly 不参与抓取），尊重用户指定的权威源清单。
  { key: 'nhsa', name: '国家医疗保障局', home: 'https://www.nhsa.gov.cn', authority: 1.00, type: 'html', listOnly: true, url: 'https://www.nhsa.gov.cn/' },
  { key: 'cma', name: '中华医学会', home: 'https://www.cma.org.cn', authority: 0.95, type: 'html', listOnly: true, url: 'https://www.cma.org.cn/' },
  { key: 'jkb', name: '健康报', home: 'https://www.jkb.com.cn', authority: 0.85, type: 'html', listOnly: true, url: 'https://www.jkb.com.cn/' },
  { key: 'nhc', name: '国家卫生健康委员会', home: 'https://www.nhc.gov.cn', authority: 1.00, type: 'html', listOnly: true, url: 'https://www.nhc.gov.cn/' },
  { key: 'nmpa', name: '国家药品监督管理局', home: 'https://www.nmpa.gov.cn', authority: 1.00, type: 'html', listOnly: true, url: 'https://www.nmpa.gov.cn/' },
  { key: 'gov', name: '中国政府网', home: 'https://www.gov.cn', authority: 1.00, type: 'html', listOnly: true, url: 'https://www.gov.cn/xinwen/' },
  { key: 'niha', name: '国家卫健委医院管理研究所', home: 'https://www.niha.org.cn', authority: 0.85, type: 'html', listOnly: true, url: 'https://www.niha.org.cn/' },
  { key: 'sinomed', name: 'SinoMed 中国生物医学文献', home: 'https://www.sinomed.ac.cn', authority: 0.80, type: 'html', listOnly: true, url: 'https://www.sinomed.ac.cn/' },
  { key: 'wos', name: 'Web of Science', home: 'https://www.webofscience.com', authority: 0.90, type: 'html', latin: true, listOnly: true, url: 'https://www.webofscience.com/' },
  { key: 'medpagetoday', name: 'MedPage Today', home: 'https://www.medpagetoday.com', authority: 0.85, type: 'html', latin: true, listOnly: true, url: 'https://www.medpagetoday.com/' }
];

// 医疗领域关键词加权（与通用时政/民生关键词合并后用于医疗类目热度）
const MEDICAL_KEYWORDS = {
  3.0: ['医保', '集采', '药品', '疫苗', '临床', '诊疗', '罕见病', '肿瘤', '癌症', '传染病', '疫情', '疾控',
        '中医药', '审评', '公立医疗', '分级诊疗', '创新药', '生物制药', '医保目录', '基药'],
  2.5: ['医院', '医生', '护士', '患者', '处方', '卫健委', '药监局', '健康中国', '公共卫生', '医疗器械',
        '医疗机构', '医联体', '互联网医疗', '药典', '仿制药', '原研药'],
  2.2: ['健康', '养生', '营养', '体重管理', '心理健康', '急救', '手术', '住院', '门诊', '挂号',
        'AI医疗', '智慧医院', '康复', '慢病', '登革热', '基孔肯雅热', '疟疾']
};

// 广告 / 营销关键词
export const AD_KEYWORDS = [
  '广告', '推广', '赞助', '招商', '加盟', '代运营', '点击下载', '扫码关注',
  '优惠券', '限时特惠', '返利', '领红包', '下载APP', '免费领取', '立即注册',
  'sponsored', 'advertisement', 'promoted'
];
export function isAd(title = '', summary = '') {
  const hay = (title + ' ' + summary).toLowerCase();
  return AD_KEYWORDS.some(k => hay.includes(k.toLowerCase()));
}

// 无效标题过滤（导航项、栏目名、广告位）——中英文通用
const JUNK_TITLE = /^(更多|详情|点击|查看|首页|登录|注册|下载|客户端|图片|视频|专题|排行|评论|返回|上一页|下一页|滚动|新闻中心|网站地图|More|Read|Video|Photo|Live|Home|Login|Watch|Listen)/i;
// 英文停用词（事件聚类/实体提取时剔除，避免 "the/and" 之类噪声词误合）
const STOP_EN = new Set(['the','and','for','with','from','that','this','will','have','after','over','into','their','they','were','been','being','news','world','said','says','amid','about','would','could','should','when','what','which','while','where','there','here','more','most','some','also','each','out','its','his','her','you','your','our','are','was','has','had','but','not','all','can','who','why','how','new']);
export function validTitle(t, latin = false) {
  if (!t || t.length < 8 || t.length > 95) return false;
  if (JUNK_TITLE.test(t)) return false;
  if (/[\u4e00-\u9fff]{4,}/.test(t)) return true;   // 含 4 连续汉字（纯中文或中英混合标题）
  if (latin) {
    const words = t.split(/[^A-Za-z0-9''-]+/).filter(w => w.length >= 3);
    if (words.length >= 4 && /[A-Za-z]/.test(t)) return true;
    // 也接受「少量英文 + 标点」的短英文标题
    if (/[A-Za-z]{8,}/.test(t) && t.replace(/[^A-Za-z]/g, '').length >= 12) return true;
  }
  return false;
}

// ============ 热点关键词加权 ============
const HOT_KEYWORDS = {
  3.0: ['习近平', '国务院', '中共中央', '政治局', '党中央', '国家主席', '总理'],
  2.2: ['政策', '发布', '部署', '会议', '改革', '通知', '意见', '规划', '通报', '决定', '出台'],
  // 民生强相关
  2.5: ['医保', '社保', '养老', '退休', '工资', '就业', '房价', '楼市', '教育', '高考',
        '物价', '菜价', '补贴', '减税', '公积金', '生育', '育儿', '看病', '药价'],
  // 突发/灾害（天然高热）
  2.8: ['台风', '暴雨', '地震', '洪水', '暴雪', '事故', '爆炸', '失联', '救援', '疫情', '预警'],
  1.6: ['GDP', '经济', '股市', 'A股', '降息', '降准', '消费', '出口', '进口', '央行', '楼盘']
};
// 国际热点额外加权（与国内热点合并后用于 world 类目）
const HOT_KEYWORDS_INTL = {
  3.0: ['war', '战争', '冲突', '开战', '袭击', '爆炸', '恐袭', '核', '导弹', '制裁', '停火', '入侵', '宣战'],
  2.8: ['地震', '海啸', '台风', '飓风', '洪水', '灾难', '坠机', '疫情', '饥荒', 'wildfire', 'earthquake', 'hurricane', 'tsunami', 'quarantine'],
  2.5: ['election', '选举', '总统', 'prime minister', '总理', 'summit', '峰会', '会谈', '访问', '协议', '签署', '联合国', '北约', '欧盟', '上合', 'G7', 'G20', '条约', '联合声明', 'ceasefire'],
  2.2: ['tariff', '关税', '贸易', '央行', '降息', '加息', '股市', '通胀', 'inflation', 'gdp', '经济', '罢工', '抗议', '示威', 'sanction', 'sanctions', 'protest', 'recession'],
  1.6: ['climate', '气候', '奥运', '世界杯', '科技', '芯片', 'space', '航天', 'ai', 'genocide', 'coup', 'referendum']
};
// 按权重键合并多组关键词（同权重数组拼接，而非覆盖）
function mergeKw(...maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] || []).concat(v);
  return out;
}
const KW_INTL = mergeKw(HOT_KEYWORDS, HOT_KEYWORDS_INTL);
// 医疗类目关键词（HOT_KEYWORDS 在上方定义后才可合并，避免 TDZ）
const KW_MEDICAL = mergeKw(HOT_KEYWORDS, MEDICAL_KEYWORDS);
export function keywordScore(title, summary = '', intl = false, medical = false) {
  const hay = (title + ' ' + summary).toLowerCase();
  const map = intl ? KW_INTL : (medical ? KW_MEDICAL : HOT_KEYWORDS);
  let s = 0;
  for (const [w, words] of Object.entries(map)) {
    for (const k of words) {
      if (hay.includes(k.toLowerCase())) { s += Number(w); break; } // 同组只计一次，避免堆叠
    }
  }
  return Math.min(s, 10);
}

// ============ 事件相似度 ============
// 中文无空格分词，用 2-gram 集合交集衡量重合度
function grams(title) {
  const t = String(title).replace(/[\s\p{P}]/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
function hasCJK(s) { return /[\u4e00-\u9fff]/.test(s); }
// 英文标题：拆成词（去停用词），用于词级 Jaccard 相似度
function latinTokens(s) {
  return new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [])
    .filter(w => w.length >= 3 && !STOP_EN.has(w)));
}
function latinSim(a, b) {
  const wa = latinTokens(a), wb = latinTokens(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0; for (const x of wa) if (wb.has(x)) inter++;
  return inter / Math.min(wa.size, wb.size);
}
export function similar(a, b) {
  const aCJK = hasCJK(a), bCJK = hasCJK(b);
  if (aCJK && bCJK) {
    const ga = grams(a), gb = grams(b);
    if (ga.size < 2 || gb.size < 2) return 0;
    let inter = 0; for (const x of ga) if (gb.has(x)) inter++;
    return inter / Math.min(ga.size, gb.size);
  }
  if (!aCJK && !bCJK) return latinSim(a, b);
  // 混合（中+英）：用拉丁专名词交集，中文标题里的英文专名也能命中
  return latinSim(a, b);
}

// 泛用词不作为实体（否则会把无关新闻错误聚合）
const STOP_ENTITY = new Set([
  '中国', '我国', '全国', '国家', '人民', '记者', '新闻', '报道', '今天', '昨天', '发布',
  '表示', '指出', '进行', '工作', '有关', '重要', '相关', '这个', '我们', '他们',
  '新华社', '中新网', '人民网', '央视', '目前', '近日', '日前', '以上', '其中',
  // 公文/外交标题的通用结构片段：不加入会把「核安保伙伴关系宣言」
  // 和「中埃深化全面战略伙伴关系联合声明」误判为同一事件
  '伙伴关', '伴关系', '关系的', '合作的', '发展的', '建设的', '联合声', '合声明',
  '的宣言', '的声明', '的通知', '的意见', '的决定', '的方案', '的通报', '的公告',
  '进一步', '高质量', '现代化', '新时代', '重要讲', '要讲话', '有关部', '关部门'
]);

// 核心实体：引号/书名号内专名 + 中文 3-gram 滑窗（中文）或英文实词（英文）
function entities(title) {
  const set = new Set();
  const t = String(title);
  for (const m of t.matchAll(/[“"《【]([^”"》】]{2,12})[”"》】]/g)) {
    const e = m[1].trim();
    if (e.length >= 2 && !STOP_ENTITY.has(e)) set.add(e);
  }
  if (hasCJK(t)) {
    for (const seg of t.match(/[\u4e00-\u9fff]{3,}/g) || []) {
      for (let i = 0; i <= seg.length - 3; i++) {
        const e = seg.slice(i, i + 3);
        if (!STOP_ENTITY.has(e)) set.add(e);
      }
    }
  } else {
    for (const w of latinTokens(t)) {
      if (w.length >= 4 && !STOP_EN.has(w)) set.add(w);
    }
  }
  return set;
}
function quoted(title) {
  return [...String(title).matchAll(/[“"《【]([^”"》】]{2,12})[”"》】]/g)].map(m => m[1]);
}

// 是否同一事件。
// 设计原则：**宁可漏合，不可错合**。错合会让展示的标题/摘要与热度完全对不上，
// 用户直接看到不相干内容；漏合只是少加了几分交叉权重。
// 因此只用标题信号 —— 摘要噪声大，IDF 稀有 2-gram 在百条量级语料里极不可靠
// （实测会把「央行逆回购」并进「台风沙德尔」簇，已弃用）。
export function sameEvent(ia, ib) {
  const ta = typeof ia === 'string' ? ia : ia.title;
  const tb = typeof ib === 'string' ? ib : ib.title;

  const sim = similar(ta, tb);
  // 1) 标题高度重合 —— 同一稿件的多源转发
  if (sim >= 0.42) return true;

  // 2) 中等重合 + 共享核心实体（如「吉隆泥石流灾害」）
  const ea = entities(ta), eb = entities(tb);
  let shared = 0;
  for (const x of ea) if (eb.has(x)) shared++;
  if (sim >= 0.26 && shared >= 2) return true;

  // 3) 引号专名一致（都在报道台风“沙德尔”）+ 基本文本重叠
  const qa = quoted(ta), qb = quoted(tb);
  if (qa.some(x => x.length >= 2 && qb.includes(x)) && sim >= 0.18) return true;

  return false;
}

// ============ 时效 ============
export function guessDate(item) {
  if (item.pub) {
    const t = Date.parse(String(item.pub).replace(/-/g, '/'));
    if (Number.isFinite(t)) return t;
  }
  const h = String(item.link || '');
  let m = h.match(/\/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})\//) || h.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) {
    const t = Date.parse(`${m[1]}/${m[2]}/${m[3]}`);
    if (Number.isFinite(t)) return t;
  }
  m = h.match(/\/n1\/(20\d{2})\/(\d{2})(\d{2})\//);   // 人民网 /n1/2026/0903/
  if (m) {
    const t = Date.parse(`${m[1]}/${m[2]}/${m[3]}`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}
export const MAX_AGE_MS = 3 * 24 * 3600 * 1000; // 只要近 3 天内容
export function isFresh(item, maxAgeMs = MAX_AGE_MS) {
  const t = guessDate(item);
  if (t === null) return true;   // 无法判断则保留
  return Date.now() - t <= maxAgeMs;
}
export function freshness(item) {
  const t = guessDate(item);
  if (t === null) return 0.62;   // 未知时间给中等分
  const hours = (Date.now() - t) / 3600000;
  if (hours < 0) return 1;
  if (hours <= 6) return 1;
  if (hours <= 12) return 0.92;
  if (hours <= 24) return 0.82;
  if (hours <= 48) return 0.58;
  return 0.32;
}

// ============ 列表解析（纯字符串处理）============
function extractTag(block, tag, attr) {
  if (attr) {
    const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}=["']([^"']+)["'][^>]*?/?>`, 'i');
    const m = block.match(re);
    if (m) return m[1].trim();
  }
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

// RSS / Atom
export function parseRss(xml, sourceName, limit = PER_SOURCE, latin = false) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = stripHtml(extractTag(b, 'title'));
    const link = stripHtml(extractTag(b, 'link', 'href') || extractTag(b, 'link'));
    const desc = extractTag(b, 'description') || extractTag(b, 'summary') || extractTag(b, 'content');
    const pub = extractTag(b, 'pubDate') || extractTag(b, 'updated') || extractTag(b, 'published');
    if (!title || !link) continue;
    if (!validTitle(title, latin)) continue;
    const summary = clip(desc, 120);
    if (isAd(title, summary)) continue;
    out.push({ title, link, summary, source: sourceName, pub: pub ? stripHtml(pub) : '' });
    if (out.length >= limit) break;
  }
  return out;
}

// HTML 列表页：抓 <a href>标题</a>，用 src.linkRe 筛正文页
export function parseHtmlList(html, src, limit = PER_SOURCE) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = m[1];
    const title = stripHtml(m[2])
      .replace(/^(推荐|独家|热点|要闻|视频|图集)\s*/, '')
      .replace(/^\s*\d{4}[-年./]\d{1,2}[-月./]\d{1,2}\s*[-–—]?\s*/, '') // 去掉列表里的前导日期（如「2026-09-06 」）
      .trim();
    if (!href) continue;
    try { href = new URL(href, src.url).href; } catch { continue; }
    if (!src.linkRe.test(href)) continue;
    if (!validTitle(title, src.latin)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, link: href, summary: '', source: src.name, sourceKey: src.key, pub: '' });
  }
  return out;
}

// 网易 news_json.js：var data={..."news":[[{c:评论数,t:标题,l:链接,p:时间}...]]}
export function parseNetease(txt, src, limit = PER_SOURCE) {
  const out = [];
  const seen = new Set();
  const re = /\{"c":(\d+),"t":"((?:[^"\\]|\\.)*)","l":"([^"]+)","p":"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(txt)) && out.length < limit) {
    const comments = Number(m[1]) || 0;
    const title = stripHtml(m[2].replace(/\\"/g, '"').replace(/\\\//g, '/'));
    const link = m[3].replace(/\\\//g, '/');
    const pub = m[4] || '';
    if (!validTitle(title, src.latin)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, link, summary: '', source: src.name, sourceKey: src.key, pub, comments });
  }
  return out;
}

// 按源类型分发解析，并打上源内编辑排位（rank 0 = 头条）与权威度
export function parseSource(txt, src) {
  let items = [];
  if (src.type === 'rss') {
    items = parseRss(txt, src.name, PER_SOURCE, src.latin).map(it => ({ ...it, sourceKey: src.key }));
  } else if (src.type === 'html') {
    items = parseHtmlList(txt, src);
  } else if (src.type === 'netease') {
    items = parseNetease(txt, src);
  }
  return items.map((it, i) => ({ ...it, rank: i, authority: src.authority }));
}

// 去重（同链接）+ 过滤广告 + 过滤陈旧（maxAgeMs 可覆盖默认 3 天窗口）
export function cleanCandidates(all, maxAgeMs = MAX_AGE_MS) {
  const seenLink = new Set();
  return all.filter(it => {
    if (!it || !it.title || !it.link) return false;
    if (isAd(it.title, it.summary)) return false;
    if (!isFresh(it, maxAgeMs)) return false;
    const k = String(it.link).replace(/[?#].*$/, '');
    if (seenLink.has(k)) return false;
    seenLink.add(k);
    return true;
  });
}

// ============ 聚类 ============
// 与计分分离：聚类只在全量候选池上做一次，后续补摘要只重算分数、不再重新聚类。
// 若对「簇代表」再聚类，代表之间天然互不相同，crossCount 会被错误重置为 1。
export function clusterAll(all) {
  const clusters = [];
  for (const it of all) {
    let hit = null;
    for (const c of clusters) {
      // 需同时满足：与簇内某成员判定同事件，且与簇锚点（首条）仍有基本文本重叠。
      // 后一个约束用于阻断「链式漂移」：A~B、B~C 但 A 与 C 毫不相干时，
      // 若只看 some()，簇会顺着链条无限膨胀（实测 1 个簇吞掉 14 条无关新闻）。
      if (c.members.some(m => sameEvent(it, m)) && similar(it.title, c.members[0].title) >= 0.15) {
        hit = c; break;
      }
    }
    if (hit) hit.members.push(it);
    else clusters.push({ members: [it] });
  }
  return clusters;
}

// 簇代表：权威度最高、其次编辑排位最靠前
export function repOf(c) {
  return c.members.slice().sort((a, b) =>
    (b.authority - a.authority) || (a.rank - b.rank)
  )[0];
}

// ============ 热度计分 ============
export function scoreCluster(c, opts = {}) {
  const intl = !!opts.intl;
  const medical = !!opts.medical;
  const crossCount = new Set(c.members.map(m => m.sourceKey)).size; // 几家权威源同时报道
  const best = repOf(c);
  // 摘要取簇内最充实的一条（代表条目自己没抓到时，用同事件其他源的）
  const withSum = c.members
    .filter(m => m.summary && m.summary.length >= 30)
    .sort((a, b) => b.summary.length - a.summary.length)[0];
  const summary = (best.summary && best.summary.length >= 30)
    ? best.summary
    : (withSum ? withSum.summary : (best.summary || ''));

  const maxAuth = Math.max(...c.members.map(m => m.authority || 0.7));
  const bestRank = Math.min(...c.members.map(m => Number(m.rank) || 0));
  const maxFresh = Math.max(...c.members.map(m => freshness(m)));
  const kw = keywordScore(best.title, summary, intl, medical);
  const commentBoost = Math.min(
    Math.max(...c.members.map(m => Number(m.comments) || 0)) / 500, 1
  );
  // 同源多次报道（同一媒体连发多条追踪）也是热度信号
  const repeatBoost = Math.min((c.members.length - crossCount) / 2, 1);

  // 各维度得分（原始分合计 100）
  const sCross = Math.min((crossCount - 1) / 2, 1) * 22;  // 多源交叉：3 家同报即满分
  const sAuth  = maxAuth * 14;                            // 源权威度
  const sRank  = Math.max(0, 1 - bestRank / 16) * 23;     // 首页编辑排位
  const sFresh = maxFresh * 23;                           // 发布新鲜度
  const sKw    = Math.min(kw / 7, 1) * 14;                // 时政/民生关键词
  const sCmt   = commentBoost * 3;                        // 用户互动（评论数）
  const sRep   = repeatBoost * 1;                         // 同源连续追踪

  const raw = sCross + sAuth + sRank + sFresh + sKw + sCmt + sRep;
  // 映射到 41~99 展示区间（原始分保留在 heatRaw 便于核查）
  const heat = Math.max(41, Math.min(99, Math.round(40 + raw * 0.6)));
  return {
    ...best,
    summary,
    heat,
    heatRaw: Math.round(raw),
    heatParts: {
      cross: Math.round(sCross), auth: Math.round(sAuth), rank: Math.round(sRank),
      fresh: Math.round(sFresh), kw: Math.round(sKw)
    },
    crossCount,
    reportCount: c.members.length,
    sources: [...new Set(c.members.map(m => m.source))]
  };
}

// 一次性：聚类 + 计分 + 排序（不补摘要，供快速预览/测试）
export function computeHeat(all) {
  const scored = clusterAll(all).map(scoreCluster);
  scored.sort((a, b) => b.heat - a.heat);
  return scored.map((it, i) => ({ ...it, rankNo: i + 1 }));
}

// 源多样性：单一媒体最多占 cap 条，保证六家权威源都有露出机会
export function pickDiverse(rankedPairs, topN = TOP_N, cap = 3) {
  const picked = [];
  const perSource = {};
  for (const p of rankedPairs) {
    const key = p.s.sourceKey;
    const n = perSource[key] || 0;
    if (n >= cap) continue;
    perSource[key] = n + 1;
    picked.push(p);
    if (picked.length >= topN) break;
  }
  if (picked.length < topN) {
    for (const p of rankedPairs) {
      if (picked.includes(p)) continue;
      picked.push(p);
      if (picked.length >= topN) break;
    }
  }
  return picked;
}

// ============ 详情页摘要提取 ============
export function extractSummaryFromHtml(html, title = '') {
  if (!html) return '';
  // 正文段落优先（信息量比 meta 大）
  const paras = [];
  for (const p of html.match(/<p[^>]*>([\s\S]{30,600}?)<\/p>/gi) || []) {
    const t = stripHtml(p);
    if (t.length < 35) continue;
    if (/版权|责任编辑|扫码|关注我们|免责声明|投稿|转载请|本文来源|编辑：|【纠错】/.test(t.slice(0, 26))) continue;
    paras.push(t);
  }

  const metas = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,})["']/i,
    /<meta[^>]+content=["']([^"']{20,})["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,})["']/i
  ];
  let meta = '';
  for (const re of metas) {
    const m = html.match(re);
    if (m) {
      const t = stripHtml(m[1]);
      if (t.length >= 20 && !/页面不存在|已被删除|404/.test(t)) { meta = t; break; }
    }
  }

  // meta 与标题几乎相同（等于没摘要）时，优先用正文首段
  const titleClean = stripHtml(title).replace(/[\s\p{P}]/gu, '');
  const metaClean = meta.replace(/[\s\p{P}]/gu, '');
  const metaIsTitle = titleClean && metaClean &&
    (metaClean === titleClean || (metaClean.length <= titleClean.length + 8 && metaClean.includes(titleClean)));

  if (meta && !metaIsTitle) return meta;
  if (paras.length) return paras[0];
  return meta || '';
}

export const NO_SUMMARY_HINT = '（该来源未提供摘要，点击右侧「查看原链接」阅读全文）';
