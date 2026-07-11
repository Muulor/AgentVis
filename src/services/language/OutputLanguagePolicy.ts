/**
 * OutputLanguagePolicy - shared LLM output-language resolution and prompt contracts.
 *
 * Explicit per-turn output requests take precedence over request-language detection,
 * while the AgentVis UI preference and WebView/system locales are fallback signals.
 */

export type OutputLanguageSource =
  | 'explicit_target'
  | 'request_language'
  | 'source_language'
  | 'runtime_preference'
  | 'unknown';

export interface OutputLanguageExclusion {
  tag: string;
  label: string;
}

export interface OutputLanguageHint {
  tag: string;
  label: string;
  guidance: string;
  source: OutputLanguageSource;
  /** Explicitly excluded output languages, such as "do not answer in English". */
  excludedLanguages?: readonly OutputLanguageExclusion[];
}

export interface ResolveOutputLanguageOptions {
  /** Explicit preference order. Primarily useful for system-owned LLM tasks and tests. */
  preferredLanguageTags?: readonly string[];
  /** Whether an explicit translation/output target in the request should win. Defaults to true. */
  honorExplicitTarget?: boolean;
  /** Whether AgentVis/WebView language preferences may be used as a fallback. Defaults to true. */
  useRuntimePreference?: boolean;
}

export interface OutputLanguageContractOptions {
  /** Natural-language fields or surfaces governed by the contract. */
  fields?: readonly string[];
  /** Additional task-specific language constraint. */
  additionalRule?: string;
}

interface LanguageDefinition {
  tag: string;
  label: string;
  aliases: readonly string[];
}

interface LatinLanguageProfile {
  tag: string;
  label: string;
  commonWords: ReadonlySet<string>;
  strongWords: ReadonlySet<string>;
  distinctiveCharacters?: RegExp;
}

interface LatinLanguageScore {
  profile: LatinLanguageProfile;
  score: number;
  strongHits: number;
  commonHits: number;
  distinctiveCharacterHits: number;
}

const AGENTVIS_LANGUAGE_STORAGE_KEY = 'agentvis-language';

const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  {
    tag: 'zh-TW',
    label: 'Traditional Chinese',
    aliases: [
      '繁体中文',
      '繁體中文',
      '正體中文',
      '繁体字',
      '繁體字',
      '繁体中国語',
      '繁體中國語',
      '번체 중국어',
      'traditional chinese',
    ],
  },
  {
    tag: 'zh-CN',
    label: 'Simplified Chinese',
    aliases: [
      '简体中文',
      '簡體中文',
      '简体中国語',
      '簡体中国語',
      '簡体字',
      '简体字',
      '간체 중국어',
      'simplified chinese',
    ],
  },
  {
    tag: 'zh',
    label: 'Chinese',
    aliases: ['中文', '汉语', '漢語', '华语', '華語', '中国語', '中國語', '중국어', 'chinese'],
  },
  { tag: 'en', label: 'English', aliases: ['英语', '英語', '英文', '영어', 'english'] },
  {
    tag: 'ja',
    label: 'Japanese',
    aliases: ['日语', '日語', '日文', '日本語', '일본어', 'japanese'],
  },
  {
    tag: 'ko',
    label: 'Korean',
    aliases: ['韩语', '韓語', '韩文', '韓文', '韓国語', '한국어', 'korean'],
  },
  {
    tag: 'fr',
    label: 'French',
    aliases: ['法语', '法語', '法文', 'フランス語', '프랑스어', 'français', 'french'],
  },
  {
    tag: 'de',
    label: 'German',
    aliases: ['德语', '德語', '德文', 'ドイツ語', '독일어', 'deutsch', 'german'],
  },
  {
    tag: 'es',
    label: 'Spanish',
    aliases: ['西班牙语', '西班牙語', '西班牙文', 'スペイン語', '스페인어', 'español', 'spanish'],
  },
  {
    tag: 'pt',
    label: 'Portuguese',
    aliases: [
      '葡萄牙语',
      '葡萄牙語',
      '葡文',
      'ポルトガル語',
      '포르투갈어',
      'português',
      'portuguese',
    ],
  },
  {
    tag: 'ru',
    label: 'Russian',
    aliases: ['俄语', '俄語', '俄文', 'ロシア語', '러시아어', 'русский', 'russian'],
  },
  {
    tag: 'ar',
    label: 'Arabic',
    aliases: ['阿拉伯语', '阿拉伯語', 'アラビア語', '아랍어', 'العربية', 'arabic'],
  },
  {
    tag: 'hi',
    label: 'Hindi',
    aliases: ['印地语', '印地語', 'ヒンディー語', '힌디어', 'हिन्दी', 'हिंदी', 'hindi'],
  },
  { tag: 'th', label: 'Thai', aliases: ['泰语', '泰語', 'タイ語', '태국어', 'ภาษาไทย', 'thai'] },
  {
    tag: 'vi',
    label: 'Vietnamese',
    aliases: ['越南语', '越南語', 'ベトナム語', '베트남어', 'tiếng việt', 'vietnamese'],
  },
  {
    tag: 'id',
    label: 'Indonesian',
    aliases: [
      '印度尼西亚语',
      '印尼语',
      'インドネシア語',
      '인도네시아어',
      'bahasa indonesia',
      'indonesian',
    ],
  },
  {
    tag: 'it',
    label: 'Italian',
    aliases: ['意大利语', '意大利語', 'イタリア語', '이탈리아어', 'italiano', 'italian'],
  },
  {
    tag: 'nl',
    label: 'Dutch',
    aliases: ['荷兰语', '荷蘭語', 'オランダ語', '네덜란드어', 'nederlands', 'dutch'],
  },
  {
    tag: 'pl',
    label: 'Polish',
    aliases: ['波兰语', '波蘭語', 'ポーランド語', '폴란드어', 'polski', 'polish'],
  },
  {
    tag: 'tr',
    label: 'Turkish',
    aliases: ['土耳其语', '土耳其語', 'トルコ語', '터키어', 'türkçe', 'turkish'],
  },
  {
    tag: 'he',
    label: 'Hebrew',
    aliases: ['希伯来语', '希伯來語', 'ヘブライ語', '히브리어', 'עברית', 'hebrew'],
  },
];

const LOCALE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  th: 'Thai',
  tr: 'Turkish',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

// Only characters whose simplified and traditional forms differ are evidence.
// Shared Han characters are intentionally absent, so they cannot force a variant.
const CHINESE_VARIANT_CHARACTER_PAIRS: readonly (readonly [string, string])[] = [
  ['个', '個'],
  ['为', '為'],
  ['这', '這'],
  ['们', '們'],
  ['与', '與'],
  ['专', '專'],
  ['业', '業'],
  ['东', '東'],
  ['丝', '絲'],
  ['两', '兩'],
  ['严', '嚴'],
  ['临', '臨'],
  ['丽', '麗'],
  ['举', '舉'],
  ['义', '義'],
  ['乌', '烏'],
  ['乐', '樂'],
  ['乔', '喬'],
  ['习', '習'],
  ['乡', '鄉'],
  ['买', '買'],
  ['乱', '亂'],
  ['争', '爭'],
  ['亚', '亞'],
  ['产', '產'],
  ['亲', '親'],
  ['亿', '億'],
  ['仅', '僅'],
  ['从', '從'],
  ['仓', '倉'],
  ['仪', '儀'],
  ['价', '價'],
  ['众', '眾'],
  ['优', '優'],
  ['会', '會'],
  ['伟', '偉'],
  ['传', '傳'],
  ['伤', '傷'],
  ['伦', '倫'],
  ['伪', '偽'],
  ['倾', '傾'],
  ['侨', '僑'],
  ['偿', '償'],
  ['储', '儲'],
  ['儿', '兒'],
  ['兑', '兌'],
  ['党', '黨'],
  ['兰', '蘭'],
  ['关', '關'],
  ['兴', '興'],
  ['养', '養'],
  ['兽', '獸'],
  ['写', '寫'],
  ['军', '軍'],
  ['农', '農'],
  ['决', '決'],
  ['况', '況'],
  ['冻', '凍'],
  ['净', '淨'],
  ['凉', '涼'],
  ['减', '減'],
  ['凯', '凱'],
  ['删', '刪'],
  ['则', '則'],
  ['剂', '劑'],
  ['剑', '劍'],
  ['剧', '劇'],
  ['劳', '勞'],
  ['势', '勢'],
  ['勋', '勳'],
  ['汇', '匯'],
  ['区', '區'],
  ['医', '醫'],
  ['华', '華'],
  ['协', '協'],
  ['单', '單'],
  ['卖', '賣'],
  ['卢', '盧'],
  ['卫', '衛'],
  ['厂', '廠'],
  ['厅', '廳'],
  ['历', '歷'],
  ['厉', '厲'],
  ['压', '壓'],
  ['厌', '厭'],
  ['厕', '廁'],
  ['厢', '廂'],
  ['厨', '廚'],
  ['废', '廢'],
  ['广', '廣'],
  ['庆', '慶'],
  ['库', '庫'],
  ['应', '應'],
  ['庙', '廟'],
  ['庞', '龐'],
  ['开', '開'],
  ['异', '異'],
  ['弃', '棄'],
  ['张', '張'],
  ['弥', '彌'],
  ['弯', '彎'],
  ['弹', '彈'],
  ['归', '歸'],
  ['录', '錄'],
  ['当', '當'],
  ['径', '徑'],
  ['彻', '徹'],
  ['忆', '憶'],
  ['怀', '懷'],
  ['态', '態'],
  ['虑', '慮'],
  ['凭', '憑'],
  ['悬', '懸'],
  ['恋', '戀'],
  ['战', '戰'],
  ['户', '戶'],
  ['扑', '撲'],
  ['执', '執'],
  ['扩', '擴'],
  ['扫', '掃'],
  ['扬', '揚'],
  ['换', '換'],
  ['据', '據'],
  ['损', '損'],
  ['抢', '搶'],
  ['担', '擔'],
  ['揽', '攬'],
  ['摄', '攝'],
  ['摆', '擺'],
  ['摇', '搖'],
  ['败', '敗'],
  ['叙', '敘'],
  ['敌', '敵'],
  ['数', '數'],
  ['敛', '斂'],
  ['毙', '斃'],
  ['畅', '暢'],
  ['术', '術'],
  ['朴', '樸'],
  ['机', '機'],
  ['杀', '殺'],
  ['杂', '雜'],
  ['权', '權'],
  ['条', '條'],
  ['杨', '楊'],
  ['极', '極'],
  ['构', '構'],
  ['标', '標'],
  ['样', '樣'],
  ['树', '樹'],
  ['桥', '橋'],
  ['档', '檔'],
  ['检', '檢'],
  ['楼', '樓'],
  ['欢', '歡'],
  ['欧', '歐'],
  ['岁', '歲'],
  ['残', '殘'],
  ['壳', '殼'],
  ['毁', '毀'],
  ['气', '氣'],
  ['汉', '漢'],
  ['汤', '湯'],
  ['沟', '溝'],
  ['灭', '滅'],
  ['沪', '滬'],
  ['洁', '潔'],
  ['泪', '淚'],
  ['涩', '澀'],
  ['浅', '淺'],
  ['渊', '淵'],
  ['渔', '漁'],
  ['湿', '濕'],
  ['湾', '灣'],
  ['满', '滿'],
  ['滤', '濾'],
  ['潜', '潛'],
  ['澜', '瀾'],
  ['济', '濟'],
  ['浓', '濃'],
  ['涛', '濤'],
  ['炉', '爐'],
  ['点', '點'],
  ['炼', '煉'],
  ['热', '熱'],
  ['爱', '愛'],
  ['爷', '爺'],
  ['墙', '牆'],
  ['牵', '牽'],
  ['状', '狀'],
  ['独', '獨'],
  ['获', '獲'],
  ['献', '獻'],
  ['环', '環'],
  ['现', '現'],
  ['毕', '畢'],
  ['画', '畫'],
  ['叠', '疊'],
  ['疗', '療'],
  ['疯', '瘋'],
  ['痴', '癡'],
  ['皱', '皺'],
  ['盗', '盜'],
  ['盏', '盞'],
  ['监', '監'],
  ['盘', '盤'],
  ['睁', '睜'],
  ['瞩', '矚'],
  ['础', '礎'],
  ['碍', '礙'],
  ['礼', '禮'],
  ['祷', '禱'],
  ['离', '離'],
  ['种', '種'],
  ['积', '積'],
  ['称', '稱'],
  ['稳', '穩'],
  ['窝', '窩'],
  ['穷', '窮'],
  ['窜', '竄'],
  ['竞', '競'],
  ['笔', '筆'],
  ['笋', '筍'],
  ['笺', '箋'],
  ['节', '節'],
  ['范', '範'],
  ['筑', '築'],
  ['签', '簽'],
  ['简', '簡'],
  ['篮', '籃'],
  ['粮', '糧'],
  ['纠', '糾'],
  ['红', '紅'],
  ['纺', '紡'],
  ['纸', '紙'],
  ['纹', '紋'],
  ['纳', '納'],
  ['纽', '紐'],
  ['线', '線'],
  ['练', '練'],
  ['组', '組'],
  ['细', '細'],
  ['织', '織'],
  ['终', '終'],
  ['绍', '紹'],
  ['绝', '絕'],
  ['统', '統'],
  ['经', '經'],
  ['绿', '綠'],
  ['维', '維'],
  ['纲', '綱'],
  ['网', '網'],
  ['紧', '緊'],
  ['绪', '緒'],
  ['缘', '緣'],
  ['编', '編'],
  ['缓', '緩'],
  ['县', '縣'],
  ['纵', '縱'],
  ['总', '總'],
  ['绩', '績'],
  ['绘', '繪'],
  ['继', '繼'],
  ['续', '續'],
  ['纤', '纖'],
  ['罢', '罷'],
  ['罗', '羅'],
  ['翘', '翹'],
  ['圣', '聖'],
  ['闻', '聞'],
  ['联', '聯'],
  ['声', '聲'],
  ['聪', '聰'],
  ['肃', '肅'],
  ['肠', '腸'],
  ['脑', '腦'],
  ['脚', '腳'],
  ['脸', '臉'],
  ['脏', '臟'],
  ['旧', '舊'],
  ['舰', '艦'],
  ['舱', '艙'],
  ['艳', '艷'],
  ['艺', '藝'],
  ['庄', '莊'],
  ['叶', '葉'],
  ['苏', '蘇'],
  ['蕴', '蘊'],
  ['虚', '虛'],
  ['虫', '蟲'],
  ['蚕', '蠶'],
  ['补', '補'],
  ['装', '裝'],
  ['复', '複'],
  ['见', '見'],
  ['规', '規'],
  ['觉', '覺'],
  ['览', '覽'],
  ['触', '觸'],
  ['誉', '譽'],
  ['计', '計'],
  ['讯', '訊'],
  ['记', '記'],
  ['讲', '講'],
  ['许', '許'],
  ['论', '論'],
  ['设', '設'],
  ['访', '訪'],
  ['证', '證'],
  ['评', '評'],
  ['识', '識'],
  ['诉', '訴'],
  ['词', '詞'],
  ['译', '譯'],
  ['议', '議'],
  ['护', '護'],
  ['读', '讀'],
  ['变', '變'],
  ['让', '讓'],
  ['贝', '貝'],
  ['负', '負'],
  ['财', '財'],
  ['贡', '貢'],
  ['贫', '貧'],
  ['货', '貨'],
  ['贩', '販'],
  ['贪', '貪'],
  ['贯', '貫'],
  ['责', '責'],
  ['贵', '貴'],
  ['贷', '貸'],
  ['费', '費'],
  ['贺', '賀'],
  ['宾', '賓'],
  ['赏', '賞'],
  ['赔', '賠'],
  ['贤', '賢'],
  ['赋', '賦'],
  ['质', '質'],
  ['赖', '賴'],
  ['赠', '贈'],
  ['赞', '贊'],
  ['赶', '趕'],
  ['赵', '趙'],
  ['迹', '跡'],
  ['践', '踐'],
  ['车', '車'],
  ['轨', '軌'],
  ['轩', '軒'],
  ['转', '轉'],
  ['轮', '輪'],
  ['软', '軟'],
  ['轴', '軸'],
  ['轻', '輕'],
  ['载', '載'],
  ['较', '較'],
  ['辅', '輔'],
  ['辆', '輛'],
  ['辈', '輩'],
  ['辉', '輝'],
  ['辑', '輯'],
  ['输', '輸'],
  ['辖', '轄'],
  ['辞', '辭'],
  ['边', '邊'],
  ['达', '達'],
  ['迁', '遷'],
  ['选', '選'],
  ['递', '遞'],
  ['逻', '邏'],
  ['郑', '鄭'],
  ['释', '釋'],
  ['针', '針'],
  ['钉', '釘'],
  ['铃', '鈴'],
  ['钮', '鈕'],
  ['铅', '鉛'],
  ['银', '銀'],
  ['铜', '銅'],
  ['铭', '銘'],
  ['销', '銷'],
  ['铺', '鋪'],
  ['钢', '鋼'],
  ['钱', '錢'],
  ['锅', '鍋'],
  ['键', '鍵'],
  ['锁', '鎖'],
  ['镜', '鏡'],
  ['钟', '鐘'],
  ['铁', '鐵'],
  ['鉴', '鑑'],
  ['钥', '鑰'],
  ['长', '長'],
  ['门', '門'],
  ['闪', '閃'],
  ['闭', '閉'],
  ['问', '問'],
  ['间', '間'],
  ['阁', '閣'],
  ['阀', '閥'],
  ['阅', '閱'],
  ['队', '隊'],
  ['阳', '陽'],
  ['阴', '陰'],
  ['阵', '陣'],
  ['阶', '階'],
  ['际', '際'],
  ['陆', '陸'],
  ['陈', '陳'],
  ['险', '險'],
  ['隐', '隱'],
  ['双', '雙'],
  ['鸡', '雞'],
  ['难', '難'],
  ['电', '電'],
  ['雾', '霧'],
  ['灵', '靈'],
  ['静', '靜'],
  ['韩', '韓'],
  ['页', '頁'],
  ['顶', '頂'],
  ['项', '項'],
  ['顺', '順'],
  ['须', '須'],
  ['顽', '頑'],
  ['顿', '頓'],
  ['预', '預'],
  ['领', '領'],
  ['头', '頭'],
  ['频', '頻'],
  ['颗', '顆'],
  ['题', '題'],
  ['额', '額'],
  ['颜', '顏'],
  ['风', '風'],
  ['飞', '飛'],
  ['饥', '飢'],
  ['饭', '飯'],
  ['饮', '飲'],
  ['饲', '飼'],
  ['饼', '餅'],
  ['余', '餘'],
  ['馆', '館'],
  ['马', '馬'],
  ['驾', '駕'],
  ['骑', '騎'],
  ['骗', '騙'],
  ['骚', '騷'],
  ['驱', '驅'],
  ['验', '驗'],
  ['惊', '驚'],
  ['发', '發'],
  ['斗', '鬥'],
  ['闹', '鬧'],
  ['鱼', '魚'],
  ['鲁', '魯'],
  ['鲜', '鮮'],
  ['鸟', '鳥'],
  ['鸣', '鳴'],
  ['鸭', '鴨'],
  ['鸿', '鴻'],
  ['鹅', '鵝'],
  ['鹰', '鷹'],
  ['盐', '鹽'],
  ['麦', '麥'],
  ['黄', '黃'],
  ['齐', '齊'],
  ['齿', '齒'],
  ['龄', '齡'],
  ['龙', '龍'],
  ['龟', '龜'],
  ['该', '該'],
  ['备', '備'],
  ['务', '務'],
  ['连', '連'],
  ['给', '給'],
  ['启', '啟'],
  ['创', '創'],
  ['拥', '擁'],
  ['栏', '欄'],
  ['图', '圖'],
  ['浏', '瀏'],
  ['资', '資'],
  ['夹', '夾'],
  ['标', '標'],
  ['请', '請'],
  ['内', '內'],
  ['时', '時'],
  ['无', '無'],
  ['还', '還'],
  ['进', '進'],
  ['过', '過'],
  ['实', '實'],
  ['号', '號'],
  ['对', '對'],
  ['处', '處'],
  ['动', '動'],
  ['语', '語'],
  ['类', '類'],
  ['层', '層'],
  ['结', '結'],
  ['帮', '幫'],
  ['吗', '嗎'],
  ['么', '麼'],
  ['复', '覆'],
  ['码', '碼'],
  ['详', '詳'],
  ['将', '將'],
  ['纯', '純'],
  ['后', '後'],
  ['询', '詢'],
  ['调', '調'],
  ['确', '確'],
  ['场', '場'],
  ['视', '視'],
  ['学', '學'],
  ['制', '製'],
  ['参', '參'],
  ['识', '識'],
  ['测', '測'],
  ['试', '試'],
  ['断', '斷'],
  ['迈', '邁'],
  ['级', '級'],
  ['链', '鏈'],
  ['强', '強'],
  ['邻', '鄰'],
  ['尝', '嘗'],
  ['里', '裡'],
  ['几', '幾'],
  ['画', '畫'],
  ['诗', '詩'],
  ['适', '適'],
  ['缩', '縮'],
  ['宽', '寬'],
];

const SIMPLIFIED_CHINESE_EVIDENCE = new Set(
  CHINESE_VARIANT_CHARACTER_PAIRS.map(([simplified]) => simplified)
);
const TRADITIONAL_CHINESE_EVIDENCE = new Set(
  CHINESE_VARIANT_CHARACTER_PAIRS.map(([, traditional]) => traditional)
);

function foldLatinWord(input: string): string {
  return input
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/ł/gu, 'l')
    .replace(/đ/gu, 'd')
    .replace(/ı/gu, 'i')
    .replace(/œ/gu, 'oe');
}

function createLatinWordSet(words: string): ReadonlySet<string> {
  return new Set(words.trim().split(/\s+/u).map(foldLatinWord).filter(Boolean));
}

const LATIN_TECHNICAL_NOISE = createLatinWordSet(`
    agent agents api apis browser css deepseek devtools docker finder git github html
    http https ios javascript json linux localhost macos node npm openai pnpm python react
    sdk sql terminal three typescript ui url urls ux vite web webview wifi windows xml yaml yarn
`);

const LATIN_LANGUAGE_PROFILES: readonly LatinLanguageProfile[] = [
  {
    tag: 'en',
    label: 'English',
    commonWords: createLatinWordSet(`
            a an and are as be by for from have has in into is it its must not of on or should
            that the these this those to we when will with without would you your
        `),
    strongWords: createLatinWordSet(`
            analyse analyze answer based build contain create english execute explain following
            generate help include language output please provide question quickly reply request
            respond return review rewrite save summarize task translate user using write
        `),
  },
  {
    tag: 'de',
    label: 'German',
    commonWords: createLatinWordSet(`
            aber als am auf aus bei das dass dem den der des die diese diesem diesen dieser dieses
            ein eine einem einen einer eines für im ist ihr ihre ihren ihres kann können mit muss
            müssen nach oder ohne sie sind soll sollen sollte und von vom vor war waren wenn werden
            wie wird wir
        `),
    strongWords: createLatinWordSet(`
            analyse analysieren antwort antworten aufgabe ausführen ausgabe ausgeben beinhalten
            benutzer benutzeroberfläche bitte datei dateien deutsch erklären erzeuge erzeugen
            erstellen folgende folgenden frage können oberfläche prüfen schreibe schreiben
            gespeichert speichern sprache übersetzen umschreiben verbinden zusammenfassung
            zusammenfassen
        `),
    distinctiveCharacters: /[äöüß]/giu,
  },
  {
    tag: 'fr',
    label: 'French',
    commonWords: createLatinWordSet(`
            avec ce ces cet cette comme dans de des doit doivent du en est et la le les mais notre
            nous ou peut peuvent pour quand que qui sans sera seront sont sur un une vos votre vous
        `),
    strongWords: createLatinWordSet(`
            analyser application contenir créer écrire enregistrer exécuter expliquer fichier
            fichiers français générer inclure interface langue produire question répondre réponse
            résumer retourner réécrire suivante suivant tâche traduire traduction utilisateur
            vérifier veuillez
        `),
    distinctiveCharacters: /[àâæçéèêëîïôœùûÿ]/giu,
  },
  {
    tag: 'es',
    label: 'Spanish',
    commonWords: createLatinWordSet(`
            como con cuando debe deben del el en es esta estas este estos la las lo los nuestro
            nosotros o para pero puede pueden que quien será sin son su sus un una unos unas usted
            ustedes y
        `),
    strongWords: createLatinWordSet(`
            analizar análisis aplicación archivo archivos contener crear devolver ejecutar escribir
            español explicar favor generar guardar idioma incluir interfaz pregunta producir
            proporcionar reescribir responda responder respuesta resumir resumen revisar siguiente
            tarea traducir traducción traduzca usuario
        `),
    distinctiveCharacters: /[áéíóúüñ¿¡]/giu,
  },
  {
    tag: 'pt',
    label: 'Portuguese',
    commonWords: createLatinWordSet(`
            a as com como da das de deve devem do dos é em esta estas este estes o os ou para pode
            podem que quem são sem seu seus sua suas um uma uns umas você vocês
        `),
    strongWords: createLatinWordSet(`
            análise analisar aplicação arquivo arquivos conter criar executar explicar favor
            ficheiro ficheiros fornecer gerar guardar idioma incluir interface português pergunta
            responder resposta retornar reescrever resumo resumir salvar seguinte tarefa traduzir
            tradução usuário utilizador
        `),
    distinctiveCharacters: /[áâãàçéêíóôõú]/giu,
  },
  {
    tag: 'it',
    label: 'Italian',
    commonWords: createLatinWordSet(`
            che chi come con dei del della delle deve devono di è gli i il in la le lei lo ma noi
            o per può possono questo questa questi queste sarà senza sono sua sue suo suoi un una voi
        `),
    strongWords: createLatinWordSet(`
            analisi analizzare applicazione compito contenere creare domanda eseguire favore file
            fornire generare includere interfaccia italiano lingua produrre restituire riassumere
            riassunto riscrivere rispondere risposta salvare scrivere seguente spiegare tradurre
            traduzione utente verificare
        `),
    distinctiveCharacters: /[àèéìíîòóùú]/giu,
  },
  {
    tag: 'nl',
    label: 'Dutch',
    commonWords: createLatinWordSet(`
            als dat de deze die dit een en het hoe in is jij je kan kunnen maar met moet moeten of
            om ons op uit u uw van voor wanneer waren was wij worden wordt zijn zonder
        `),
    strongWords: createLatinWordSet(`
            alstublieft analyseren antwoord antwoorden applicatie bestand bestanden bevatten
            controleren creëren gebruiker graag maken nederlands opnemen opslaan samenvatten
            samenvatting schrijven taal taak toepassing uitvoeren uitleggen uitvoer verbinden
            vertalen vertaling volgende vraag
        `),
    distinctiveCharacters: /[ĳ]/giu,
  },
  {
    tag: 'pl',
    label: 'Polish',
    commonWords: createLatinWordSet(`
            ale bez będzie będą był by dla do gdy i jak jest która które który lub może mogą musi
            muszą my na nasz od oraz pan pani państwo powinien powinna powinno są ta te ten to ty
            twój w wasz we wy z ze
        `),
    strongWords: createLatinWordSet(`
            analiza analizować aplikacja dołączyć interfejs język napisać następujący odpowiedzieć
            odpowiedź plik pliki podsumować podsumowanie polski połączyć proszę przetłumacz
            przepisać pytanie sprawdzić stworzyć tłumaczenie tłumaczyć użytkownik utworzyć wykonać
            wyjaśnić wyświetlić zadanie zapisać zawierać
        `),
    distinctiveCharacters: /[ąćęłńóśźż]/giu,
  },
  {
    tag: 'tr',
    label: 'Turkish',
    commonWords: createLatinWordSet(`
            ama bir biz bizim bu da dan de den her için ile ise kendi mi mı mu mü o olarak olan
            olmadan siz sizin şu tüm üzerinde veya
        `),
    strongWords: createLatinWordSet(`
            açıkla açıklayın analiz aşağıdaki arayüz bağlan cevap cevaplayın çeviri çevir çevirin
            çalıştır dahil dil dosya dosyalar görev içermek incele kaydet kullanıcı lütfen oluştur
            özet özetle soru türkçe üret uygulama yeniden yanıt yaz çıktı
        `),
    distinctiveCharacters: /[çğıöşü]/giu,
  },
  {
    tag: 'vi',
    label: 'Vietnamese',
    commonWords: createLatinWordSet(`
            bạn các cho có của đó được hoặc khi không là này như những phải thể tôi trên trong từ
            và với
        `),
    strongWords: createLatinWordSet(`
            bao câu chứa dịch dùng giải giao hỏi kết kiểm lưu ngôn người nhiệm nối phân phản sau
            tắt tạo tệp thích thực tiếng tóm trả trình ứng xuất viết vụ lời lòng
        `),
    distinctiveCharacters:
      /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/giu,
  },
  {
    tag: 'id',
    label: 'Indonesian',
    commonWords: createLatinWordSet(`
            adalah anda atau bisa dalam dan dapat dari dengan ini itu kami kamu kalian karena
            ketika merupakan pada sebagai sebaiknya tetapi untuk yang
        `),
    strongWords: createLatinWordSet(`
            analisis antarmuka aplikasi bahasa berisi berkas berikut buat hasilkan hubungkan
            indonesian jalankan jelaskan keluaran menerjemahkan menjawab pengguna pertanyaan
            periksa rangkum ringkas sertakan silakan simpan tanggapan terjemahan terjemahkan tolong
            tugas tulis
        `),
  },
];

function buildLatinWordProfileCounts(
  profiles: readonly LatinLanguageProfile[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const profile of profiles) {
    const profileWords = new Set([...profile.commonWords, ...profile.strongWords]);
    for (const word of profileWords) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return counts;
}

const LATIN_WORD_PROFILE_COUNTS = buildLatinWordProfileCounts(LATIN_LANGUAGE_PROFILES);

const CODE_CONTENT_PATTERNS: readonly RegExp[] = [/```[\s\S]*?```/gu, /`[^`\r\n]*`/gu];

const QUOTED_OR_EMBEDDED_CONTENT_PATTERNS: readonly RegExp[] = [
  ...CODE_CONTENT_PATTERNS,
  /“[^”]*”/gu,
  /‘[^’]*’/gu,
  /「[^」]*」/gu,
  /『[^』]*』/gu,
  /《[^》]*》/gu,
  /〈[^〉]*〉/gu,
  /"[^"\r\n]*"/gu,
  /'[^'\r\n]{2,}'/gu,
];

const INSTRUCTION_CUE_PATTERNS: readonly RegExp[] = [
  /(?:please|translate|analy[sz]e|summari[sz]e|explain|rewrite|review|answer|respond|reply|write|output|render|provide|present|return)/iu,
  /(?:请|請|帮我|幫我|幫忙|翻译|翻譯|分析|总结|總結|解释|解釋|改写|改寫|审查|審查|回答|回复|回覆|输出|輸出)/u,
  /(?:翻訳|要約|説明|返答|出力|作成)/u,
  /(?:번역|분석|요약|설명|답변|응답|출력|작성)/u,
  /(?:bitte|übersetz|analysier|zusammenfass|erklär|umschreib|prüf|antwort|schreib|ausgib|erstell)/iu,
  /(?:veuillez|tradui|analys|résum|expliqu|réécri|vérifi|répond|écri|produi|cré)/iu,
  /(?:por favor|traduc|analiz|resum|explic|reescri|revis|respond|escrib|gener|crea)/iu,
  /(?:por favor|traduz|analis|resum|explic|reescre|revis|respond|escrev|ger|cri)/iu,
  /(?:per favore|traduc|analizz|riassum|spieg|riscriv|verific|rispond|scriv|crea)/iu,
  /(?:alstublieft|graag|vertaal|vertal|analyse|samenvat|leg uit|herschrijf|controleer|antwoord|schrijf|maak)/iu,
  /(?:proszę|przetłum|analiz|podsum|wyjaś|przepisz|sprawdź|odpowiedz|napisz|utwórz)/iu,
  /(?:lütfen|çevir|analiz|özet|açıkla|yeniden yaz|incele|yanıt|cevap|yaz|oluştur)/iu,
  /(?:vui lòng|dịch|phân tích|tóm tắt|giải thích|viết lại|kiểm tra|trả lời|viết|tạo)/iu,
  /(?:silakan|tolong|terjemah|analisis|rangkum|ringkas|jelaskan|tulis ulang|periksa|jawab|tulis|buat)/iu,
];

interface AliasOccurrence {
  definition: LanguageDefinition;
  alias: string;
  start: number;
  end: number;
}

interface TextSpan {
  start: number;
  end: number;
}

type TargetPolarity = 'positive' | 'negative' | 'none';

interface ExplicitLanguageDirectives {
  target?: LanguageDefinition;
  exclusions: LanguageDefinition[];
}

function countPatternMatches(input: string, pattern: RegExp): number {
  return (input.match(pattern) ?? []).length;
}

function stripQuotedOrEmbeddedContent(input: string): string {
  return QUOTED_OR_EMBEDDED_CONTENT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, ' '),
    input
  );
}

function stripCodeContent(input: string): string {
  return CODE_CONTENT_PATTERNS.reduce((current, pattern) => current.replace(pattern, ' '), input);
}

function findQuotedOrEmbeddedSpans(input: string): TextSpan[] {
  const spans: TextSpan[] = [];

  for (const pattern of QUOTED_OR_EMBEDDED_CONTENT_PATTERNS) {
    for (const match of input.matchAll(pattern)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return spans.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return right.end - right.start - (left.end - left.start);
  });
}

function extractInstructionShell(input: string): string {
  const unquoted = stripQuotedOrEmbeddedContent(input);

  for (const separator of unquoted.matchAll(/[:：]/gu)) {
    const prefix = unquoted.slice(0, separator.index);
    const hasInstructionCue = INSTRUCTION_CUE_PATTERNS.some((pattern) => pattern.test(prefix));
    if (hasMeaningfulText(prefix) && hasInstructionCue) {
      return prefix;
    }
  }

  return unquoted;
}

function hasMeaningfulText(input: string): boolean {
  return input.replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
}

function isAsciiWordAlias(alias: string): boolean {
  return /^[a-z ]+$/i.test(alias);
}

function hasAsciiWordBoundaries(input: string, start: number, end: number): boolean {
  const before = start > 0 ? (input[start - 1] ?? '') : '';
  const after = end < input.length ? (input[end] ?? '') : '';
  return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after);
}

function findLanguageAliasOccurrences(input: string): AliasOccurrence[] {
  const normalizedInput = input.toLocaleLowerCase();
  const allOccurrences: AliasOccurrence[] = [];

  for (const definition of LANGUAGE_DEFINITIONS) {
    for (const alias of definition.aliases) {
      const normalizedAlias = alias.toLocaleLowerCase();
      let searchFrom = 0;
      while (searchFrom < normalizedInput.length) {
        const start = normalizedInput.indexOf(normalizedAlias, searchFrom);
        if (start < 0) break;
        const end = start + normalizedAlias.length;
        if (!isAsciiWordAlias(alias) || hasAsciiWordBoundaries(normalizedInput, start, end)) {
          allOccurrences.push({ definition, alias, start, end });
        }
        searchFrom = start + Math.max(1, normalizedAlias.length);
      }
    }
  }

  // Prevent a shorter alias such as "Chinese" from overriding "Traditional Chinese".
  const nonOverlapping: AliasOccurrence[] = [];
  for (const occurrence of [...allOccurrences].sort(
    (left, right) => right.end - right.start - (left.end - left.start)
  )) {
    const contained = nonOverlapping.some(
      (existing) => occurrence.start >= existing.start && occurrence.end <= existing.end
    );
    if (!contained) nonOverlapping.push(occurrence);
  }

  return nonOverlapping;
}

function getCurrentDirectiveClause(before: string): string {
  const clauses = before.slice(-180).split(/[\n,，;；。.!?！？]/u);
  return clauses[clauses.length - 1] ?? '';
}

function isNegatedOutputTarget(before: string, after: string): boolean {
  const clause = getCurrentDirectiveClause(before);
  const afterWindow = after.slice(0, 64);
  const quoteBoundary = `["'“‘「『《〈\\s]*`;

  const negatedBefore = [
    new RegExp(
      `(?:do\\s+not|don't|never|must\\s+not|should\\s+not|avoid|except|excluding|other\\s+than|without|not(?!\\s+only\\b))\\b[\\s\\S]{0,100}${quoteBoundary}$`,
      'iu'
    ),
    new RegExp(
      `(?:不要|別|别|禁止|請勿|请勿|避免|不可|不能|不應|不应)[\\s\\S]{0,80}${quoteBoundary}$`,
      'u'
    ),
    new RegExp(`(?:使わない|使わず|しないで|避けて|禁止)[\\s\\S]{0,80}${quoteBoundary}$`, 'u'),
    new RegExp(`(?:사용하지|쓰지|금지)[\\s\\S]{0,80}${quoteBoundary}$`, 'u'),
  ].some((pattern) => pattern.test(clause));

  if (negatedBefore) return true;

  return [
    /^\s*(?:is\s+)?(?:forbidden|excluded|not\s+allowed|not\s+permitted)/iu,
    /^\s*(?:不要|除外|以外|禁止)/u,
    /^\s*(?:を|は|では)?\s*(?:使わない|使わず|避けて|禁止|なく)/u,
    /^\s*(?:을|를|은|는)?\s*(?:사용하지|쓰지|말고|금지|제외)/u,
  ].some((pattern) => pattern.test(afterWindow));
}

function isPositiveOutputTarget(before: string, after: string): boolean {
  const beforeWindow = before.slice(-140);
  const afterWindow = after.slice(0, 48);
  const trailingBoundary = `["'“‘「『《〈\\s]*`;

  const targetBeforeLanguage = [
    new RegExp(
      `(?:translate|rewrite|respond|reply|answer|write|output|render|provide|present|return)[\\s\\S]{0,100}(?:into|to|in|as)${trailingBoundary}$`,
      'iu'
    ),
    new RegExp(`(?:output|target|response)\\s+language\\s*[:：]?${trailingBoundary}$`, 'iu'),
    new RegExp(
      `(?:翻译|翻譯|译|譯|转换|轉換|改写|改寫|回答|回复|回覆|输出|輸出|撰写|撰寫|写成|寫成|生成)[\\s\\S]{0,100}(?:为|為|成|用|以|：|:)${trailingBoundary}$`,
      'u'
    ),
    new RegExp(
      `(?:目标语言|目標語言|输出语言|輸出語言|回答语言|回答語言)\\s*[:：]?${trailingBoundary}$`,
      'u'
    ),
    new RegExp(`(?:用|以)${trailingBoundary}$`, 'u'),
  ].some((pattern) => pattern.test(beforeWindow));

  if (targetBeforeLanguage) return true;

  return [
    /^\s*(?:回答|回复|回覆|输出|輸出|撰写|撰寫|写作|寫作|表达|表達|即可|就好)/u,
    /^\s*(?:に|で)\s*(?:翻訳|回答|返答|出力|記述|してください|して下さい)/u,
    /^\s*(?:으?로)\s*(?:번역|답변|응답|출력|작성|해\s*주세요)/u,
  ].some((pattern) => pattern.test(afterWindow));
}

function getTargetPolarity(before: string, after: string): TargetPolarity {
  if (isNegatedOutputTarget(before, after)) return 'negative';
  return isPositiveOutputTarget(before, after) ? 'positive' : 'none';
}

function detectExplicitLanguageDirectives(input: string): ExplicitLanguageDirectives {
  const spans = findQuotedOrEmbeddedSpans(input);
  const classified = findLanguageAliasOccurrences(input)
    .map((occurrence) => {
      const containingSpan = spans.find(
        (span) => occurrence.start >= span.start && occurrence.end <= span.end
      );
      const before = input.slice(0, containingSpan?.start ?? occurrence.start);
      const after = input.slice(containingSpan?.end ?? occurrence.end);

      return {
        ...occurrence,
        polarity: getTargetPolarity(before, after),
      };
    })
    .filter((occurrence) => occurrence.polarity !== 'none')
    .sort((left, right) => right.start - left.start);

  const effectiveByTag = new Map<string, (typeof classified)[number]>();
  for (const occurrence of classified) {
    if (!effectiveByTag.has(occurrence.definition.tag)) {
      effectiveByTag.set(occurrence.definition.tag, occurrence);
    }
  }

  const effective = [...effectiveByTag.values()];
  const target = effective.find((occurrence) => occurrence.polarity === 'positive')?.definition;
  const exclusions = effective
    .filter((occurrence) => occurrence.polarity === 'negative')
    .map((occurrence) => occurrence.definition)
    .filter((definition) => definition.tag !== target?.tag);

  return { target, exclusions };
}

function buildHint(
  tag: string,
  label: string,
  source: OutputLanguageSource,
  guidance?: string,
  excludedLanguages?: readonly OutputLanguageExclusion[]
): OutputLanguageHint {
  const defaultGuidance =
    source === 'explicit_target'
      ? `The latest request explicitly requires ${label}; that target overrides quoted content, provider defaults, and runtime locale.`
      : source === 'request_language'
        ? `Use ${label} for natural-language output because it is the language of the latest request instructions.`
        : source === 'source_language'
          ? `Preserve ${label} because it is the dominant natural language of the source content.`
          : source === 'runtime_preference'
            ? `The request has no reliable language signal, so use the user's AgentVis/WebView language preference: ${label}.`
            : 'Mirror the latest user request language for natural-language output.';

  return {
    tag,
    label,
    source,
    guidance: guidance ?? defaultGuidance,
    excludedLanguages: excludedLanguages?.length ? excludedLanguages : undefined,
  };
}

function countDistinctPatternMatches(input: string, pattern: RegExp): number {
  return new Set((input.match(pattern) ?? []).map((match) => match.toLocaleLowerCase())).size;
}

function inferChineseVariant(
  detectionText: string,
  source: 'request_language' | 'source_language',
  minimumEvidence = 2
): OutputLanguageHint {
  const characters = new Set(detectionText);
  const simplifiedHits = [...characters].filter((character) =>
    SIMPLIFIED_CHINESE_EVIDENCE.has(character)
  ).length;
  const traditionalHits = [...characters].filter((character) =>
    TRADITIONAL_CHINESE_EVIDENCE.has(character)
  ).length;

  const isClearVariantLead = (winner: number, runnerUp: number): boolean =>
    winner >= minimumEvidence &&
    (runnerUp === 0 || winner - runnerUp >= 2 || winner >= runnerUp * 2);

  if (isClearVariantLead(traditionalHits, simplifiedHits)) {
    return buildHint('zh-TW', 'Traditional Chinese', source);
  }
  if (isClearVariantLead(simplifiedHits, traditionalHits)) {
    return buildHint('zh-CN', 'Simplified Chinese', source);
  }

  return buildHint('zh', 'Chinese', source);
}

function refineGenericChineseTarget(latestUserRequest: string): OutputLanguageHint {
  const instructionShell = extractInstructionShell(latestUserRequest);
  const kanaCount = countPatternMatches(instructionShell, /[\u3040-\u30ff\u31f0-\u31ff]/gu);
  const hangulCount = countPatternMatches(
    instructionShell,
    /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu
  );

  // Japanese shinjitai and Korean language names must not be interpreted as a
  // Simplified/Traditional Chinese writing preference.
  if (kanaCount >= 2 || hangulCount >= 2) {
    return buildHint('zh', 'Chinese', 'request_language');
  }

  return inferChineseVariant(instructionShell, 'request_language', 1);
}

function scoreLatinLanguages(detectionText: string): {
  latinCharCount: number;
  winner?: LatinLanguageScore;
} {
  const normalizedText = detectionText.normalize('NFKC');
  const latinTokens = normalizedText.match(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu) ?? [];
  const latinCharCount = countPatternMatches(normalizedText, /\p{Script=Latin}/gu);
  const uniqueWords = new Set(
    latinTokens
      .map(foldLatinWord)
      .filter((word) => word.length >= 2)
      .filter((word) => !LATIN_TECHNICAL_NOISE.has(word))
  );

  if (latinCharCount < 8 || uniqueWords.size === 0) {
    return { latinCharCount };
  }

  const scores = LATIN_LANGUAGE_PROFILES.map((profile) => {
    let strongHits = 0;
    let commonHits = 0;

    for (const word of uniqueWords) {
      // Shared words such as "in", "de", and "is" are weak evidence and must not
      // bias the competition merely because they occur often in pasted content.
      if ((LATIN_WORD_PROFILE_COUNTS.get(word) ?? 0) > 1) continue;
      if (profile.strongWords.has(word)) {
        strongHits += 1;
      } else if (profile.commonWords.has(word)) {
        commonHits += 1;
      }
    }

    const lexicalHits = strongHits + commonHits;
    const distinctiveCharacterHits =
      profile.distinctiveCharacters && lexicalHits > 0
        ? Math.min(2, countDistinctPatternMatches(normalizedText, profile.distinctiveCharacters))
        : 0;

    return {
      profile,
      strongHits,
      commonHits,
      distinctiveCharacterHits,
      score: strongHits * 3 + commonHits + distinctiveCharacterHits,
    } satisfies LatinLanguageScore;
  }).sort((left, right) => right.score - left.score);

  const winner = scores[0];
  const runnerUp = scores[1];
  if (!winner || winner.score < 4) return { latinCharCount };

  const hasEnoughIndependentEvidence =
    winner.strongHits >= 2 ||
    (winner.strongHits >= 1 && winner.commonHits >= 1) ||
    winner.commonHits >= 4 ||
    (winner.strongHits >= 1 && winner.distinctiveCharacterHits >= 1);
  if (!hasEnoughIndependentEvidence) return { latinCharCount };

  const hasClearLead =
    !runnerUp ||
    runnerUp.score === 0 ||
    (winner.score - runnerUp.score >= 2 && winner.score >= runnerUp.score * 1.25);

  return hasClearLead ? { latinCharCount, winner } : { latinCharCount };
}

function inferLanguageFromText(
  detectionText: string,
  source: 'request_language' | 'source_language'
): OutputLanguageHint | undefined {
  const hiraganaCount = countPatternMatches(detectionText, /[\u3040-\u309f]/gu);
  const katakanaCount = countPatternMatches(detectionText, /[\u30a0-\u30ff\u31f0-\u31ff]/gu);
  const kanaCount = hiraganaCount + katakanaCount;
  const hangulCount = countPatternMatches(
    detectionText,
    /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu
  );
  const hanCount = countPatternMatches(detectionText, /[\u3400-\u9fff\uf900-\ufaff]/gu);
  const cyrillicCount = countPatternMatches(detectionText, /[\u0400-\u04ff]/gu);
  const arabicCount = countPatternMatches(
    detectionText,
    /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/gu
  );
  const devanagariCount = countPatternMatches(detectionText, /[\u0900-\u097f]/gu);
  const thaiCount = countPatternMatches(detectionText, /[\u0e00-\u0e7f]/gu);
  const hebrewCount = countPatternMatches(detectionText, /[\u0590-\u05ff]/gu);
  const greekCount = countPatternMatches(detectionText, /[\u0370-\u03ff]/gu);
  const latinResult = scoreLatinLanguages(detectionText);
  const { latinCharCount } = latinResult;

  const japaneseSignal =
    source === 'request_language'
      ? kanaCount >= 2
      : kanaCount >= 2 && (hanCount === 0 || kanaCount >= Math.max(2, hanCount * 0.5));

  if (japaneseSignal) return buildHint('ja', 'Japanese', source);
  if (hangulCount >= 2) return buildHint('ko', 'Korean', source);
  if (hanCount >= 2 && hanCount >= latinCharCount * 0.2) {
    return inferChineseVariant(detectionText, source);
  }
  if (cyrillicCount >= 2) {
    return buildHint(
      'und-Cyrl',
      source === 'request_language'
        ? 'the Cyrillic-script language used by the latest request'
        : 'the Cyrillic-script language used by the source content',
      source
    );
  }
  if (arabicCount >= 2) {
    return buildHint(
      'und-Arab',
      source === 'request_language'
        ? 'the Arabic-script language used by the latest request'
        : 'the Arabic-script language used by the source content',
      source
    );
  }
  if (devanagariCount >= 2) {
    return buildHint(
      'und-Deva',
      source === 'request_language'
        ? 'the Devanagari-script language used by the latest request'
        : 'the Devanagari-script language used by the source content',
      source
    );
  }
  if (thaiCount >= 2) return buildHint('th', 'Thai', source);
  if (hebrewCount >= 2) {
    return buildHint(
      'und-Hebr',
      source === 'request_language'
        ? 'the Hebrew-script language used by the latest request'
        : 'the Hebrew-script language used by the source content',
      source
    );
  }
  if (greekCount >= 2) {
    return buildHint(
      'und-Grek',
      source === 'request_language'
        ? 'the Greek-script language used by the latest request'
        : 'the Greek-script language used by the source content',
      source
    );
  }
  if (latinResult.winner) {
    return buildHint(latinResult.winner.profile.tag, latinResult.winner.profile.label, source);
  }
  if (latinCharCount >= 20 && hanCount === 0) {
    return buildHint(
      'und-Latn',
      source === 'request_language'
        ? 'the Latin-script language used by the latest request'
        : 'the Latin-script language used by the source content',
      source
    );
  }

  return undefined;
}

function inferRequestLanguage(input: string): OutputLanguageHint | undefined {
  const instructionShell = extractInstructionShell(input);
  const detectionText = hasMeaningfulText(instructionShell) ? instructionShell : input;
  return inferLanguageFromText(detectionText, 'request_language');
}

function normalizeLanguageTag(tag: string): string {
  return tag.trim().replace(/_/g, '-');
}

function hintFromLocale(tag: string): OutputLanguageHint | undefined {
  const normalizedTag = normalizeLanguageTag(tag);
  if (!normalizedTag) return undefined;
  const languageCode = normalizedTag.split('-')[0]?.toLocaleLowerCase();
  if (!languageCode) return undefined;

  if (languageCode === 'zh') {
    const isTraditional = /(?:^|-)(?:tw|hk|mo|hant)(?:-|$)/i.test(normalizedTag);
    return buildHint(
      normalizedTag,
      isTraditional ? 'Traditional Chinese' : 'Simplified Chinese',
      'runtime_preference'
    );
  }

  const label =
    LOCALE_LANGUAGE_NAMES[languageCode] ?? `the language identified by locale ${normalizedTag}`;
  return buildHint(normalizedTag, label, 'runtime_preference');
}

export function getRuntimeLanguagePreferences(): string[] {
  const preferences: string[] = [];
  try {
    if (typeof window !== 'undefined') {
      const storedLanguage = window.localStorage.getItem(AGENTVIS_LANGUAGE_STORAGE_KEY);
      if (storedLanguage) preferences.push(storedLanguage);
    }
  } catch {
    // Some WebView privacy modes deny localStorage access; navigator remains available.
  }

  if (typeof navigator !== 'undefined') {
    preferences.push(...navigator.languages);
    if (navigator.language) preferences.push(navigator.language);
  }
  if (typeof document !== 'undefined' && document.documentElement.lang) {
    preferences.push(document.documentElement.lang);
  }

  return [...new Set(preferences.map(normalizeLanguageTag).filter(Boolean))];
}

function toExclusions(definitions: readonly LanguageDefinition[]): OutputLanguageExclusion[] {
  return definitions.map((definition) => ({
    tag: definition.tag,
    label: definition.label,
  }));
}

function getBaseLanguageTag(tag: string): string {
  return normalizeLanguageTag(tag).split('-')[0]?.toLocaleLowerCase() ?? '';
}

function isLanguageExcluded(tag: string, exclusions: readonly OutputLanguageExclusion[]): boolean {
  const normalizedTag = normalizeLanguageTag(tag).toLocaleLowerCase();
  const baseTag = getBaseLanguageTag(tag);

  return exclusions.some((exclusion) => {
    const normalizedExclusion = normalizeLanguageTag(exclusion.tag).toLocaleLowerCase();
    if (normalizedTag === normalizedExclusion) return true;
    if (normalizedExclusion === 'zh') return baseTag === 'zh';
    return getBaseLanguageTag(exclusion.tag) === baseTag && baseTag !== 'zh';
  });
}

export function resolveOutputLanguage(
  latestUserRequest: string,
  options: ResolveOutputLanguageOptions = {}
): OutputLanguageHint {
  const {
    preferredLanguageTags,
    honorExplicitTarget = true,
    useRuntimePreference = true,
  } = options;

  const directives: ExplicitLanguageDirectives = honorExplicitTarget
    ? detectExplicitLanguageDirectives(latestUserRequest)
    : { exclusions: [] };
  const exclusions = toExclusions(directives.exclusions);

  if (directives.target) {
    const resolvedTarget =
      directives.target.tag === 'zh'
        ? refineGenericChineseTarget(latestUserRequest)
        : directives.target;
    return buildHint(
      resolvedTarget.tag,
      resolvedTarget.label,
      'explicit_target',
      undefined,
      exclusions
    );
  }

  const requestLanguage = inferRequestLanguage(latestUserRequest);
  if (requestLanguage && !isLanguageExcluded(requestLanguage.tag, exclusions)) {
    return buildHint(
      requestLanguage.tag,
      requestLanguage.label,
      requestLanguage.source,
      requestLanguage.guidance,
      exclusions
    );
  }

  if (useRuntimePreference) {
    const runtimePreferences = preferredLanguageTags ?? getRuntimeLanguagePreferences();
    for (const preference of runtimePreferences) {
      const runtimeHint = hintFromLocale(preference);
      if (runtimeHint && !isLanguageExcluded(runtimeHint.tag, exclusions)) {
        return buildHint(
          runtimeHint.tag,
          runtimeHint.label,
          runtimeHint.source,
          requestLanguage
            ? `The request language is explicitly excluded, so use the user's AgentVis/WebView language preference: ${runtimeHint.label}.`
            : runtimeHint.guidance,
          exclusions
        );
      }
    }
  }

  if (exclusions.length > 0) {
    return buildHint(
      'und',
      'a language allowed by the latest request',
      'unknown',
      'No positive target language could be resolved. Use a language supported by the surrounding conversation while respecting the explicit exclusions.',
      exclusions
    );
  }

  return buildHint('und', 'the language used by the latest request', 'unknown');
}

export function detectSourceLanguage(sourceText: string): OutputLanguageHint {
  const governingProse = stripQuotedOrEmbeddedContent(sourceText);
  const proseText = stripCodeContent(sourceText);
  const detectionText = hasMeaningfulText(governingProse)
    ? governingProse
    : hasMeaningfulText(proseText)
      ? proseText
      : sourceText;
  const sourceHint = inferLanguageFromText(detectionText, 'source_language');
  if (sourceHint) return sourceHint;

  return buildHint(
    'und',
    'the dominant natural language of the source content',
    'unknown',
    'No reliable source-language signal was detected. Preserve the source wording and do not introduce a runtime- or provider-language translation.'
  );
}

export function buildOutputLanguageContract(
  hint: OutputLanguageHint,
  options: OutputLanguageContractOptions = {}
): string {
  const governedFields = options.fields?.length
    ? `- Apply this contract to: ${options.fields.map((field) => `\`${field}\``).join(', ')}.`
    : '- Apply this contract to all user-visible prose, labels, examples, reports, and deliverables.';
  const additionalRule = options.additionalRule ? `\n- ${options.additionalRule}` : '';
  const exclusionRule = hint.excludedLanguages?.length
    ? `\n- Explicitly forbidden output languages: ${hint.excludedLanguages.map((language) => language.label).join(', ')}.`
    : '';

  return `[OUTPUT_LANGUAGE]
Resolved output language: ${hint.label}
${hint.guidance}
${governedFields}
- Keep JSON keys, enum values, file paths, code identifiers, commands, and quoted source text unchanged.
- Internal reasoning language, provider defaults, UI labels inside tool results, and system retry text must not change this output language.${exclusionRule}${additionalRule}`;
}

export const SOURCE_LANGUAGE_PRESERVATION_RULES = `## Source Language Preservation (hard requirement)
- JSON keys, enum values, and category/scope labels must remain exactly as specified in English.
- Natural-language values derived from user messages, assistant messages, candidates, summaries, facts, or reports must preserve the source language. Do not translate them into English merely because these instructions are written in English.
- If the source is primarily Chinese, write extracted or rewritten natural-language values in Chinese and preserve its Simplified/Traditional writing variant. Never normalize one variant into the other.
- When sources use multiple languages, write newly synthesized prose in the language of the current governing user-authored passage; if none governs, use the dominant source language. Preserve quoted wording and technical terms in their original language.
- Names, file paths, code identifiers, UI labels, and quoted phrases must stay verbatim unless you are only normalizing obvious whitespace.
- Translation is allowed only when the current task requires translating that specific value, not merely because a source message happens to contain a translation request. System-owned schema labels may remain in their specified language.`;

export function buildSourceLanguagePreservationContract(sourceText: string): string {
  const sourceHint = detectSourceLanguage(sourceText);
  const signalRule =
    sourceHint.source === 'unknown'
      ? `- ${sourceHint.guidance}`
      : `- Detected source-language signal: ${sourceHint.label}. Preserve that language in rewritten prose and generated labels; do not switch to the runtime or provider language.`;

  return `${SOURCE_LANGUAGE_PRESERVATION_RULES}
${signalRule}`;
}
