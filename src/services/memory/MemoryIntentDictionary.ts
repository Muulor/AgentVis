/**
 * MemoryIntentDictionary - 意图词典
 *
 * 为六种事实分类提供扩展的关键词和句式匹配库。
 *
 * 设计原则：
 * - 覆盖口语化、书面语、中英文多种表达
 * - 按分类组织，便于维护和扩展
 * - 提供关键词匹配和正则匹配两种方式
 * - interaction_signals 词典采用开放性设计：外延识别隐含模式和转折信号
 */

import type { LongTermFactCategory } from './types';

// ============================================================================
// 词典结构
// ============================================================================

/**
 * 意图词条
 */
export interface IntentEntry {
  /** 关键词/短语 */
  keywords: string[];
  /** 正则表达式（可选） */
  patterns?: RegExp[];
}

/**
 * 意图词典
 */
export type IntentDictionary = Record<LongTermFactCategory, IntentEntry>;

// ============================================================================
// 扩展词典定义
// ============================================================================

/**
 * 身份/角色词典
 *
 * 匹配用户描述自己身份、职业、角色的表达
 */
const IDENTITY_ROLE_DICT: IntentEntry = {
  keywords: [
    // 中文 - 职业/身份
    '我是',
    '我叫',
    '我的职业',
    '我从事',
    '我在做',
    '我的工作',
    '作为一个',
    '作为一名',
    '身为',
    '职业是',
    '身份是',
    '工程师',
    '开发者',
    '设计师',
    '产品经理',
    '项目经理',
    '学生',
    '研究员',
    '教师',
    '老师',
    '讲师',
    '教授',
    '程序员',
    '码农',
    '前端',
    '后端',
    '全栈',
    '运维',
    '创业者',
    '自由职业',
    '博主',
    '写手',
    '作者',
    '经理',
    '总监',
    '主管',
    '负责人',
    '老板',
    '领导',
    '分析师',
    '咨询师',
    '顾问',
    '专家',
    // 中文 - 领域/行业
    '在...行业',
    '从事...工作',
    '做...的',
    '干...的',
    '互联网',
    '金融',
    '医疗',
    '教育',
    '游戏',
    '电商',
    // 英文
    'I am a',
    "I'm a",
    'my job',
    'my role',
    'I work as',
    'my profession',
    'my title',
    'I work in',
    'I work at',
    'I work for',
    'engineer',
    'developer',
    'designer',
    'manager',
    'student',
    'teacher',
    'professor',
    'researcher',
    'analyst',
    'consultant',
    'founder',
    'writer',
    'author',
    'frontend',
    'backend',
    'full-stack',
    'DevOps',
    'product manager',
    'project manager',
    'data scientist',
    'marketer',
    'operator',
  ],
  patterns: [
    /我是(.{1,15})(工程师|开发者|设计师|产品|经理|学生|研究员|老师|程序员)/,
    /我(的)?职业是/,
    /我在(.{2,20})(工作|上班|任职)/,
    /我(是)?做(.{2,15})的/,
    /从事(.{2,20})(行业|工作|领域|职业)/,
    /I('m| am) (a |an )?[\w\s]{2,30}(engineer|developer|designer|manager|student|teacher)/i,
    /I work (as|at|for)/i,
    /my (job|role|profession|title) is/i,
    /I work in (the )?[\w\s-]+ (industry|field|sector)/i,
    /as (a |an )?[\w\s-]{2,40}(engineer|developer|designer|manager|researcher|analyst|consultant|teacher|founder|writer)/i,
  ],
};

/**
 * 偏好/风格词典
 *
 * 匹配用户表达喜好、偏好、风格的内容
 */
const PREFERENCE_STYLE_DICT: IntentEntry = {
  keywords: [
    // 中文 - 喜欢/偏好
    '喜欢',
    '偏好',
    '偏爱',
    '更喜欢',
    '更爱',
    '最爱',
    '超爱',
    '迷上',
    '着迷',
    '痴迷',
    '沉迷',
    '热衷',
    '钟爱',
    '中意',
    '倾向',
    '习惯',
    '爱好',
    '兴趣',
    // 中文 - 不喜欢
    '不喜欢',
    '讨厌',
    '反感',
    '不爱',
    '不想',
    '不要',
    '烦',
    '嫌',
    '受不了',
    '不习惯',
    '不太喜欢',
    // 中文 - 风格/方式
    '希望你',
    '请你',
    '请用',
    '请以',
    '麻烦你',
    '简洁',
    '详细',
    '简短',
    '长一点',
    '短一点',
    '不要太长',
    '不要太短',
    '精简',
    '概括',
    '随意',
    '轻松',
    '正式',
    '严肃',
    '有趣',
    '幽默',
    // 中文 - 口语化
    '还行',
    '不错',
    '可以',
    '好喜欢',
    '太喜欢了',
    '挺好',
    '蛮好',
    '很棒',
    '爱了',
    '绝了',
    // 英文
    'I like',
    'I love',
    'I prefer',
    'I enjoy',
    'I hate',
    'I dislike',
    "I'm into",
    "I'm fond of",
    "I'm a fan of",
    'please be',
    'please use',
    'I want',
    "I'd like",
    'please keep',
    'please avoid',
    'I prefer that you',
    'I would rather',
    "I can't stand",
    'I lean toward',
    'favorite',
    'favourite',
    'concise',
    'detailed',
    'brief',
    'short',
    'long',
    'formal',
    'casual',
    'friendly',
    'structured',
    'step-by-step',
    'bullet points',
    'shorter',
    'longer',
  ],
  patterns: [
    /我(喜欢|偏好|更喜欢|偏爱|超爱|迷上|着迷|热衷)/,
    /我(不喜欢|讨厌|反感|不爱|不想要)/,
    /(最近)?我(迷上|爱上|喜欢上|看上)了?/,
    /请?(用|以|按)(.{2,20})(方式|风格|格式|语气)/,
    /(不要|别)(回复?|说|写)(得?)(太)(长|短|复杂|简单)/,
    /我(比较|更|很|太|特别|非常|超)(喜欢|爱|偏爱)/,
    /我(觉得|认为|感觉)(.{2,15})(更好|不错|很棒)/,
    /I (like|love|prefer|enjoy|hate|dislike)/i,
    /I('m| am) (into|fond of|a fan of)/i,
    /please (be|use|keep|make)/i,
    /I prefer (that )?you/i,
    /I (would rather|can't stand|lean toward)/i,
    /please (avoid|don't|do not|never)(.{2,40})/i,
    /keep (it|your answer|responses?) (brief|concise|short|detailed|structured)/i,
  ],
};

/**
 * 长期目标词典
 *
 * 匹配用户表达目标、计划、方向的内容
 */
const LONG_TERM_GOAL_DICT: IntentEntry = {
  keywords: [
    // 中文 - 目标/计划
    '目标',
    '计划',
    '打算',
    '准备',
    '想要',
    '希望',
    '梦想',
    '愿望',
    '理想',
    '追求',
    '方向',
    // 中文 - 动作
    '学习',
    '研究',
    '开发',
    '创建',
    '完成',
    '实现',
    '准备',
    '备考',
    '考试',
    '考研',
    '考公',
    '跳槽',
    '转行',
    '创业',
    '上市',
    '融资',
    // 中文 - 时间
    '今年',
    '明年',
    '未来',
    '将来',
    '以后',
    '长远',
    '三年',
    '五年',
    '十年',
    // 英文
    'my goal',
    'my plan',
    'I want to',
    "I'm going to",
    'I aim to',
    'I intend to',
    "I'm preparing",
    "I'm working toward",
    'I plan on',
    'my objective',
    'career goal',
    'long-term',
    'this year',
    'next year',
    'in the future',
    'learn',
    'study',
    'develop',
    'build',
    'achieve',
    'launch',
    'ship',
    'publish',
    'graduate',
    'switch careers',
    'start a company',
    'startup',
    'fundraise',
  ],
  patterns: [
    /我(正在|在)?(.{2,30})(准备|学习|研究|开发|写)/,
    /我的(目标|计划|方向|梦想)是/,
    /我(想|要|打算|准备)(成为|达到|实现|学会|掌握)/,
    /(今年|明年|将来|以后|未来)我(要|想|打算|计划)/,
    /I('m| am) (preparing|studying|learning|building|working on)/i,
    /my (goal|plan|objective|target) is/i,
    /I (want to|aim to|intend to|plan to)/i,
    /I('m| am) working toward/i,
    /I plan on (learning|building|launching|shipping|studying|switching)/i,
    /(this year|next year|in the future|long[- ]term) I (want|plan|aim|intend)/i,
  ],
};

/**
 * 知识水平词典
 *
 * 匹配用户描述自己知识水平、技能的内容
 */
const KNOWLEDGE_LEVEL_DICT: IntentEntry = {
  keywords: [
    // 中文 - 熟悉/精通
    '熟悉',
    '了解',
    '掌握',
    '精通',
    '擅长',
    '熟练',
    '会用',
    '会写',
    '知道',
    '懂',
    '明白',
    '专业',
    '专长',
    '强项',
    '拿手',
    // 中文 - 不熟悉
    '不熟悉',
    '不了解',
    '不太懂',
    '不会',
    '不擅长',
    '小白',
    '新手',
    '初学',
    '刚入门',
    '菜鸟',
    // 中文 - 不需要解释
    '不用解释',
    '不需要说明',
    '我知道',
    '我了解',
    '这个我懂',
    '这我知道',
    '我清楚',
    // 英文
    'I know',
    'I understand',
    "I'm familiar with",
    "I'm experienced in",
    "I'm proficient in",
    'I already know',
    'no need to explain',
    'skip the basics',
    "I'm skilled in",
    "I'm comfortable with",
    "I don't know",
    "I'm new to",
    "I'm a beginner",
    "I'm not familiar with",
    'I have not used',
  ],
  patterns: [
    /我(熟悉|了解|掌握|精通|擅长|会用|会写)/,
    /我(不太?熟悉|不了解|不太?懂|不会|不擅长)/,
    /(你)?不(需要|用)(解释|说明|介绍)(.{2,15})(了)?/,
    /我(是)?(.{2,10})(小白|新手|初学者|菜鸟)/,
    /(.{2,15})(我)?(很熟|很懂|很清楚)/,
    /I('m| am) (familiar|experienced|proficient|skilled) (with|in)/i,
    /I (know|understand|don't know)/i,
    /I('m| am) (new to|a beginner in)/i,
    /(no need to explain|skip the basics|I already know)/i,
    /I('m| am) not familiar with/i,
    /I have(n't| not) used/i,
  ],
};

/**
 * 交互信号词典
 *
 * 匹配用户表达稳定环境和习惯的内容，同时外延捕获隐含模式、转折信号、
 * 反复强调、未决张力等不易归类但值得记住的交互观察。
 *
 * 内容分两大组：
 * 1. 原有稳定上下文词条（语言/时区/工具环境等）
 * 2. 新增开放性信号词条（隐含模式/转折信号/重复强调等）
 */
const INTERACTION_SIGNALS_DICT: IntentEntry = {
  keywords: [
    // 一、原稳定上下文词条（语言/时区/工具）
    '用中文',
    '用英文',
    '说中文',
    '说英语',
    '中文交流',
    '英文沟通',
    '时区',
    '在北京',
    '在上海',
    '在美国',
    '在国外',
    '远程',
    '在家',
    '办公室',
    '用Mac',
    '用Windows',
    '用Linux',
    '用VS Code',
    '用Vim',
    '用Cursor',
    '通常',
    '一般',
    '平时',
    '每天',
    '每周',
    '习惯',
    '日常',
    '固定',
    '总是',
    'I use',
    'I speak',
    'in Chinese',
    'in English',
    'my timezone',
    'time zone',
    'based in',
    'working from',
    'remote',
    'office',
    'home office',
    'I use VS Code',
    'I use Cursor',
    'I use macOS',
    'I use Windows',
    'I use Linux',
    'usually',
    'always',
    'every day',
    'most days',
    'typically',

    // 二、隐含模式信号（反复强调/骨子里的执念）
    // 识别"每次/一直/始终如一"class 的持续倾向
    '每次都',
    '每次我',
    '一直都是',
    '一直以来',
    '一直在意',
    '始终',
    '每次所以',
    '从来都',
    '每次话到',
    '沿用',
    'every time',
    'always been',
    'consistently',
    'repeatedly',
    'I keep running into',
    'I keep coming back to',
    'I struggle with',

    // 三、转折信号（隐含反对/探索边界）
    // "但是/却/只是"后接的内容往往资射了真实边界
    '但我就是',
    '但我就想',
    '但就是',
    '却总是',
    '却还是',
    '只是我',
    '其实我',
    '其实这',
    '才是我真正',
    'but I still',
    'but actually',
    'however I',
    'yet I',
    'the truth is',
    'what I really want',
    'what I actually need',

    // 四、重复强调类（多次说过的大原则）
    '之前说过',
    '我反复说',
    '我多次提到',
    '我一再强调',
    '这点很重要',
    '不知道为什么总是',
    '我对这个反感',
    '我对这个怪',
    '总是会',
    'I keep saying',
    "I've mentioned",
    'I always end up',
    'somehow I always',
    'as I said before',
    'this matters to me',
    'important to me',

    // 五、未决张力类（反复消耗的取舍权衡）
    // "还是...vs..." "一直在想..."这类悬置状态有价值
    '这个问题一直',
    '我也不确定',
    '在两者之间',
    '还在初定',
    '一直在纠结',
    '径渭不明',
    '一方面...一方面',
    '到底该',
    '起迟不决',
    'still undecided',
    'torn between',
    'on the fence',
    'not sure whether',
    "haven't decided",
    'weighing whether',
    'choosing between',
  ],
  patterns: [
    // 语言/地区环境
    /我(使用|用|说)(中文|英文|日文|英语|中文)/,
    /我(在|位于)(.{2,15})(时区)?/,
    /我(通常|一般|平时|习惯)(在|用|做)/,
    /每(天|周|月|年)我(都|会)/,
    /I (use|speak|prefer) (Chinese|English)/i,
    /I('m| am) (in|located in|based in)/i,
    /I (usually|always|often|typically)/i,
    /I (work|am working) from/i,
    /my (timezone|time zone) is/i,

    // 每次都 / 一直 类强调模式
    /我每次(都|会|总)(.{2,20})/,
    /我一直(都|在|会)(.{2,20})/,
    /始终没法(.{2,20})/,
    /总是不自觉(.{2,20})/,
    /I (always|consistently|repeatedly|keep) (.{2,30})/i,
    /I keep (running into|coming back to|struggling with) (.{2,40})/i,

    // 但是/却 转折模式（探索弹性边界）
    /但(我|这)(\u5c31\u662f|\u5c31\u60f3|\u5374|\u8fd8\u662f)(.{2,20})/,
    /其实我(更|还是|就是|希望)(.{2,20})/,
    /才是我真正(想|需要|关心)(.{1,15})/,
    /but (I still|I actually|the truth is) (.{2,30})/i,
    /(what I really want|what I actually need) (is|to)/i,

    // 未决张力 / 取舍权衡
    /(一方面|常常)(.{2,20})(一方面|又)(.{2,20})/,
    /这个(问题|决定)(一直|还)找不到/,
    /(torn between|still undecided about|not sure (whether|if)) (.{2,30})/i,
    /(haven't decided|weighing whether|choosing between) (.{2,40})/i,
  ],
};

// ============================================================================
// 导出词典
// ============================================================================

/**
 * 完整意图词典（6 类用户事实）
 */
export const INTENT_DICTIONARY: IntentDictionary = {
  identity_role: IDENTITY_ROLE_DICT,
  preference_style: PREFERENCE_STYLE_DICT,
  long_term_goal: LONG_TERM_GOAL_DICT,
  knowledge_level: KNOWLEDGE_LEVEL_DICT,
  interaction_signals: INTERACTION_SIGNALS_DICT,
  // 任务经验不走候选扫描流水线（由 Agent Loop 直写），空占位保持类型完整性
  task_experience: { keywords: [] },
};

// ============================================================================
// 匹配工具函数
// ============================================================================

/**
 * 匹配结果
 */
export interface MatchResult {
  /** 是否匹配 */
  matched: boolean;
  /** 匹配的类别 */
  category: LongTermFactCategory | null;
  /** 匹配的关键词/模式 */
  matchedTerm: string | null;
  /** 匹配置信度 (0-1) */
  confidence: number;
}

/**
 * 在文本中匹配意图
 *
 * @param text - 待匹配文本
 * @param targetCategory - 指定匹配的类别（可选，不指定则匹配所有类别）
 * @returns 匹配结果
 */
export function matchIntent(text: string, targetCategory?: LongTermFactCategory): MatchResult {
  const lowerText = text.toLowerCase();
  const categories = targetCategory
    ? [targetCategory]
    : (Object.keys(INTENT_DICTIONARY) as LongTermFactCategory[]);

  for (const category of categories) {
    const entry = INTENT_DICTIONARY[category];

    // 1. 关键词匹配
    for (const keyword of entry.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        return {
          matched: true,
          category,
          matchedTerm: keyword,
          confidence: 0.7,
        };
      }
    }

    // 2. 正则匹配
    if (entry.patterns) {
      for (const pattern of entry.patterns) {
        const match = text.match(pattern);
        if (match) {
          return {
            matched: true,
            category,
            matchedTerm: match[0],
            confidence: 0.9,
          };
        }
      }
    }
  }

  return {
    matched: false,
    category: null,
    matchedTerm: null,
    confidence: 0,
  };
}

/**
 * 批量匹配多个类别
 *
 * @param text - 待匹配文本
 * @returns 所有匹配到的类别及其置信度
 */
export function matchAllIntents(text: string): Array<{
  category: LongTermFactCategory;
  matchedTerm: string;
  confidence: number;
}> {
  const results: Array<{
    category: LongTermFactCategory;
    matchedTerm: string;
    confidence: number;
  }> = [];

  const lowerText = text.toLowerCase();

  for (const category of Object.keys(INTENT_DICTIONARY) as LongTermFactCategory[]) {
    const entry = INTENT_DICTIONARY[category];

    // 关键词匹配
    for (const keyword of entry.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        results.push({
          category,
          matchedTerm: keyword,
          confidence: 0.7,
        });
        break; // 每个类别只记录一次
      }
    }

    // 正则匹配（更高置信度）
    if (entry.patterns) {
      for (const pattern of entry.patterns) {
        const match = text.match(pattern);
        if (match) {
          // 更新为正则匹配结果（如果已存在关键词匹配）
          const existingIndex = results.findIndex((r) => r.category === category);
          if (existingIndex >= 0) {
            results[existingIndex] = {
              category,
              matchedTerm: match[0],
              confidence: 0.9,
            };
          } else {
            results.push({
              category,
              matchedTerm: match[0],
              confidence: 0.9,
            });
          }
          break;
        }
      }
    }
  }

  return results;
}

/**
 * 获取指定类别的所有关键词（用于调试）
 */
export function getCategoryKeywords(category: LongTermFactCategory): string[] {
  return INTENT_DICTIONARY[category].keywords;
}

/**
 * 获取词典统计信息
 */
export function getDictionaryStats(): Record<
  LongTermFactCategory,
  {
    keywordCount: number;
    patternCount: number;
  }
> {
  const stats = {} as Record<LongTermFactCategory, { keywordCount: number; patternCount: number }>;

  for (const category of Object.keys(INTENT_DICTIONARY) as LongTermFactCategory[]) {
    const entry = INTENT_DICTIONARY[category];
    stats[category] = {
      keywordCount: entry.keywords.length,
      patternCount: entry.patterns?.length ?? 0,
    };
  }

  return stats;
}

// ============================================================================
// 记忆命令关键词（统一来源）
// ============================================================================

/**
 * 记忆命令关键词 - 用户明确的记忆指令
 *
 * 作为 MemoryTriggerManager 和 MemoryCandidateScanner 的统一来源
 * 分类来源：docs/用户确认改进.txt
 */
export const MEMORY_COMMAND_KEYWORDS = [
  // === 直接记忆指令 ===
  '记住这个',
  '记住这点',
  '请记住',
  '你记住',
  '要记住',
  '你要记住',
  '得记住',
  '可要记住',
  '一定要记住',
  '务必记住',
  '千万要记住',
  'remember this',
  'please remember',
  'keep in mind',
  "don't forget",
  'make a note of this',
  'save this memory',

  // === 口语化存储请求 ===
  '帮我记下',
  '存一下',
  '录入一下',
  '留个底',
  '备注一下',
  '做个笔记',
  '记在心里',
  '别丢了这段',
  'save this',
  'note down',
  'take a note',
  'log this',
  'jot this down',
  'mark this',
  'write this down',
  'store this',
  'record this',

  // === 时效与未来参考类（暗示记忆） ===
  '以后你要记得',
  '下次我问你时',
  '以后就按这个来',
  '从现在起',
  '长期记住',
  '这对我以后很重要',
  '以后都',
  'for future reference',
  'from now on',
  'next time I ask',
  'always remember',
  'keep this for later',
  'remember this later',
  'use this going forward',

  // === 强调重要性类（侧面暗示需要记忆） ===
  '这是重点',
  '划重点',
  '这个很重要',
  '你要注意这点',
  '关键点是',
  'this is important',
  'key point',
  'pay attention to this',
  'crucial information',
  'important to remember',
  'please note',
];

/**
 * 确认词 - 表示用户肯定确认
 *
 * 用于 MemoryCandidateScanner 检测用户确认
 */
export const CONFIRMATION_KEYWORDS = [
  '对的',
  '对',
  '是的',
  '没错',
  '正确',
  '就是这样',
  'yes',
  'right',
  'correct',
  'exactly',
  'that is right',
  "that's right",
  'yep',
  'yeah',
];

/**
 * 伪记忆请求正则 - 过滤非存储意图的表达
 *
 * 避免误触场景：
 * - 疑问句：你记住了吗？Did you remember?
 * - 否定句：不用记这个、别记了
 * - 引用过去：你还记得那天吗？
 */
export const PSEUDO_MEMORY_PATTERNS = [
  // 疑问句（在检查记忆，不是创建）
  /你(还)?记(住|得)(.{0,10})了?(吗|没|么)[？?]/,
  /(did|do) you remember/i,
  /你(能|可以)?记(得|住)吗/,

  // 否定句（不希望记住）
  /(不用|别|不要|不需要)(记|存|备注)(这个|这点|了)?/,
  /don't (remember|save|note)/i,
  /do not (remember|save|note|store)/i,
  /no need to (remember|save|note|store)/i,

  // 引用过去（检索记忆）
  /你(还)?记(得|住)(.{2,20})(那天|那次|之前|上次)/,
];

/**
 * 偏好约束正则 - 捕获用户偏好/约束表达
 *
 * 设计原则：使用组合匹配避免泛化误触发
 * - 「请务必」+ 记忆/注意动词
 * - 「请勿」+ 内容 → 表达约束偏好
 * - 「以后请」+ 内容 → 长期约束
 */
export const PREFERENCE_CONSTRAINT_PATTERNS = [
  // 请务必 + 记忆/注意类动词
  /请务必(.{2,30})(记住|注意|遵守|保持|确保)/,

  // 请勿 + 内容 → 否定偏好（如：请勿使用中文注释）
  /请勿(.{2,30})/,

  // 以后请/今后请 + 内容 → 长期约束
  /(以后|今后)请(你)?(.{2,30})/,

  // 每次都要/每次请 + 内容 → 重复约束
  /每次(都要|请|都)(.{2,30})/,

  // 永远不要/绝对不要 + 内容 → 强否定约束
  /(永远|绝对|千万)(不要|别|不)(.{2,30})/,

  // 英文约束表达
  /please (always|never|make sure to|don't)(.{2,40})/i,
  /please (avoid|do not|don't)(.{2,40})/i,
  /I prefer (that )?you (always|never|avoid|use|keep)(.{2,40})/i,
  /make sure to (always|never|avoid|use|keep)(.{2,40})/i,
  /from now on,? (always|never|please)(.{2,40})/i,
];
