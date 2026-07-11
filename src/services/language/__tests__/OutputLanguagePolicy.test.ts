import { describe, expect, it } from 'vitest';
import {
  buildOutputLanguageContract,
  buildSourceLanguagePreservationContract,
  detectSourceLanguage,
  resolveOutputLanguage,
} from '../OutputLanguagePolicy';

describe('OutputLanguagePolicy', () => {
  it('lets an explicit Chinese translation target override a long Japanese quotation', () => {
    const request =
      '请帮我翻译‘最新のmacOSにインスパイアされて、美しいデスクトップとUIを備えたモダンなブラウザ内オペレーティングシステムを作成する。時計、ボトムドック、およびゲームを含める。’这一段为中文';

    const hint = resolveOutputLanguage(request, { useRuntimePreference: false });

    expect(hint.tag).toBe('zh-CN');
    expect(hint.label).toBe('Simplified Chinese');
    expect(hint.source).toBe('explicit_target');
  });

  it('uses the Chinese instruction shell instead of Japanese quoted content', () => {
    const request =
      '请分析“最新のmacOSに触発されたブラウザベースのOSを作成してください。”的技术风险';

    const hint = resolveOutputLanguage(request, { useRuntimePreference: false });

    expect(hint.tag).toBe('zh-CN');
    expect(hint.source).toBe('request_language');
  });

  it('distinguishes Traditional Chinese from the shared Han character set', () => {
    const request = `使用 Agent SDK strands-agents/harness-sdk（本地 Python 版本需 ≥ 3.13），快速構建一個基於瀏覽器的代理應用程式。該代理必須具備讀寫能力。使用者介面應採用三欄布局：左欄用於基本任務對話列表，中欄用於發送訊息和聊天預覽，右欄用於預覽已傳送的檔案。
在此應用程式中，當使用者發送任務訊息時，代理程式應執行該任務，且其寫入或生成的任何檔案都必須能在使用者介面內預覽。連接後，讓代理程式執行一項任務，且生成的檔案必須保存在本地。
任務 A：受最新 macOS 的啟發，創建一個現代化、基於瀏覽器的作業系統，擁有美觀的桌面和用戶介面。它必須包含系統狀態彈出視窗、時鐘、底部程式欄，以及一個內置的互動式太空射擊遊戲。`;

    const requestHint = resolveOutputLanguage(request, {
      useRuntimePreference: false,
    });
    const sourceHint = detectSourceLanguage(request);

    expect(requestHint.tag).toBe('zh-TW');
    expect(requestHint.label).toBe('Traditional Chinese');
    expect(sourceHint.tag).toBe('zh-TW');
  });

  it('distinguishes Simplified Chinese when its variant evidence clearly leads', () => {
    const request = '请分析这份用户界面报告，并说明生成文件、系统状态和任务执行方面的风险。';

    const hint = resolveOutputLanguage(request, { useRuntimePreference: false });

    expect(hint.tag).toBe('zh-CN');
    expect(hint.label).toBe('Simplified Chinese');
  });

  it('keeps variant-neutral Chinese generic instead of guessing a writing system', () => {
    const hint = resolveOutputLanguage('你好世界，春夏秋冬。', {
      useRuntimePreference: false,
    });

    expect(hint.tag).toBe('zh');
    expect(hint.label).toBe('Chinese');
  });

  it.each([
    ['請用中文回答這個問題。', 'zh-TW', 'Traditional Chinese'],
    ['请用中文回答这个问题。', 'zh-CN', 'Simplified Chinese'],
    ['Please answer this question in Chinese.', 'zh', 'Chinese'],
  ])(
    'refines a generic Chinese target only when the request supplies variant evidence',
    (request, expectedTag, expectedLabel) => {
      const hint = resolveOutputLanguage(request, { useRuntimePreference: false });

      expect(hint.tag).toBe(expectedTag);
      expect(hint.label).toBe(expectedLabel);
      expect(hint.source).toBe('explicit_target');
    }
  );

  it('detects a direct Japanese request when there is no outer instruction shell', () => {
    const hint = resolveOutputLanguage(
      '最新のmacOSに触発されたブラウザベースのOSを作成してください。',
      { useRuntimePreference: false }
    );

    expect(hint.tag).toBe('ja');
    expect(hint.label).toBe('Japanese');
  });

  it('detects the full German technical request without treating task labels as English', () => {
    const request = `Mit dem Agent SDK strands-agents/harness-sdk (lokal Python >= 3.13) können Sie schnell eine browserbasierte Agentenanwendung erstellen. Der Agent muss Lese- und Schreibfähigkeiten haben. Die Benutzeroberfläche sollte eine dreisäulige Layout-Struktur aufweisen: die linke Spalte für eine grundlegende Aufgabenkonversationsliste, die mittlere Spalte für die Nachrichtenübermittlung und Chat-Vorschau und die rechte Spalte für die Vorschau von gelieferten Dateien.
In dieser Anwendung sollte der Agent eine von einem Benutzer gesendete Aufgabenmeldung ausführen, und alle von ihm geschriebenen/erzeugten Dateien müssen innerhalb der Benutzeroberfläche vorschaufähig sein. Sobald diese Anwendung erstellt ist, verbinden Sie sie direkt mit deepseek-v4-flash (verwenden Sie einen OpenAI-kompatiblen Protokollendpunkt). Auf meinem Computer habe ich einen Ordner namens deepseek_model (der die URL und den API-Schlüssel enthält). Nach der Verbindung sollte der Agent eine Aufgabe ausführen. Die Aufgabe, die dem Agenten zugewiesen werden soll, ist "Aufgabe A", und die generierten Dateien müssen lokal gespeichert werden.

Aufgabe A: Inspiriert von der neuesten macOS-Version, erstellen Sie ein modernes, browserbasiertes Betriebssystem mit einem schönen Desktop und einer benutzerfreundlichen Oberfläche. Es muss Systemstatus-Toast-Nachrichten, eine Uhr, ein unteres Dock und ein eingebettetes interaktives 3D-Raumschiffspiel enthalten.`;

    const requestHint = resolveOutputLanguage(request, {
      useRuntimePreference: false,
    });
    const sourceHint = detectSourceLanguage(request);

    expect(requestHint.tag).toBe('de');
    expect(requestHint.label).toBe('German');
    expect(requestHint.source).toBe('request_language');
    expect(sourceHint.tag).toBe('de');
    expect(sourceHint.source).toBe('source_language');
  });

  it.each([
    ['en', 'Please answer the following question and explain your result in clear language.'],
    ['de', 'Bitte beantworten Sie die folgende Frage und erklären Sie das Ergebnis verständlich.'],
    ['fr', 'Veuillez répondre à la question suivante et expliquer clairement le résultat.'],
    ['es', 'Por favor, responda la siguiente pregunta y explique claramente el resultado.'],
    ['pt', 'Por favor, responda à pergunta seguinte e explique claramente o resultado.'],
    ['it', 'Per favore, rispondi alla domanda seguente e spiega chiaramente il risultato.'],
    ['nl', 'Beantwoord alstublieft de volgende vraag en leg het resultaat duidelijk uit.'],
    ['pl', 'Proszę odpowiedzieć na następujące pytanie i wyjaśnić wynik.'],
    ['tr', 'Lütfen aşağıdaki soruyu yanıtlayın ve sonucu açıkça açıklayın.'],
    ['vi', 'Vui lòng trả lời câu hỏi sau và giải thích kết quả rõ ràng.'],
    ['id', 'Silakan jawab pertanyaan berikut dan jelaskan hasilnya dengan jelas.'],
  ])('uses distinct weighted evidence to detect %s', (expectedTag, request) => {
    const hint = resolveOutputLanguage(request, { useRuntimePreference: false });

    expect(hint.tag).toBe(expectedTag);
    expect(hint.source).toBe('request_language');
  });

  it('uses a German instruction prefix before a pasted English source block', () => {
    const hint = resolveOutputLanguage(
      'Bitte analysieren Sie den folgenden Text: Please create a browser agent with files, UI, and an API.',
      { useRuntimePreference: false }
    );

    expect(hint.tag).toBe('de');
    expect(hint.source).toBe('request_language');
  });

  it('keeps Latin-script technical noise at low confidence instead of guessing English', () => {
    const hint = resolveOutputLanguage(
      'Agent SDK Python OpenAI API browser UI macOS JSON HTTP localhost WebView Terminal Finder',
      { useRuntimePreference: false }
    );

    expect(hint.tag).toBe('und-Latn');
    expect(hint.label).toContain('Latin-script language');
  });

  it('recognizes an English explicit output-language directive', () => {
    const hint = resolveOutputLanguage(
      'Translate the following Japanese product brief into Korean: 「新しい製品を作る」',
      { useRuntimePreference: false }
    );

    expect(hint.tag).toBe('ko');
    expect(hint.source).toBe('explicit_target');
  });

  it('recognizes a target language written in Japanese', () => {
    const hint = resolveOutputLanguage('日本語の文章を中国語に翻訳してください。', {
      useRuntimePreference: false,
    });

    expect(hint.tag).toBe('zh');
    expect(hint.source).toBe('explicit_target');
  });

  it('keeps a quoted target language while ignoring quoted source content', () => {
    const hint = resolveOutputLanguage('Translate the source into "French": 「新しい製品を作る」', {
      useRuntimePreference: false,
    });

    expect(hint.tag).toBe('fr');
    expect(hint.source).toBe('explicit_target');
  });

  it('treats a negated language as an exclusion instead of a target', () => {
    const hint = resolveOutputLanguage('请不要用英文回答。', {
      useRuntimePreference: false,
    });
    const contract = buildOutputLanguageContract(hint);

    expect(hint.tag).toBe('zh');
    expect(hint.source).toBe('request_language');
    expect(hint.excludedLanguages).toEqual([{ tag: 'en', label: 'English' }]);
    expect(contract).toContain('Explicitly forbidden output languages: English');
  });

  it('treats a generic Chinese exclusion as covering both writing variants', () => {
    const hint = resolveOutputLanguage('請不要用中文回答。', {
      preferredLanguageTags: ['en-US'],
    });

    expect(hint.tag).toBe('en-US');
    expect(hint.source).toBe('runtime_preference');
    expect(hint.excludedLanguages).toEqual([{ tag: 'zh', label: 'Chinese' }]);
  });

  it('uses a non-excluded runtime language when the request language is forbidden', () => {
    const hint = resolveOutputLanguage('Please do not answer in English.', {
      preferredLanguageTags: ['en-US', 'zh-CN'],
    });

    expect(hint.tag).toBe('zh-CN');
    expect(hint.source).toBe('runtime_preference');
    expect(hint.excludedLanguages).toEqual([{ tag: 'en', label: 'English' }]);
  });

  it('lets a later affirmative target override an earlier exclusion', () => {
    const hint = resolveOutputLanguage('Do not answer in English; answer in Chinese.', {
      useRuntimePreference: false,
    });

    expect(hint.tag).toBe('zh');
    expect(hint.source).toBe('explicit_target');
    expect(hint.excludedLanguages).toEqual([{ tag: 'en', label: 'English' }]);
  });

  it('handles Japanese and Korean exclusion grammar without negating the following target', () => {
    const japaneseHint = resolveOutputLanguage('英語ではなく中国語で回答してください。', {
      useRuntimePreference: false,
    });
    const koreanHint = resolveOutputLanguage('영어 말고 중국어로 답변해 주세요.', {
      useRuntimePreference: false,
    });

    for (const hint of [japaneseHint, koreanHint]) {
      expect(hint.tag).toBe('zh');
      expect(hint.source).toBe('explicit_target');
      expect(hint.excludedLanguages).toEqual([{ tag: 'en', label: 'English' }]);
    }
  });

  it('uses the instruction prefix before an unquoted pasted source block', () => {
    const hint = resolveOutputLanguage(
      '请分析以下日文内容：最新のmacOSに触発されたOSを作成してください。',
      { useRuntimePreference: false }
    );

    expect(hint.tag).toBe('zh-CN');
    expect(hint.source).toBe('request_language');
  });

  it('uses an injected runtime preference only when request language is unclear', () => {
    const hint = resolveOutputLanguage('OK?', {
      preferredLanguageTags: ['ja-JP', 'en-US'],
    });

    expect(hint.tag).toBe('ja-JP');
    expect(hint.label).toBe('Japanese');
    expect(hint.source).toBe('runtime_preference');
  });

  it('keeps explicit targets above runtime preferences', () => {
    const hint = resolveOutputLanguage('请用英文回答。', {
      preferredLanguageTags: ['zh-CN'],
    });

    expect(hint.tag).toBe('en');
    expect(hint.source).toBe('explicit_target');
  });

  it('builds reusable output and source-preservation contracts', () => {
    const hint = resolveOutputLanguage('Please answer this question in English.', {
      useRuntimePreference: false,
    });
    const outputContract = buildOutputLanguageContract(hint, {
      fields: ['summary', 'response'],
    });
    const preservationContract = buildSourceLanguagePreservationContract('这是原始报告。');

    expect(outputContract).toContain('[OUTPUT_LANGUAGE]');
    expect(outputContract).toContain('`summary`, `response`');
    expect(preservationContract).toContain('Source Language Preservation');
    expect(preservationContract).toContain('Chinese');
    expect(preservationContract).toContain('Simplified/Traditional writing variant');
  });

  it('detects source language independently from output directives and runtime locale', () => {
    const sourceHint = detectSourceLanguage('这是中文报告，并引用「新しいUIを作る」作为原始术语。');
    const unknownContract = buildSourceLanguagePreservationContract('OK');

    expect(sourceHint.tag).toBe('zh-CN');
    expect(sourceHint.source).toBe('source_language');
    expect(unknownContract).toContain('No reliable source-language signal was detected');
    expect(unknownContract).not.toContain('latest request');
  });
});
