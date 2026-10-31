/* ============================================================
   词感 WordSense — 应用主逻辑
   首页 / 词库 / 错词本 / 刷词会话 / 结算 / 设置 / 数据导入导出
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };
  var DAY = 86400000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function fmtClock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function weekdayCN(d) { return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]; }
  function dateCN(d) { return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function todayKey() { return dayKey(Date.now()); }

  var TTS_OK = typeof window !== 'undefined' && 'speechSynthesis' in window;

  function canSpeak() {
    return !!(window.AndroidBridge && typeof window.AndroidBridge.speak === 'function') || TTS_OK;
  }

  /* ---------------- 数据装配 ---------------- */
  var RAW = (window.VOCAB_DATA && window.VOCAB_DATA.banks) || [];
  var GLOSSES = (window.VOCAB_DATA && window.VOCAB_DATA.glosses) || [];
  var BANKS = RAW.map(function (b) {
    return { id: b.id, name: b.name, sub: b.sub, desc: b.desc, color: b.color || '#0f8f6f', words: b.words || [] };
  });
  var WORDS = [];
  var BY_ID = {};
  var DICT = {};

  function rebuildIndex() {
    WORDS.length = 0;
    BY_ID = {};
    DICT = {};
    var byWord = {};
    BANKS.forEach(function (b) {
      var list = [];
      (b.words || []).forEach(function (raw) {
        var key = String(raw.w || '').toLowerCase();
        if (!key) return;
        // 自定义词库即使和内置词重名也保留独立条目
        var canShare = b.id !== 'my';
        var item = canShare ? byWord[key] : null;
        if (!item) {
          item = {
            id: raw.id || (b.id + ':' + key),
            w: raw.w, ph: raw.ph || '', pos: raw.pos || '', zh: raw.zh || '',
            ex: raw.ex || '', exzh: raw.exzh || '',
            bankId: b.id, bankName: b.name, color: b.color,
            banks: [b.id], bankNames: [b.name]
          };
          if (canShare) byWord[key] = item;
          WORDS.push(item);
          BY_ID[item.id] = item;
          if (!DICT[key]) DICT[key] = item;
        } else {
          if (item.banks.indexOf(b.id) < 0) {
            item.banks.push(b.id);
            item.bankNames.push(b.name);
          }
        }
        list.push(item);
      });
      b.words = list;
    });
    WORDS.forEach(function (w) {
      if (w.banks && w.banks.length > 1) w.bankName = w.bankNames.join(' / ');
    });
    // 基础词释义：只用于句中点击查词，不进入学习队列
    GLOSSES.forEach(function (g) {
      var key = String(g.w || '').toLowerCase();
      if (!key || DICT[key] || !g.zh) return;
      DICT[key] = { w: key, ph: '', pos: g.pos || '', zh: g.zh, bankName: '基础词' };
    });
  }
  rebuildIndex();

  var store = Store();

  /* 自定义词库 */
  function customBank() {
    var words = store.getCustom().map(function (w) {
      return {
        id: 'my:' + String(w.w).toLowerCase(),
        w: w.w, ph: w.ph || '', pos: w.pos || '', zh: w.zh || '',
        ex: w.ex || '', exzh: w.exzh || ''
      };
    });
    return { id: 'my', name: '我的词库', sub: 'CUSTOM', desc: '自己导入的单词', color: '#8b5cf6', words: words };
  }

  function refreshBanks() {
    var my = customBank();
    var idx = BANKS.findIndex(function (b) { return b.id === 'my'; });
    if (my.words.length) {
      if (idx >= 0) BANKS[idx] = my; else BANKS.push(my);
    } else if (idx >= 0) {
      BANKS.splice(idx, 1);
    }
    rebuildIndex();
  }
  refreshBanks();

  function bankById(id) { return BANKS.find(function (b) { return b.id === id; }); }
  function poolOf(bankIds) {
    if (!bankIds || bankIds === 'all') return WORDS.slice();
    var set = {};
    [].concat(bankIds).forEach(function (id) { set[id] = true; });
    return WORDS.filter(function (w) { return set[w.bankId]; });
  }
  var libMode = 'read';
  function modeKey(id, mode) { return (mode || 'read') + ':' + id; }
  function activeMode() {
    if (state && state.session && state.session.style) return state.session.style;
    return libMode;
  }
  function cardOf(id, mode) { return store.getCard(modeKey(id, mode || activeMode())); }
  function isDueWord(w, now, mode) {
    var c = cardOf(w.id, mode);
    return !!c && c.reps > 0 && SRS.isDue(c, now || Date.now());
  }
  function isNewWord(w, mode) { return !store.hasCard(modeKey(w.id, mode || activeMode())); }
  function wordStatus(w, mode) {
    var c = cardOf(w.id, mode);
    return c ? SRS.statusOf(c) : 'new';
  }

  /* ---------------- 轻提示 / 弹窗 ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  var modalOpen = false;
  function openModal(html) {
    var root = $('#modalRoot');
    $('.modal', root).innerHTML = html;
    root.hidden = false;
    modalOpen = true;
    var first = $('.modal input:not([type="range"]):not([type="file"]), .modal textarea', root);
    if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 60);
    return $('.modal', root);
  }
  function closeModal() {
    var root = $('#modalRoot');
    root.hidden = true;
    $('.modal', root).innerHTML = '';
    modalOpen = false;
  }
  $('#modalRoot').addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) closeModal();
  });

  function confirmAction(title, text, okLabel, onOk, danger) {
    openModal(
      '<button class="icon-btn modal-close" data-close aria-label="关闭">✕</button>' +
      '<h2>' + esc(title) + '</h2><p class="modal-sub">' + esc(text) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" data-close>取消</button>' +
      '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" id="confirmOk">' + esc(okLabel || '确定') + '</button>' +
      '</div>'
    );
    $('#confirmOk').addEventListener('click', function () {
      closeModal();
      onOk();
    });
  }

  /* ---------------- 主题 ---------------- */
  function resolvedTheme() {
    var t = store.settings.theme;
    if (!t || t === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return t;
  }
  function applyTheme() {
    var t = resolvedTheme();
    document.documentElement.dataset.theme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1411' : '#f4f2ed');
    renderTtsBtn();
  }
  $('#themeBtn').addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.setSetting('theme', next);
    applyTheme();
  });
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (store.settings.theme === 'auto') applyTheme();
      });
    } catch (e) {}
  }

  /* ---------------- 发音与音效 ---------------- */
  var voices = [];
  function loadVoices() {
    if (!TTS_OK) return;
    try {
      voices = window.speechSynthesis.getVoices() || [];
      window.speechSynthesis.onvoiceschanged = function () {
        voices = window.speechSynthesis.getVoices() || [];
      };
    } catch (e) { voices = []; }
  }
  loadVoices();

  var speakingBtn = null;
  var speakSeq = 0;
  var nativeOnEnd = null;

  function pickWebVoice() {
    var en = voices.filter(function (v) { return /^en([-_]|$)/i.test(v.lang || ''); });
    var prefs = [
      /Microsoft\s+(Aria|Jenny|Guy).*Natural/i,
      /Microsoft\s+(Aria|Jenny|Guy)/i,
      /Google\s+US\s+English/i,
      /Samantha/i,
      /Microsoft\s+(Zira|David)/i,
      /Natural/i
    ];
    for (var i = 0; i < prefs.length; i++) {
      var hit = en.find(function (v) { return prefs[i].test(v.name || ''); });
      if (hit) return hit;
    }
    var us = en.find(function (v) { return /en[-_]US/i.test(v.lang || ''); });
    return us || en[0] || voices[0] || null;
  }

  window.__onNativeTtsEnd = function () {
    if (speakingBtn) { speakingBtn.classList.remove('is-playing'); speakingBtn = null; }
    var cb = nativeOnEnd;
    nativeOnEnd = null;
    if (cb) cb();
  };

  var onlineAudio = null;
  var onlineTimer = null;

  function stopOnlineAudio() {
    if (onlineTimer) { clearTimeout(onlineTimer); onlineTimer = null; }
    if (onlineAudio) {
      try { onlineAudio.pause(); onlineAudio.currentTime = 0; } catch (e) { }
      onlineAudio = null;
    }
  }

  function onlineTtsUrl(text) {
    if (!store.settings.onlineTts) return '';
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var nativeProxy = !!window.AndroidBridge ||
      (location.hostname === '127.0.0.1' && location.search.indexOf('desktop=1') >= 0);
    // 网页版已移除；普通浏览器开发页直接走系统 TTS，避免跨域请求
    if (!nativeProxy) return '';
    var sentence = /\s/.test(t) || /[.!?;:]/.test(t) || t.length > 24;
    var kind = sentence ? 'baidu' : 'youdao';
    return '/__tts?kind=' + kind + '&text=' + encodeURIComponent(t);
  }

  function speakSystem(text, btn, o, seq, finish) {
    if (window.AndroidBridge && typeof window.AndroidBridge.speak === 'function') {
      try {
        if (speakingBtn) speakingBtn.classList.remove('is-playing');
        speakingBtn = btn || null;
        if (btn) btn.classList.add('is-playing');
        nativeOnEnd = finish;
        window.AndroidBridge.speak(String(text), Number(o.rate) || 0.9);
        return;
      } catch (e) { /* 退回 Web Speech */ }
    }
    if (!TTS_OK) { toast('当前设备不支持语音朗读'); finish(); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = Number(o.rate) || 0.92;
      u.pitch = 1;
      u.volume = 1;
      u.voice = pickWebVoice();
      if (speakingBtn) speakingBtn.classList.remove('is-playing');
      speakingBtn = btn || null;
      if (btn) btn.classList.add('is-playing');
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    } catch (e) { finish(); }
  }

  function speak(text, btn, opts) {
    var o = opts || {};
    var seq = ++speakSeq;
    var finished = false;
    function finish() {
      if (finished || seq !== speakSeq) return;
      finished = true;
      if (btn) {
        btn.classList.remove('is-playing');
        if (speakingBtn === btn) speakingBtn = null;
      }
      var cb = o.onend;
      o.onend = null;
      if (cb) cb();
    }

    stopOnlineAudio();
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { }
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.stop === 'function') window.AndroidBridge.stop();
    } catch (e) { }

    var url = onlineTtsUrl(text);
    if (url && typeof Audio !== 'undefined') {
      var audio;
      try { audio = new Audio(url); } catch (e) { audio = null; }
      if (audio) {
        onlineAudio = audio;
        audio.preload = 'auto';
        audio.playbackRate = (Number(o.rate) || 0.9) < 0.85 ? 0.72 : 1;
        if (speakingBtn) speakingBtn.classList.remove('is-playing');
        speakingBtn = btn || null;
        if (btn) btn.classList.add('is-playing');

        var fallback = function () {
          if (seq !== speakSeq || finished) return;
          if (onlineAudio === audio) stopOnlineAudio();
          if (btn) btn.classList.remove('is-playing');
          speakSystem(text, btn, o, seq, finish);
        };

        audio.onplaying = function () {
          if (onlineTimer) { clearTimeout(onlineTimer); onlineTimer = null; }
        };
        audio.onended = function () {
          if (seq !== speakSeq || finished) return;
          stopOnlineAudio();
          finish();
        };
        audio.onerror = fallback;
        onlineTimer = setTimeout(fallback, 6000);
        try {
          var p = audio.play();
          if (p && typeof p.catch === 'function') p.catch(fallback);
        } catch (e) { fallback(); }
        return;
      }
    }

    speakSystem(text, btn, o, seq, finish);
  }

  var actx = null;
  function tone(freq, dur, gain, type, delay) {
    if (!actx) return;
    var t0 = actx.currentTime + (delay || 0);
    var osc = actx.createOscillator();
    var g = actx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.05, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(actx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  function sfx(kind) {
    if (!store.settings.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      if (kind === 'ok') { tone(659.25, 0.09, 0.045); tone(987.77, 0.16, 0.04, 'sine', 0.075); }
      else if (kind === 'no') { tone(196, 0.16, 0.04, 'triangle'); tone(146.8, 0.22, 0.03, 'triangle', 0.1); }
      else { tone(880, 0.05, 0.02); }
    } catch (e) {}
  }

  /* ---------------- 首页 ---------------- */
  var TIPS = [
    '跟读不是念经：听一遍原声，注意重音和停顿，再读一遍时故意模仿它的节奏。',
    '句子里带红色的词是今天的主角，但整句的搭配才是语感的来源。',
    '读不顺往往不是单词不认识，而是意群没断对。先按意群停顿，再连起来。',
    '同一个词在三个不同句子里出现过，比抄三十遍更容易在写作时想起来。',
    '听自己的录音会有点尴尬，但那是最快发现发音问题的方式。',
    '每天读十句、每句三遍，比周末读一百句有效得多。间隔本身就是记忆的一部分。',
    '读错的句子会自动回到复习队列。别急着清空，先把它读顺。'
  ];
  var tipIndex = Math.floor(Math.random() * TIPS.length);

  var QUOTES = [
    { en: 'The limits of my language mean the limits of my world.', zh: '语言的边界，就是我世界的边界。', author: '维特根斯坦' },
    { en: 'A different language is a different vision of life.', zh: '换一种语言，就是换一种看世界的方式。', author: '费里尼' },
    { en: 'Little by little, one travels far.', zh: '一点一点地走，也能走到很远。', author: '托尔金' },
    { en: 'The journey of a thousand miles begins with one step.', zh: '千里之行，始于足下。', author: '老子' },
    { en: 'What we learn with pleasure we never forget.', zh: '带着愉悦学到的东西，永远不会忘记。', author: '梅尔西耶' },
    { en: 'Language is the road map of a culture.', zh: '语言是一张文化地图。', author: '丽塔·梅·布朗' },
    { en: 'The more that you read, the more things you will know.', zh: '读得越多，知道得越多。', author: '苏斯博士' },
    { en: 'Success is the sum of small efforts repeated day in and day out.', zh: '成功，是日复一日小努力的总和。', author: '科利尔' },
    { en: 'Learning is a treasure that will follow its owner everywhere.', zh: '学问是一笔走到哪里都跟着你的财富。', author: '中国谚语' },
    { en: 'You are never too old to set another goal or to dream a new dream.', zh: '追一个新目标、做一个新梦，永远不嫌晚。', author: 'C.S. 刘易斯' },
    { en: 'Perseverance is not a long race; it is many short races one after another.', zh: '坚持不是一场长跑，而是一场接一场的短跑。', author: '埃利奥特' },
    { en: 'The beautiful thing about learning is that no one can take it away from you.', zh: '学习最美好的地方，是没人能把它从你身上拿走。', author: 'B.B. 金' }
  ];
  var quoteIndex = Math.floor(Math.random() * QUOTES.length);

  function renderHome() {
    libMode = 'read';
    var now = Date.now();
    var d = new Date();
    var quote = QUOTES[quoteIndex];

    $('#greetDate').textContent = dateCN(d) + ' · ' + weekdayCN(d);
    $('#greetTitle').textContent = '“' + quote.en + '”';
    $('#heroSub').textContent = quote.zh + ' —— ' + quote.author;

    var t = store.today();
    var totals = store.totals();
    var goal = Math.max(10, Number(store.settings.dailyGoal) || 40);
    var pct = Math.min(100, Math.round((t.reviewed / goal) * 100));
    var acc = SRS.accuracy(t.correct, t.reviewed);

    var bankId = store.settings.homeBank || 'all';
    var bankIds = bankId === 'all' ? null : [bankId];
    var bankPool = poolOf(bankIds);
    var dueTotal = bankPool.filter(function (w) { return isDueWord(w, now, 'read'); }).length;
    var left = store.newWordsLeft('read');
    var freshCount = bankPool.filter(function (w) { return isNewWord(w, 'read'); }).length;
    var select = $('#homeBankSelect');
    if (select) select.value = bankId;
    var duePill = $('#dueCount');
    duePill.textContent = dueTotal;
    duePill.hidden = dueTotal === 0;
    var reviewLabel = $('#reviewLabel');
    if (dueTotal > 0) reviewLabel.textContent = '开始今日跟读';
    else if (left > 0 && freshCount > 0) reviewLabel.textContent = '开始跟读新词';
    else reviewLabel.textContent = '自由跟读';
    $('#startReviewBtn').disabled = false;
    $('#startNewBtn').hidden = false;
    $('#newQuotaNote').textContent = '待复习 ' + dueTotal + ' 个 · 今日新词 ' + t.newLearned + '/' + store.settings.newPerDay + (left > 0 ? '（还剩 ' + Math.min(left, freshCount) + ' 个）' : '（已学完）');

    $('#goalPct').textContent = pct + '%';
    $('#goalDone').textContent = t.reviewed;
    $('#goalTotal').textContent = goal;
    setRing($('#goalRing'), pct / 100, 326.73);

    $('#statStreak').textContent = store.streak();
    $('#statMastered').textContent = totals.mastered;
    $('#statAcc').textContent = acc == null ? '—' : acc + '%';
    $('#statTotal').textContent = WORDS.length;

    renderBanks();
    renderWeekChart();
    updateReminderBanner();
  }

  function setRing(el, ratio, circumference) {
    if (!el) return;
    var c = circumference || 326.73;
    el.style.strokeDasharray = c;
    el.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(1, ratio))));
  }

  function renderBanks() {
    var grid = $('#bankGrid');
    grid.innerHTML = BANKS.map(function (b) {
      var learned = 0, mastered = 0;
      b.words.forEach(function (w) {
        var c = cardOf(w.id, 'read');
        if (c && c.reps > 0) learned += 1;
        if (c && c.status === 'mastered') mastered += 1;
      });
      var pct = b.words.length ? Math.round((learned / b.words.length) * 100) : 0;
      return '' +
        '<article class="bank-card" style="--bank-color:' + esc(b.color) + '">' +
        '<div class="bank-head">' +
        '<span class="bank-dot"></span>' +
        '<div><h3>' + esc(b.name) + '</h3><p>' + esc(b.sub || '') + ' · ' + b.words.length + ' 词</p></div>' +
        '<span class="bank-pct">' + pct + '%</span>' +
        '</div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<p class="bank-meta"><span>已掌握 ' + mastered + '</span><span>学过 ' + learned + '</span></p>' +
        '<div class="bank-foot">' +
        '<button class="bank-play" data-bank-play="' + b.id + '" data-style="read">开始跟读 <span aria-hidden="true">→</span></button>' +
        '<button class="bank-quick" data-bank-play="' + b.id + '" data-style="quiz" title="不看句子，直接四选一快刷">快刷</button>' +
        '<button class="bank-quick" data-bank-play="' + b.id + '" data-style="blind" title="只听句子，选中文意思">盲听</button>' +
        '</div>' +
        '</article>';
    }).join('');
  }

  function renderWeekChart() {
    var days = store.recentDays(7);
    var max = Math.max.apply(null, days.map(function (x) { return x.reviewed; }).concat([10]));
    var total = days.reduce(function (s, x) { return s + x.reviewed; }, 0);
    $('#weekTotal').textContent = total + ' 词';
    $('#weekChart').innerHTML = days.map(function (x) {
      var pct = Math.round((x.reviewed / max) * 100);
      return '<div class="chart-col' + (x.isToday ? ' is-today' : '') + '">' +
        '<div class="chart-bar" style="height:' + Math.max(4, pct) + '%">' +
        (x.reviewed ? '<span>' + x.reviewed + '</span>' : '') +
        '</div><span class="chart-label">' + (x.isToday ? '今天' : x.label) + '</span></div>';
    }).join('');
    $('#tipText').textContent = TIPS[tipIndex];
  }

  var statsState = { offset: 0, selected: null };

  function fmtDuration(ms) {
    var min = Math.round((Number(ms) || 0) / 60000);
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }

  function renderStats() {
    var totals = store.totals();
    var days = store.getDays();
    var newTotal = 0;
    Object.keys(days).forEach(function (k) { newTotal += days[k].newLearned || 0; });

    $('#statsDays').textContent = store.studyDays();
    $('#statsLongest').textContent = store.longestStreak();
    $('#statsTime').textContent = fmtDuration(store.totalMs());
    $('#statsNew').textContent = newTotal;

    renderCalendar();
    renderModeStats();
    renderStatsBars();
    renderBreakdown(totals);
  }

  function renderCalendar() {
    var now = new Date();
    var base = new Date(now.getFullYear(), now.getMonth() + statsState.offset, 1);
    var y = base.getFullYear(), m = base.getMonth();
    var first = (base.getDay() + 6) % 7;
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayKey = store.dayKey(Date.now());
    var todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    var cells = [];
    for (var i = 0; i < first; i++) cells.push('<span class="cal-day is-empty"></span>');
    var monthReviewed = 0, activeDays = 0;
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(y, m, d);
      var key = store.dayKey(date.getTime());
      var row = store.getDay(key);
      var reviewed = row.reviewed || 0;
      if (reviewed > 0) { activeDays += 1; monthReviewed += reviewed; }
      var lv = reviewed >= 40 ? 4 : reviewed >= 20 ? 3 : reviewed >= 10 ? 2 : reviewed > 0 ? 1 : 0;
      var cls = 'cal-day lv' + lv;
      if (key === todayKey) cls += ' is-today';
      if (key === statsState.selected) cls += ' is-selected';
      if (date > todayEnd) cls += ' is-future';
      var disabled = date > todayEnd ? ' disabled' : '';
      cells.push('<button type="button" class="' + cls + '" data-cal-date="' + key + '"' + disabled + '>' +
        '<span>' + d + '</span>' + (reviewed ? '<b>' + reviewed + '</b>' : '') + '</button>');
    }
    var tail = (7 - ((first + daysInMonth) % 7)) % 7;
    for (var j = 0; j < tail; j++) cells.push('<span class="cal-day is-empty"></span>');
    $('#calTitle').textContent = y + '年' + (m + 1) + '月';
    $('#calGrid').innerHTML = cells.join('');
    $('#calNext').disabled = statsState.offset >= 0;

    var detail = $('#calDetail');
    if (statsState.selected) {
      var row = store.getDay(statsState.selected);
      var dateObj = new Date(statsState.selected + 'T00:00:00');
      var label = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日';
      var modes = row.modes || {};
      var modeText = Object.keys(modes).map(function (m) {
        return (MODE_LABEL[m] || m) + ' ' + modes[m];
      }).join(' · ');
      detail.innerHTML = '<b>' + esc(label) + '</b> · ' +
        (row.reviewed ? '练了 ' + row.reviewed + ' 个，正确 ' + row.correct + ' 个' +
          (row.newLearned ? '，新词 ' + row.newLearned + ' 个' : '') +
          (row.ms ? '，用时 ' + fmtDuration(row.ms) : '') +
          (modeText ? '<br>' + esc(modeText) : '')
          : '这一天没有练习记录');
    } else {
      detail.textContent = activeDays
        ? '本月已练 ' + activeDays + ' 天，共 ' + monthReviewed + ' 个。点某一天看明细。'
        : '这个月还没有练习记录。点某一天看当天明细。';
    }
  }

  function renderModeStats() {
    var modes = store.modeTotals();
    var total = 0;
    Object.keys(modes).forEach(function (m) { total += modes[m]; });
    if (!total) {
      var all = store.totals().reviewed;
      if (all > 0) { modes = { read: all }; total = all; }
    }
    var order = ['read', 'choice', 'spell', 'listen', 'context', 'blind'];
    var rows = order.filter(function (m) { return modes[m]; }).map(function (m) {
      var pct = total ? Math.round((modes[m] / total) * 100) : 0;
      return '<div class="mode-row"><span>' + (MODE_LABEL[m] || '跟读') + '</span>' +
        '<span class="mode-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span>' + modes[m] + '</span></div>';
    });
    Object.keys(modes).forEach(function (m) {
      if (order.indexOf(m) >= 0) return;
      var pct = total ? Math.round((modes[m] / total) * 100) : 0;
      rows.push('<div class="mode-row"><span>' + esc(m) + '</span><span class="mode-bar"><i style="width:' + pct + '%"></i></span><span>' + modes[m] + '</span></div>');
    });
    $('#modeStats').innerHTML = rows.length ? rows.join('') : '<p class="field-note">还没有练习记录。</p>';
  }

  function renderStatsBars() {
    var days = store.recentDays(14);
    var max = Math.max.apply(null, days.map(function (x) { return x.reviewed; }).concat([10]));
    var total = days.reduce(function (s, x) { return s + x.reviewed; }, 0);
    $('#statsWeekTotal').textContent = total + ' 词';
    $('#statsBars').innerHTML = days.map(function (x, i) {
      var pct = Math.round((x.reviewed / max) * 100);
      var showLabel = x.isToday || i % 2 === 0 || i === days.length - 1;
      return '<div class="chart-col' + (x.isToday ? ' is-today' : '') + '">' +
        '<div class="chart-bar" style="height:' + Math.max(4, pct) + '%">' +
        (x.reviewed ? '<span>' + x.reviewed + '</span>' : '') +
        '</div><span class="chart-label">' + (x.isToday ? '今天' : showLabel ? x.label : '') + '</span></div>';
    }).join('');
  }

  function renderBreakdown(totals) {
    var accuracy = totals.accuracy == null ? '—' : totals.accuracy + '%';
    $('#statsBreakdown').innerHTML =
      '<div class="breakdown-item"><strong>' + totals.reviewed + '</strong><span>累计作答</span></div>' +
      '<div class="breakdown-item"><strong>' + accuracy + '</strong><span>累计正确率</span></div>' +
      '<div class="breakdown-item"><strong>' + totals.touched + '</strong><span>学过的单词</span></div>' +
      '<div class="breakdown-item"><strong>' + totals.mastered + '</strong><span>已掌握</span></div>';
  }

  $('#calPrev').addEventListener('click', function () {
    statsState.offset -= 1;
    statsState.selected = null;
    renderStats();
  });
  $('#calNext').addEventListener('click', function () {
    if (statsState.offset >= 0) return;
    statsState.offset += 1;
    statsState.selected = null;
    renderStats();
  });
  $('#calGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cal-date]');
    if (!b || b.disabled) return;
    statsState.selected = b.dataset.calDate;
    renderCalendar();
  });
  $('#statGrid').addEventListener('click', function () { setView('stats'); });

  /* ---------------- 提醒 ---------------- */
  var reminderTimer = null;

  function reminderParts() {
    var t = String(store.settings.reminderTime || '20:30').split(':');
    var h = parseInt(t[0], 10);
    var m = parseInt(t[1], 10);
    if (isNaN(h) || h < 0 || h > 23) h = 20;
    if (isNaN(m) || m < 0 || m > 59) m = 30;
    return { h: h, m: m };
  }

  function nextReminderDate() {
    var p = reminderParts();
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), p.h, p.m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  function updateReminderBanner() {
    var el = $('#reminderBanner');
    if (!el) return;
    var p = reminderParts();
    var now = new Date();
    var due = now.getHours() * 60 + now.getMinutes() >= p.h * 60 + p.m;
    var t = store.today();
    el.hidden = !(store.settings.reminderOn && t.reviewed === 0 && due);
  }

  function scheduleWebReminder() {
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
    if (!store.settings.reminderOn) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var delay = Math.max(1500, nextReminderDate().getTime() - Date.now());
    reminderTimer = setTimeout(function () {
      if (store.settings.reminderOn && store.today().reviewed === 0) {
        try {
          var n = new Notification('词感 · 该刷词了', {
            body: '今天还没有开口。读 10 句，只要几分钟。',
            icon: 'assets/icon-192.png',
            tag: 'wordsense-daily'
          });
          n.onclick = function () { try { window.focus(); } catch (e) { } n.close(); };
        } catch (e) { }
      }
      updateReminderBanner();
      scheduleWebReminder();
    }, delay);
  }

  function syncReminder(ask) {
    var on = !!store.settings.reminderOn;
    var p = reminderParts();
    if (window.AndroidBridge && typeof window.AndroidBridge.scheduleReminder === 'function') {
      try {
        window.AndroidBridge.scheduleReminder(on, p.h, p.m, !!ask);
      } catch (e) { }
      updateReminderBanner();
      return;
    }
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
    if (!on) { updateReminderBanner(); return; }
    if (!('Notification' in window)) {
      if (ask) toast('当前浏览器不支持系统通知');
      updateReminderBanner();
      return;
    }
    if (Notification.permission === 'granted') {
      scheduleWebReminder();
    } else if (ask) {
      try {
        Notification.requestPermission().then(function (perm) {
          if (perm === 'granted') scheduleWebReminder();
          else toast('通知权限未开启，会只在应用内提示');
          updateReminderBanner();
        });
      } catch (e) { }
    }
    updateReminderBanner();
  }

  window.__onReminderError = function (msg) {
    toast(msg || '提醒设置失败，请检查通知权限');
  };
  window.__onReminderScheduled = function () { };

  $('#reminderStartBtn').addEventListener('click', function () {
    $('#startReviewBtn').click();
  });

  var libState = { bank: 'all', status: 'all', q: '', limit: 80, selected: {}, selecting: false, mode: 'read' };

  function renderLibrary(reset) {
    libMode = libState.mode;
    if (reset) {
      libState.limit = 80;
      libState.selected = {};
    }
    var totals = store.totals(libState.mode);
    var totalWords = WORDS.length;
    var totalNote = ' 个去重单词';
    if (libState.bank === 'all') {
      totalWords = BANKS.reduce(function (n, b) { return n + b.words.length; }, 0);
      totalNote = ' 条词库记录（去重 ' + WORDS.length + ' 个单词）';
    } else {
      var bank = bankById(libState.bank);
      totalWords = bank ? bank.words.length : 0;
      totalNote = ' 个词';
    }
    $('#libTotal').textContent = totalWords;
    $('#libTotalNote').textContent = totalNote;
    $('#libMastered').textContent = totals.mastered;
    $$('#libModeSeg button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.libMode === libState.mode);
    });
    var studyBtn = $('#libStudyBtn');
    if (studyBtn) studyBtn.textContent = libState.mode === 'quiz' ? '快刷这些词' : libState.mode === 'blind' ? '盲听这些词' : '跟读这些词';

    var chips = [{ id: 'all', name: '全部' }].concat(BANKS.map(function (b) { return { id: b.id, name: b.name }; }));
    $('#libBanks').innerHTML = chips.map(function (c) {
      return '<button class="chip-btn' + (libState.bank === c.id ? ' is-active' : '') + '" data-lib-bank="' + c.id + '">' + esc(c.name) + '</button>';
    }).join('');

    var list = filterWords();
    var rows = list.slice(0, libState.limit);
    $('#wordList').innerHTML = rows.map(wordRow).join('');
    $('#libEmpty').hidden = rows.length > 0;
    $('#libMore').parentElement.hidden = list.length <= libState.limit;
    $('#view-library').classList.toggle('is-selecting', libState.selecting);
    $('#libSelectMode').textContent = libState.selecting ? '完成' : '批量选择';
    syncLibrarySelection();
  }

  function filterWords() {
    var q = libState.q.trim().toLowerCase();
    var wrongId = {};
    store.wrongEntries().forEach(function (e) { wrongId[e.id] = true; });
    return WORDS.filter(function (w) {
      if (libState.bank !== 'all' && (!w.banks || w.banks.indexOf(libState.bank) < 0)) return false;
      var st = wordStatus(w, libState.mode);
      if (libState.status === 'wrong') {
        if (!wrongId[w.id]) return false;
      } else if (libState.status !== 'all' && st !== libState.status) return false;
      if (q && w.w.toLowerCase().indexOf(q) < 0 && (w.zh || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  var STATUS_LABEL = { new: '未学', learning: '学习中', review: '复习中', mastered: '已掌握' };
  function wordRow(w) {
    var st = wordStatus(w);
    var checked = !!libState.selected[w.id];
    return '<li data-word="' + esc(w.id) + '" class="' + (checked ? 'is-selected' : '') + '" style="--bank-color:' + esc(w.color) + '">' +
      '<label class="wl-check" title="选择这个单词"><input type="checkbox" data-word-check="' + esc(w.id) + '"' + (checked ? ' checked' : '') + ' /></label>' +
      '<div class="w-cell"><span class="w">' + esc(w.w) + '</span><span class="ph">' + (w.ph ? '/' + esc(w.ph) + '/' : '') + '</span></div>' +
      '<span class="z">' + esc(w.zh || '—') + '</span>' +
      '<span class="status s-' + st + '">' + STATUS_LABEL[st] + '</span>' +
      '</li>';
  }

  function selectedLibraryIds() {
    return Object.keys(libState.selected).filter(function (id) { return libState.selected[id] && BY_ID[id]; });
  }

  function syncLibrarySelection() {
    var ids = selectedLibraryIds();
    var rows = $$('#wordList li');
    rows.forEach(function (li) {
      var on = !!libState.selected[li.dataset.word];
      li.classList.toggle('is-selected', on);
      var box = $('input[data-word-check]', li);
      if (box) box.checked = on;
    });
    var bar = $('#libBulkBar');
    if (bar) bar.hidden = !libState.selecting || ids.length === 0;
    var count = $('#libSelCount');
    if (count) count.textContent = ids.length;
    var all = $('#libCheckAll');
    if (all) {
      var list = filterWords();
      var checkedInList = list.filter(function (w) { return libState.selected[w.id]; }).length;
      all.checked = list.length > 0 && checkedInList === list.length;
      all.indeterminate = checkedInList > 0 && checkedInList < list.length;
    }
  }

  $('#libSearch').addEventListener('input', function (e) {
    libState.q = e.target.value;
    renderLibrary(true);
  });
  $('#libFilter').addEventListener('change', function (e) {
    libState.status = e.target.value;
    renderLibrary(true);
  });
  $('#libBanks').addEventListener('click', function (e) {
    var b = e.target.closest('[data-lib-bank]');
    if (!b) return;
    libState.bank = b.dataset.libBank;
    renderLibrary(true);
  });
  $('#libModeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-lib-mode]');
    if (!b) return;
    libState.mode = b.dataset.libMode;
    libMode = libState.mode;
    libState.selected = {};
    renderLibrary(true);
    var btn = $('#libStudyBtn');
    if (btn) btn.textContent = libState.mode === 'quiz' ? '快刷这些词' : libState.mode === 'blind' ? '盲听这些词' : '跟读这些词';
  });
  $('#libMore').addEventListener('click', function () {
    libState.limit += 120;
    renderLibrary(false);
  });
  $('#wordList').addEventListener('click', function (e) {
    if (e.target.closest('.wl-check')) return;
    var li = e.target.closest('[data-word]');
    if (li) openWordModal(li.dataset.word);
  });
  $('#wordList').addEventListener('change', function (e) {
    var box = e.target.closest('input[data-word-check]');
    if (!box) return;
    var id = box.dataset.wordCheck;
    if (box.checked) libState.selected[id] = true;
    else delete libState.selected[id];
    syncLibrarySelection();
  });
  $('#libCheckAll').addEventListener('change', function (e) {
    if (e.target.checked) {
      filterWords().forEach(function (w) { libState.selected[w.id] = true; });
    } else {
      libState.selected = {};
    }
    syncLibrarySelection();
  });
  $('#libClearSel').addEventListener('click', function () {
    libState.selected = {};
    syncLibrarySelection();
  });
  $('#libSelectMode').addEventListener('click', function () {
    libState.selecting = !libState.selecting;
    libState.selected = {};
    renderLibrary(false);
  });
  $$('[data-bulk-status]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var ids = selectedLibraryIds();
      if (!ids.length) return;
      var status = btn.dataset.bulkStatus;
      ids.forEach(function (id) { store.setCardStatus(modeKey(id, libMode), status); });
      var label = STATUS_LABEL[status] || status;
      toast('已把 ' + ids.length + ' 个单词标为「' + label + '」');
      libState.selected = {};
      refreshAfterChange();
    });
  });
  $('#libResetBook').addEventListener('click', function () {
    var bank = libState.bank === 'all' ? null : bankById(libState.bank);
    var ids = bank ? bank.words.map(function (w) { return w.id; }) : WORDS.map(function (w) { return w.id; });
    var name = bank ? bank.name : '全部词库';
    confirmAction('重学整本词书？', '会把「' + name + '」的 ' + ids.length + ' 个单词全部重置为未学，并移出错词本。学习历史统计不会删除。', '确认重学', function () {
      store.resetWords(ids.map(function (id) { return modeKey(id, libMode); }));
      libState.selected = {};
      refreshAfterChange();
      toast('「' + name + '」已重置为未学');
    });
  });
  $('#libStudyBtn').addEventListener('click', function () {
    var selected = selectedLibraryIds();
    var list = selected.length ? selected.map(function (id) { return BY_ID[id]; }) : filterWords();
    if (!list.length) { toast('这个范围里没有单词'); return; }
    if (libState.mode === 'blind' && !canSpeak()) { toast('当前设备没有可用的语音朗读'); return; }
    var ids = list.slice(0, Math.max(1, Number(store.settings.sessionSize) || 20)).map(function (w) { return w.id; });
    startSession({ ids: ids, style: libState.mode, label: libState.mode === 'quiz' ? '词库精选 · 快刷' : libState.mode === 'blind' ? '词库精选 · 盲听' : '词库精选 · 跟读', cfg: { ids: ids } });
  });

  function openWordModal(id) {
    var w = BY_ID[id];
    if (!w) return;
    var c = cardOf(id);
    var st = c ? SRS.statusOf(c) : 'new';
    var next = c ? SRS.describeInterval(c) : '未学习';
    var exHtml = '';
    if (w.ex) {
      exHtml = '<div class="detail-ex">' + highlight(w.ex, w.w) + '<div class="zh">' + esc(w.exzh || '') + '</div></div>';
    }
    var inWrong = store.wrongEntries().some(function (e) { return e.id === id; });
    openModal(
      '<button class="icon-btn modal-close" data-close aria-label="关闭">✕</button>' +
      '<div class="detail-word">' + esc(w.w) + '</div>' +
      '<div class="detail-ph">' + (w.ph ? '/' + esc(w.ph) + '/' : '') + (w.pos ? ' · ' + esc(w.pos) : '') + '</div>' +
      '<div class="detail-zh">' + esc(w.zh || '—') + '</div>' +
      exHtml +
      '<div class="detail-meta">' +
      '<span class="meta-pill">' + esc(w.bankName) + '</span>' +
      '<span class="meta-pill">' + STATUS_LABEL[st] + '</span>' +
      '<span class="meta-pill">下次复习：' + esc(next) + '</span>' +
      (c && c.reps ? '<span class="meta-pill">复习 ' + c.reps + ' 次 · 遗忘 ' + c.lapses + ' 次</span>' : '') +
      '</div>' +
      '<div class="modal-actions" style="justify-content:flex-start">' +
      '<button class="btn btn-primary btn-sm" id="practiceWordBtn">' + (w.ex ? '跟读这个句子' : '只刷这个词') + '</button>' +
      '<button class="btn btn-ghost btn-sm" data-speak="' + esc(w.w) + '">播放发音</button>' +
      '<button class="btn btn-ghost btn-sm" id="masterWordBtn">我已掌握并标熟</button>' +
      (w.bankId === 'my' ? '<button class="btn btn-quiet btn-sm danger-text" id="deleteCustomBtn">删除自定义词</button>' : '') +
      (c ? '<button class="btn btn-quiet btn-sm" id="resetWordBtn">重置进度</button>' : '') +
      (inWrong ? '<button class="btn btn-quiet btn-sm" id="removeWrongBtn">移出错词本</button>' : '') +
      '</div>'
    );
    $('#practiceWordBtn').addEventListener('click', function () {
      closeModal();
      startSession({ ids: [id], style: w.ex ? 'read' : 'quiz', label: w.ex ? '单句跟读' : '单词快刷', cfg: null, single: true });
    });
    var speakBtn = $('[data-speak]');
    if (speakBtn) speakBtn.addEventListener('click', function () { speak(w.w, speakBtn); });
    var masterBtn = $('#masterWordBtn');
    if (masterBtn) masterBtn.addEventListener('click', function () {
      store.setCardStatus(modeKey(id, activeMode()), 'mastered');
      closeModal();
      toast('已把「' + w.w + '」标为已掌握');
      refreshAfterChange();
    });
    var resetBtn = $('#resetWordBtn');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      store.removeCard(modeKey(id, activeMode()));
      closeModal();
      toast('已重置「' + w.w + '」');
      refreshAfterChange();
    });
    var rw = $('#removeWrongBtn');
    if (rw) rw.addEventListener('click', function () {
      store.removeWrong(id);
      closeModal();
      toast('已移出错词本');
      refreshAfterChange();
    });
    var del = $('#deleteCustomBtn');
    if (del) del.addEventListener('click', function () {
      store.removeCustom(w.w);
      ['read', 'quiz', 'blind'].forEach(function (m) { store.removeCard(modeKey(id, m)); });
      refreshBanks();
      closeModal();
      toast('已删除「' + w.w + '」');
      refreshAfterChange();
    });
  }

  function highlight(text, word) {
    var safe = esc(text);
    if (!word) return safe;
    try {
      var re = new RegExp('\\b' + esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'ig');
      return safe.replace(re, function (m) { return '<b>' + m + '</b>'; });
    } catch (e) { return safe; }
  }

  /* ---------------- 错词本 ---------------- */
  function renderWrong() {
    var entries = store.wrongEntries();
    var words = entries.map(function (e) { return BY_ID[e.id]; }).filter(Boolean);
    $('#wrongCount').textContent = words.length;
    $('#wrongEmpty').hidden = words.length > 0;
    $('#wrongList').innerHTML = words.map(function (w) {
      var e = entries.find(function (x) { return x.id === w.id; });
      return '<li data-word="' + esc(w.id) + '" style="--bank-color:' + esc(w.color) + '">' +
        '<div class="w-cell"><span class="w">' + esc(w.w) + '</span><span class="ph">' + (w.ph ? '/' + esc(w.ph) + '/' : '') + '</span></div>' +
        '<span class="z">' + esc(w.zh) + '</span>' +
        '<span class="status s-learning">错 ' + (e ? e.count : 1) + ' 次</span>' +
        '</li>';
    }).join('');
    $('#wrongStudyBtn').disabled = words.length === 0;
    $('#wrongQuizBtn').disabled = words.length === 0;
  }

  $('#wrongList').addEventListener('click', function (e) {
    var li = e.target.closest('[data-word]');
    if (li) openWordModal(li.dataset.word);
  });
  function wrongIds() {
    return store.wrongEntries().map(function (e) { return e.id; }).filter(function (id) { return BY_ID[id]; });
  }
  $('#wrongStudyBtn').addEventListener('click', function () {
    var ids = wrongIds();
    if (!ids.length) { toast('错词本是空的'); return; }
    startSession({ ids: ids, style: 'read', label: '错词跟读', cfg: { ids: ids } });
  });
  $('#wrongQuizBtn').addEventListener('click', function () {
    var ids = wrongIds();
    if (!ids.length) { toast('错词本是空的'); return; }
    startSession({ ids: ids, style: 'quiz', label: '错词快刷', cfg: { ids: ids } });
  });

  /* ---------------- 会话 ---------------- */
  var state = { session: null, timer: null, autoNextTimer: null };
  var lastCfg = null;
  var MODE_LABEL = { choice: '看词选义', pick: '据义择词', spell: '看义拼写', listen: '听音拼写', context: '语境填空', blind: '盲听选义' };

  function canContext(w) {
    if (!w.ex) return false;
    try {
      return new RegExp('\\b' + String(w.w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'i').test(w.ex);
    } catch (e) { return false; }
  }

  function modeFor(w, index, mode) {
    var c = cardOf(w.id, mode || 'quiz');
    if (!c || !c.reps) return 'choice';
    var modes = ['choice', 'pick', 'spell', 'context'].concat(canSpeak() ? ['listen'] : []);
    if (!canContext(w)) modes = modes.filter(function (m) { return m !== 'context'; });
    if (c.status === 'mastered') return modes[(index + 1) % modes.length];
    return modes[(c.reps + index) % modes.length];
  }

  function quizModeFor(w, index, type) {
    if (!type || type === 'mix') return modeFor(w, index, 'quiz');
    if (type === 'choice' || type === 'pick' || type === 'spell') return type;
    return modeFor(w, index, 'quiz');
  }

  function buildQueue(opts, mode) {
    mode = mode || 'read';
    var now = Date.now();
    var size = Math.max(1, Number(opts.size) || Number(store.settings.sessionSize) || 20);
    var pool = opts.ids
      ? opts.ids.map(function (id) { return BY_ID[id]; }).filter(Boolean)
      : poolOf(opts.bankIds);
    if (!pool.length) return [];

    var due = pool.filter(function (w) { return isDueWord(w, now, mode); })
      .sort(function (a, b) { return (cardOf(a.id, mode).due || 0) - (cardOf(b.id, mode).due || 0); });
    var fresh = pool.filter(function (w) { return isNewWord(w, mode); });
    if (opts.shuffleNew) fresh = shuffle(fresh);

    var queue = [];
    if (opts.focus === 'review') {
      queue = due.slice(0, size);
    } else if (opts.focus === 'new') {
      var quota = Math.min(store.newWordsLeft(mode), size);
      queue = fresh.slice(0, Math.max(quota, 0));
    } else if (opts.focus === 'wrong') {
      queue = pool.slice(0, size);
    } else {
      var newQuota = Math.min(store.newWordsLeft(mode), due.length ? Math.ceil(size * 0.5) : size);
      var dueTake = due.slice(0, Math.max(0, size - Math.min(fresh.length, newQuota)));
      queue = weave(dueTake, fresh.slice(0, Math.min(fresh.length, newQuota)));
      if (!queue.length) {
        // 没有到期也没有新词：从学过的词里随机自由复习
        var learned = pool.filter(function (w) { return store.hasCard(modeKey(w.id, mode)); });
        var freePool = learned.length ? learned : pool;
        queue = shuffle(freePool).slice(0, Math.min(size, freePool.length));
        opts.free = true;
      }
    }
    return queue.slice(0, size).map(function (w, i) { return { id: w.id, mode: modeFor(w, i, mode) }; });
  }

  function weave(a, b) {
    var out = [];
    var i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length) out.push(a[i++]);
      if (j < b.length) out.push(b[j++]);
    }
    return out;
  }

  function startSession(opts) {
    opts = opts || {};
    var style = opts.style === 'quiz' ? 'quiz' : opts.style === 'blind' ? 'blind' : 'read';
    var queue = buildQueue(opts, style);
    if (!queue.length && (opts.focus === 'review' || opts.focus === 'new') && !opts.strict) {
      // 复习到期词 / 新词额度用完后，自动退化为混合复习，而不是把用户挡在门外
      queue = buildQueue({ bankIds: opts.bankIds, ids: opts.ids, focus: 'mix', size: opts.size }, style);
      if (queue.length) opts = Object.assign({}, opts, { focus: 'mix', label: opts.focus === 'review' ? '复习巩固' : '自由复习' });
    }
    if (!queue.length) {
      if (opts.focus === 'review') toast('暂时没有到期的词');
      else if (opts.focus === 'new') toast('今日新词额度已用完');
      else toast('这个词库里还没有可刷的词');
      return;
    }
    if (style === 'read') {
      queue = queue.map(function (it) { return { id: it.id, mode: 'read' }; });
    } else if (style === 'blind') {
      queue = queue.map(function (it) { return { id: it.id, mode: 'blind' }; });
    }
    var quizType = opts.quizType || store.settings.quizType || 'mix';
    if (style === 'quiz') {
      queue = queue.map(function (it, i) {
        return { id: it.id, mode: quizModeFor(BY_ID[it.id], i, quizType) };
      });
    }
    if (opts.focus !== 'ids' && opts.focus !== 'wrong') {
      lastCfg = {
        bankIds: opts.bankIds || null,
        ids: opts.ids || null,
        focus: opts.focus || 'mix',
        size: queue.length,
        label: opts.label || '',
        style: style,
        quizType: quizType
      };
    }
    state.session = {
      items: queue,
      idx: 0,
      results: [],
      answered: 0,
      correct: 0,
      combo: 0,
      maxCombo: 0,
      startAt: Date.now(),
      qStart: Date.now(),
      hinted: false,
      answeredNow: false,
      label: opts.label || (style === 'read' ? '句子跟读' : style === 'blind' ? '盲听选义' : '极速刷词'),
      cfg: opts.cfg || null,
      free: !!opts.free,
      single: !!opts.single,
      quizType: quizType,
      style: style
    };
    setView('study');
    renderStudy();
    startStudyTimer();
  }

  function startStudyTimer() {
    stopStudyTimer();
    state.timer = setInterval(function () {
      if (!state.session) return;
      var el = $('#cardTimer');
      if (el) el.textContent = fmtClock(Date.now() - state.session.startAt);
    }, 500);
  }
  function stopStudyTimer() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.autoNextTimer) { clearTimeout(state.autoNextTimer); state.autoNextTimer = null; }
  }

  function renderStudy() {
    var s = state.session;
    if (!s) return;
    if (s.idx >= s.items.length) { finishSession(); return; }
    var item = s.items[s.idx];
    var w = BY_ID[item.id];
    if (!w) { s.idx += 1; renderStudy(); return; }

    if (s.style === 'read') {
      renderReadStudy(s, w);
      return;
    }
    if (s.style === 'blind') {
      renderBlindStudy(s, w);
      return;
    }

    $('#cardStage').classList.remove('is-read');
    s.answeredNow = false;
    s.hinted = false;
    s.qStart = Date.now();
    var mode = item.mode;
    var card = cardOf(w.id);
    var st = card ? SRS.statusOf(card) : 'new';

    var html = '';
    if (mode === 'choice') {
      html = '<div class="word-head"><h2 class="word">' + esc(w.w) + '</h2>' +
        '<button class="speak-btn" data-action="speak" aria-label="播放发音">' + ICON_SPEAK + '</button></div>' +
        '<p class="phonetic">/' + esc(w.ph) + '/ ' + (w.pos ? '<span class="pos">' + esc(w.pos) + '</span>' : '') + '</p>' +
        '<p class="prompt">选择最贴近的中文释义</p>' +
        '<div class="options" id="options">' + optionButtons(w) + '</div>';
    } else if (mode === 'spell') {
      html = '<p class="prompt">根据释义拼出单词<span class="prompt-sub">' + esc(w.pos || '') + '</span></p>' +
        '<p class="zh-prompt">' + esc(w.zh) + '</p>' +
        '<div class="slots" id="slots">' + slotHtml(w.w) + '</div>' +
        '<div class="answer-box"><input class="answer-input" id="answerInput" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文单词..." /><button class="btn btn-primary" data-action="submit">检查</button></div>' +
        '<div class="hint-row"><button class="link-btn" data-action="hint">给点提示</button><span class="hint-text" id="hintText">' + w.w.length + ' 个字母</span></div>';
    } else if (mode === 'pick') {
      html = '<p class="prompt">根据中文释义，选出对应的单词<span class="prompt-sub">' + esc(w.pos || '') + '</span></p>' +
        '<p class="zh-prompt">' + esc(w.zh) + '</p>' +
        '<div class="options" id="options">' + pickOptionButtons(w) + '</div>';
    } else if (mode === 'listen') {
      html = '<div class="listen-stage">' +
        '<button class="speak-btn big" data-action="speak" aria-label="播放发音">' + ICON_SPEAK + '</button>' +
        '<p class="prompt">听发音，拼出这个单词</p>' +
        '<p class="hint-text">美式发音 · 可反复播放</p></div>' +
        '<div class="slots" id="slots">' + slotHtml(w.w) + '</div>' +
        '<div class="answer-box"><input class="answer-input" id="answerInput" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入你听到的单词..." /><button class="btn btn-primary" data-action="submit">检查</button></div>' +
        '<div class="hint-row"><button class="link-btn" data-action="hint">给点提示</button><span class="hint-text" id="hintText">' + w.w.length + ' 个字母</span></div>';
    } else {
      html = '<p class="prompt">读句子，补全缺失的单词</p>' +
        '<p class="ctx-sentence">' + blankSentence(w) + '</p>' +
        '<p class="ctx-zh">释义：' + esc(w.zh) + ' <span class="ctx-pos">' + esc(w.pos) + '</span></p>' +
        '<div class="answer-box"><input class="answer-input" id="answerInput" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="填入缺失的单词..." /><button class="btn btn-primary" data-action="submit">检查</button></div>' +
        '<div class="hint-row"><button class="link-btn" data-action="hint">给点提示</button><span class="hint-text" id="hintText">' + w.w.length + ' 个字母</span></div>';
    }

    $('#cardStage').innerHTML =
      '<div class="study-card" id="studyCard">' +
      '<div class="study-meta">' +
      '<span class="chip">' + MODE_LABEL[mode] + '</span>' +
      '<span class="chip ghost">' + esc(w.bankName) + '</span>' +
      (st !== 'new' ? '<span class="chip ghost">第 ' + (card ? card.reps : 0) + ' 次见</span>' : '<span class="chip ghost">新词</span>') +
      '<span class="study-timer" id="cardTimer">' + fmtClock(Date.now() - s.startAt) + '</span>' +
      '</div>' + html +
      '<div id="feedbackSlot"></div>' +
      '<div class="study-actions" id="studyActions"></div>' +
      '</div>';

    var input = $('#answerInput');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitTyped(); }
      });
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);
    }
    if (mode === 'listen') {
      setTimeout(function () {
        var b = $('[data-action="speak"]');
        if (b) { b.classList.add('is-playing'); speak(w.w, b); }
      }, 260);
    }

    $('#studyCount').textContent = (s.idx + 1) + ' / ' + s.items.length;
    $('#studyBar').style.width = Math.round((s.idx / s.items.length) * 100) + '%';
    updateHud();
    renderKbdHints(mode === 'pick' ? 'choice' : mode);
    $('#kbdHints').style.display = '';
    $('#skipBtn').textContent = '我已掌握并标熟';
  }

  function renderBlindStudy(s, w) {
    s.answeredNow = false;
    s.hinted = false;
    s.qStart = Date.now();
    var card = cardOf(w.id);
    var st = card ? SRS.statusOf(card) : 'new';
    var tts = canSpeak();
    $('#cardStage').classList.remove('is-read');
    $('#cardStage').innerHTML =
      '<div class="study-card blind-card" id="studyCard">' +
      '<div class="study-meta">' +
      '<span class="chip">盲听选义</span>' +
      '<span class="chip ghost">' + esc(w.bankName) + '</span>' +
      (st !== 'new' ? '<span class="chip ghost">第 ' + (card ? card.reps : 0) + ' 次见</span>' : '<span class="chip ghost">新词</span>') +
      '<span class="study-timer" id="cardTimer">' + fmtClock(Date.now() - s.startAt) + '</span>' +
      '</div>' +
      '<div class="blind-body">' +
      '<button type="button" class="blind-play" data-action="say" aria-label="播放句子">' + ICON_SPEAK + '</button>' +
      '<p class="blind-title">听句子，选出最接近的中文意思</p>' +
      '<p class="blind-hint">' + (tts ? '先不看英文，听不清可以再点一次' : '当前设备不支持语音朗读，盲听模式需要系统 TTS') + '</p>' +
      '<div class="options blind-options" id="options">' + blindOptionButtons(w) + '</div>' +
      '</div>' +
      '<div id="feedbackSlot"></div>' +
      '<div class="study-actions" id="studyActions"></div>' +
      '</div>';

    $('#studyCount').textContent = (s.idx + 1) + ' / ' + s.items.length;
    $('#studyBar').style.width = Math.round((s.idx / s.items.length) * 100) + '%';
    updateHud();
    $('#kbdHints').style.display = '';
    $('#kbdHints').innerHTML = '<kbd>空格</kbd> 再听　<kbd>1</kbd>–<kbd>4</kbd> 选择　<kbd>Esc</kbd> 退出';
    $('#skipBtn').textContent = '我已掌握并标熟';
    if (tts) {
      setTimeout(function () {
        if (!state.session || state.session.idx !== s.idx || s.answeredNow) return;
        var b = $('[data-action="say"]');
        if (b) speak(w.ex || w.w, b, { rate: 0.92 });
      }, 450);
    }
  }

  function updateHud() {
    var s = state.session;
    var el = $('#comboHud');
    if (!s || s.combo < 2) { el.hidden = true; } else { el.hidden = false; el.textContent = '×' + s.combo + ' 连顺'; }
  }

  /* ============================================================
     句子跟读模式
     ============================================================ */
  var readState = {
    recorder: null,
    chunks: [],
    stream: null,
    url: null,
    audio: null,
    audioCtx: null,
    analyser: null,
    data: null,
    raf: null,
    timer: null,
    recording: false,
    startedAt: 0,
    target: '',
    word: null,
    sentence: '',
    asrActive: false,
    webRec: null,
    asrScore: null,
    desktopAbort: null,
    asrSeq: 0,
    preplaying: false,
    preTimer: null,
    preToken: 0,
    autoPhase: null,
    autoTimer: null,
    autoToken: 0
  };

  var WebSpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var asrCapability = null;
  var desktopAsr = null;
  var desktopAsrReason = '';

  function isDesktopApp() {
    return location.protocol === 'http:' && location.hostname === '127.0.0.1' &&
      location.search.indexOf('desktop=1') >= 0;
  }

  function detectDesktopAsr() {
    if (!isDesktopApp()) { desktopAsr = false; return; }
    try {
      fetch('/__asr/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        desktopAsr = !!(j && j.available);
        desktopAsrReason = (j && j.engine) || '';
        asrCapability = null;
      }).catch(function () { desktopAsr = false; });
    } catch (e) { desktopAsr = false; }
  }

  function asrAvailable() {
    if (desktopAsr === true) return true;
    if (asrCapability !== null) return asrCapability;
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.isSpeechAvailable === 'function') {
        if (window.AndroidBridge.isSpeechAvailable()) { asrCapability = true; return true; }
      }
    } catch (e) { /* 继续看浏览器能力 */ }
    asrCapability = !!WebSpeechRec;
    if (!asrCapability && desktopAsr === null && isDesktopApp()) return true;
    return asrCapability;
  }

  function micSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function cleanupReadMedia() {
    stopAsr();
    stopOnlineAudio();
    if (readState.autoTimer) { clearTimeout(readState.autoTimer); readState.autoTimer = null; }
    readState.autoPhase = null;
    readState.autoToken += 1;
    stopPrePlay(true);
    if (readState.timer) { clearInterval(readState.timer); readState.timer = null; }
    if (readState.raf) { cancelAnimationFrame(readState.raf); readState.raf = null; }
    if (readState.recorder) {
      try { if (readState.recorder.state !== 'inactive') readState.recorder.stop(); } catch (e) {}
      readState.recorder = null;
    }
    if (readState.stream) {
      readState.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      readState.stream = null;
    }
    if (readState.audioCtx) {
      try { readState.audioCtx.close(); } catch (e) {}
      readState.audioCtx = null;
    }
    if (readState.audio) {
      try { readState.audio.pause(); } catch (e) {}
      readState.audio = null;
    }
    if (readState.url) {
      try { URL.revokeObjectURL(readState.url); } catch (e) {}
      readState.url = null;
    }
    readState.recording = false;
  }

  function findTargetToken(sentence, word) {
    var tokens = String(sentence || '').match(/[A-Za-z][A-Za-z'’-]*/g) || [];
    var w = String(word || '').toLowerCase();
    if (!w) return '';
    var exact = tokens.find(function (t) { return t.toLowerCase() === w; });
    if (exact) return exact;
    var pref = tokens.find(function (t) {
      var l = t.toLowerCase();
      return (l.length >= 4 && w.indexOf(l) === 0) || (l.length > w.length && l.indexOf(w) === 0);
    });
    if (pref) return pref;
    var best = '', score = 0;
    tokens.forEach(function (t) {
      var l = t.toLowerCase(), n = 0;
      while (n < l.length && n < w.length && l[n] === w[n]) n++;
      if (n >= 4 && n > score) { best = t; score = n; }
    });
    return best;
  }

  var IRREGULAR = {
    has: 'have', had: 'have', having: 'have', is: 'be', am: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
    does: 'do', did: 'do', done: 'do', doing: 'do', went: 'go', gone: 'go', came: 'come', saw: 'see', seen: 'see',
    made: 'make', took: 'take', taken: 'take', gave: 'give', given: 'give', got: 'get', gotten: 'get', said: 'say',
    found: 'find', thought: 'think', told: 'tell', became: 'become', left: 'leave', felt: 'feel', brought: 'bring',
    began: 'begin', begun: 'begin', kept: 'keep', held: 'hold', wrote: 'write', written: 'write', spoke: 'speak',
    spoken: 'speak', ran: 'run', bought: 'buy', paid: 'pay', met: 'meet', sent: 'send', built: 'build', grew: 'grow',
    grown: 'grow', knew: 'know', known: 'know', lost: 'lose', won: 'win', children: 'child', men: 'man',
    women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse', better: 'good', best: 'good', worse: 'bad', worst: 'bad'
  };

  function lookupEntry(token) {
    var t = String(token || '').toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    if (!t) return null;
    if (DICT[t]) return DICT[t];
    if (IRREGULAR[t] && DICT[IRREGULAR[t]]) return DICT[IRREGULAR[t]];
    var cands = [];
    if (/ies$/.test(t)) cands.push(t.slice(0, -3) + 'y');
    if (/es$/.test(t)) cands.push(t.slice(0, -2));
    if (/s$/.test(t)) cands.push(t.slice(0, -1));
    if (/ied$/.test(t)) cands.push(t.slice(0, -3) + 'y');
    if (/ed$/.test(t)) { cands.push(t.slice(0, -2)); cands.push(t.slice(0, -1)); }
    if (/ing$/.test(t)) { cands.push(t.slice(0, -3)); cands.push(t.slice(0, -3) + 'e'); }
    for (var i = 0; i < cands.length; i++) {
      if (DICT[cands[i]]) return DICT[cands[i]];
      if (IRREGULAR[cands[i]] && DICT[IRREGULAR[cands[i]]]) return DICT[IRREGULAR[cands[i]]];
    }
    return null;
  }

  function sentenceHtml(sentence, target) {
    var out = '';
    var re = /[A-Za-z][A-Za-z'’-]*|[^A-Za-z]+/g;
    var m;
    var lowerTarget = target ? target.toLowerCase() : '';
    while ((m = re.exec(sentence)) !== null) {
      var part = m[0];
      if (/^[A-Za-z]/.test(part)) {
        var isTarget = lowerTarget && part.toLowerCase() === lowerTarget;
        out += '<button type="button" class="word-token' + (isTarget ? ' kw' : '') + '" data-token="' + esc(part) + '">' + esc(part) + '</button>';
      } else {
        out += esc(part);
      }
    }
    return out;
  }

  function renderReadStudy(s, w) {
    cleanupReadMedia();
    s.answeredNow = false;
    s.qStart = Date.now();
    var card = cardOf(w.id);
    var st = card ? SRS.statusOf(card) : 'new';
    var sentence = w.ex || w.w;
    var target = findTargetToken(sentence, w.w);
    readState.target = target;
    readState.word = w;
    readState.sentence = sentence;
    readState.asrScore = null;
    var mic = micSupported();
    var asr = asrAvailable();
    var bars = '';
    for (var i = 0; i < 22; i++) bars += '<i></i>';
    $('#cardStage').classList.add('is-read');

    $('#cardStage').innerHTML =
      '<div class="study-card read-card" id="studyCard">' +
      '<div class="study-meta">' +
      '<span class="chip">句子跟读</span>' +
      '<span class="chip ghost">' + esc(w.bankName) + '</span>' +
      (st !== 'new' ? '<span class="chip ghost">第 ' + (card ? card.reps : 0) + ' 次见</span>' : '<span class="chip ghost">新词</span>') +
      '<span class="study-timer" id="cardTimer">' + fmtClock(Date.now() - s.startAt) + '</span>' +
      '</div>' +
      '<div class="read-body">' +
      '<p class="read-label">听原声，然后跟着读一遍</p>' +
      '<p class="sentence" id="sentence">' + sentenceHtml(sentence, target) + '</p>' +
      '<div class="sentence-tools">' +
      '<button type="button" class="tool-btn" data-action="say">' + ICON_SPEAK + ' 原句</button>' +
      '<button type="button" class="tool-btn" data-action="say-slow">🐢 慢读</button>' +
      '<button type="button" class="tool-btn" data-action="toggle-zh">看整句翻译</button>' +
      '<button type="button" class="tool-btn" data-action="toggle-word">关键词释义</button>' +
      '</div>' +
      '<div class="sentence-zh" id="sentenceZh" hidden><span>' + esc(w.exzh || (w.ex ? '暂无整句翻译' : '这个词还没有例句，先把它读熟')) + '</span></div>' +
      '<div class="word-panel" id="wordPanel" hidden></div>' +
      '<p class="read-hint">点击句子中的任意单词可查词义；红色的 <b>' + esc(target || w.w) + '</b> 是今天的关键词。</p>' +
      (asr ? '<p class="read-hint asr-hint">点「自动评分」会先播放例句，播完自动开始录音；读完再点一下「停止并评分」。</p>' : '') +
      '</div>' +
      '<div class="shadow-panel">' +
      '<div class="record-row">' +
      '<button type="button" class="record-btn" id="recordBtn" data-action="record" aria-label="开始录音跟读">' +
      '<span class="mic-ico">' + ICON_MIC + '</span><span class="rec-label">跟读这句话</span>' +
      '</button>' +
      (asr ? '<button type="button" class="score-btn" data-action="score" title="点一下先播放例句，播完自动录音；再点一下停止并评分" aria-label="自动评分">✨ 自动评分</button>' : '') +
      '<div class="record-side">' +
      '<div class="record-state" id="recordState">' + (mic
        ? (store.settings.prePlay && canSpeak()
          ? '点一下开始：先播原声，再自动录音' + (asr ? '；自动评分会先播例句再录音' : '')
          : '点一下开始录音，读完再点一下停止' + (asr ? '；自动评分会先播例句再录音' : ''))
        : '当前浏览器不支持录音，可以直接听原声后自评') + '</div>' +
      '<div class="wave" id="wave" hidden>' + bars + '</div>' +
      '<div class="record-actions" id="recordActions" hidden>' +
      '<button type="button" class="mini-btn" data-action="play-mine">听我的录音</button>' +
      '<button type="button" class="mini-btn" data-action="clear-rec">重录</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div id="scoreSlot"></div>' +
      '<div class="rating-row" id="ratingRow">' +
      '<span class="rating-label">这次读得怎么样？</span>' +
      '<div class="rating-btns">' +
      '<button type="button" class="grade-btn" data-grade="3"><span class="gk">1</span>很顺</button>' +
      '<button type="button" class="grade-btn" data-grade="2"><span class="gk">2</span>还行</button>' +
      '<button type="button" class="grade-btn" data-grade="1"><span class="gk">3</span>有点卡</button>' +
      '<button type="button" class="grade-btn" data-grade="0"><span class="gk">4</span>没读出来</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div id="feedbackSlot"></div>' +
      '</div>';

    $('#studyCount').textContent = (s.idx + 1) + ' / ' + s.items.length;
    $('#studyBar').style.width = Math.round((s.idx / s.items.length) * 100) + '%';
    updateHud();
    $('#kbdHints').style.display = '';
    $('#kbdHints').innerHTML = '<kbd>1</kbd>–<kbd>4</kbd> 自评　<kbd>空格</kbd> 听原句　<kbd>R</kbd> 录音' +
      (asr ? '　<kbd>S</kbd> 评分' : '') + '　<kbd>T</kbd> 翻译　<kbd>Esc</kbd> 退出';
    $('#skipBtn').textContent = '我已掌握并标熟';
    if (mic) $('#recordBtn').dataset.mic = '1';
  }

  function toggleSentenceZh(force) {
    var el = $('#sentenceZh');
    if (!el) return;
    var show = typeof force === 'boolean' ? force : el.hidden;
    el.hidden = !show;
    var btn = $('[data-action="toggle-zh"]');
    if (btn) btn.textContent = show ? '收起翻译' : '看整句翻译';
  }

  function showWordPanel(token, entry, autoSpeak) {
    var panel = $('#wordPanel');
    if (!panel) return;
    var known = !!entry;
    panel.hidden = false;
    panel.innerHTML =
      '<button type="button" class="wp-close" data-action="close-word" aria-label="关闭词义">✕</button>' +
      '<div class="wp-top"><span class="wp-word">' + esc(token) + '</span>' +
      '<button type="button" class="icon-btn small" data-speak-token="' + esc(token) + '">' + ICON_SPEAK + '</button></div>' +
      (known && entry.ph ? '<p class="wp-ph">/' + esc(entry.ph) + '/ ' + esc(entry.pos || '') + '</p>' : '') +
      '<p class="wp-zh">' + (known ? esc(entry.zh) : '词库暂未收录这个词，可以先听发音。') + '</p>' +
      (known ? '<p class="wp-note">来自「' + esc(entry.bankName) + '」' + (entry.w.toLowerCase() !== token.toLowerCase() ? ' · 原形 ' + esc(entry.w) : '') + '</p>' : '');
    if (autoSpeak !== false) {
      var btn = $('[data-speak-token]', panel);
      speak(token, btn);
    }
  }

  /* ---------- 跟读自动评分 ---------- */
  function setScoreButton(phase) {
    var btn = $('[data-action="score"]');
    if (!btn) return;
    if (phase === 'playing') btn.textContent = '■ 取消播放';
    else if (phase === 'recording') btn.textContent = '■ 停止并评分';
    else if (phase === 'stopping') btn.textContent = '正在评分…';
    else btn.textContent = '✨ 自动评分';
    btn.classList.toggle('is-listening', phase === 'recording' || phase === 'stopping');
    btn.disabled = phase === 'stopping';
  }

  function startAutoScore() {
    var s = state.session;
    if (!s || s.style !== 'read' || s.answeredNow) return;
    if (readState.autoPhase) { stopAutoScore(); return; }
    if (!asrAvailable()) {
      toast('系统语音识别不可用，可以继续自评');
      return;
    }
    if (!window.ReadingScore) {
      asrError('评分模块没有加载');
      return;
    }
    if (readState.preplaying) stopPrePlay(true);
    if (readState.recording) stopRecording();
    if (readState.asrActive) stopAsr();

    var token = ++readState.autoToken;
    readState.autoPhase = 'playing';
    readState.asrScore = null;
    setScoreButton('playing');
    var slot = $('#scoreSlot');
    if (slot) slot.innerHTML = '<div class="asr-live">先听一遍例句…播完自动开始录音</div>';
    setRecordState('先听例句…播完自动开始录音，读完再点一下「停止并评分」');

    function beginListen() {
      if (token !== readState.autoToken || readState.autoPhase !== 'playing') return;
      if (readState.autoTimer) { clearTimeout(readState.autoTimer); readState.autoTimer = null; }
      readState.autoPhase = 'recording';
      setScoreButton('recording');
      if (!readState.recording) beginRecording();
      startAsrEngine();
    }

    if (!canSpeak()) { beginListen(); return; }
    readState.autoTimer = setTimeout(beginListen, 10000);
    speak(readState.sentence, null, { rate: 0.95, onend: beginListen });
  }

  function stopAutoScore() {
    var phase = readState.autoPhase;
    if (!phase) return;
    if (phase === 'playing') {
      readState.autoToken += 1;
      if (readState.autoTimer) { clearTimeout(readState.autoTimer); readState.autoTimer = null; }
      stopPrePlay(true);
      readState.autoPhase = null;
      setScoreButton(null);
      var slot = $('#scoreSlot');
      if (slot) slot.innerHTML = '';
      setRecordState('已取消播放，点「自动评分」重新开始');
      return;
    }
    if (phase === 'recording') {
      readState.autoPhase = 'stopping';
      if (readState.recording) stopRecording();
      stopAsrGraceful();
      setScoreButton('stopping');
      setRecordState('正在识别并打分…');
      setTimeout(function () {
        if (readState.autoPhase === 'stopping') asrError('没有听到内容');
      }, 3000);
    }
  }

  function startAsrEngine() {
    if (!window.ReadingScore) { asrError('评分模块没有加载'); return; }
    readState.asrActive = true;
    readState.asrScore = null;
    if (TTS_OK) { try { window.speechSynthesis.cancel(); } catch (e) { } }
    if (window.AndroidBridge && typeof window.AndroidBridge.stop === 'function') {
      try { window.AndroidBridge.stop(); } catch (e) { }
    }
    var slot = $('#scoreSlot');
    if (slot) slot.innerHTML = '<div class="asr-live">正在录音，读完再点一次「停止并评分」</div>';
    setRecordState('正在录音并识别，读完再点一下「停止并评分」');
    var btn = $('[data-action="score"]');
    if (btn) btn.classList.add('is-listening');
    readState.asrSeq += 1;

    if (desktopAsr === true || (desktopAsr === null && isDesktopApp())) {
      startDesktopAsr();
      return;
    }
    if (window.AndroidBridge && typeof window.AndroidBridge.startSpeechScore === 'function') {
      try {
        window.AndroidBridge.startSpeechScore();
        return;
      } catch (e) { /* 尝试 Web Speech */ }
    }
    startWebAsr();
  }

  function stopAsrGraceful() {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.stopSpeechScore === 'function') {
        window.AndroidBridge.stopSpeechScore();
      }
    } catch (e) { }
    try {
      if (readState.webRec) readState.webRec.stop();
    } catch (e) { }
  }

  function startDesktopAsr() {
    var token = readState.asrSeq;
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    readState.desktopAbort = ctrl;
    var timer = setTimeout(function () {
      try { if (ctrl) ctrl.abort(); } catch (e) { }
    }, 16000);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    fetch('/__asr/listen', opts).then(function (r) { return r.json(); }).then(function (j) {
      clearTimeout(timer);
      readState.desktopAbort = null;
      if (token !== readState.asrSeq || !readState.asrActive) return;
      if (j && j.ok && j.text) handleAsrResult(j.text, j.confidence || 0);
      else if (WebSpeechRec) {
        // 桌面 SAPI 不可用时，退回浏览器语音服务
        desktopAsr = false;
        readState.asrActive = true;
        startWebAsr();
      } else {
        asrError((j && j.error) || '没有听清，请再读一遍');
      }
    }).catch(function () {
      clearTimeout(timer);
      readState.desktopAbort = null;
      if (token !== readState.asrSeq || !readState.asrActive) return;
      if (WebSpeechRec) {
        desktopAsr = false;
        readState.asrActive = true;
        startWebAsr();
      } else {
        asrError('桌面语音识别没有响应');
      }
    });
  }

  function startWebAsr() {
    if (!WebSpeechRec) { asrError('当前浏览器不支持语音识别'); return; }
    try {
      var rec = new WebSpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = !!readState.autoPhase;
      rec.maxAlternatives = 1;
      rec.onresult = function (e) {
        var finalText = '', interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript + ' ';
          else interim += r[0].transcript + ' ';
        }
        if (finalText.trim()) handleAsrResult(finalText.trim(), 0);
        else if (interim.trim()) updateAsrLive(interim.trim());
      };
      rec.onerror = function (e) {
        var code = e && e.error;
        if (code === 'not-allowed') asrError('麦克风权限被拒绝');
        else if (code === 'no-speech') asrError('没有听到声音');
        else if (code === 'network') asrError('语音服务连不上，请检查网络或系统语音服务');
        else if (code === 'service-not-allowed') asrError('浏览器禁止了语音识别服务');
        else asrError('识别失败：' + (code || '未知错误'));
      };
      rec.onend = function () {
        if (readState.webRec === rec) readState.webRec = null;
        if (readState.asrActive) asrError('没有识别到内容');
      };
      readState.webRec = rec;
      rec.start();
    } catch (e) {
      asrError('无法启动语音识别');
    }
  }

  function stopAsr() {
    readState.asrActive = false;
    readState.asrSeq += 1;
    readState.autoPhase = null;
    if (readState.autoTimer) { clearTimeout(readState.autoTimer); readState.autoTimer = null; }
    try {
      if (readState.desktopAbort) readState.desktopAbort.abort();
    } catch (e) { }
    readState.desktopAbort = null;
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.stopSpeechScore === 'function') {
        window.AndroidBridge.stopSpeechScore();
      }
    } catch (e) { }
    try {
      if (readState.webRec) readState.webRec.abort();
    } catch (e) { }
    readState.webRec = null;
    setScoreButton(null);
  }

  function updateAsrLive(text) {
    var slot = $('#scoreSlot');
    if (slot) slot.innerHTML = '<div class="asr-live">听到：' + esc(text) + '</div>';
    setRecordState('正在听…');
  }

  function asrError(msg) {
    readState.asrActive = false;
    if (readState.autoPhase === 'recording' || readState.autoPhase === 'stopping') {
      if (readState.recording) stopRecording();
    }
    readState.autoPhase = null;
    setScoreButton(null);
    var slot = $('#scoreSlot');
    if (slot) slot.innerHTML = '';
    setRecordState('自动评分没成功：' + msg + '。可以继续自评');
    toast('自动评分不可用，继续自评也行');
  }

  function handleAsrResult(text, confidence) {
    if (!readState.asrActive) return;
    readState.asrActive = false;
    readState.autoPhase = null;
    if (readState.autoTimer) { clearTimeout(readState.autoTimer); readState.autoTimer = null; }
    if (readState.recording) stopRecording();
    setScoreButton(null);
    var s = state.session;
    if (!s || s.answeredNow) return;
    var target = readState.sentence || readState.target || '';
    var result = window.ReadingScore ? window.ReadingScore.score(target, text) : null;
    if (!result) { asrError('评分模块没有加载'); return; }
    result.transcript = text;
    result.confidence = confidence;
    readState.asrScore = result;
    showScorePanel(result);
    setRecordState('识别完成：' + result.score + ' 分，可采纳或自己再评');
  }

  function showScorePanel(result) {
    var slot = $('#scoreSlot');
    if (!slot) return;
    var missed = result.missed || [];
    var missedHtml = missed.length
      ? '<p class="score-missed">没读准：' + missed.slice(0, 14).map(esc).join(' · ') + (missed.length > 14 ? ' …' : '') + '</p>'
      : '<p class="score-missed ok">整句都识别到了</p>';
    var color = result.score >= 90 ? 'great' : result.score >= 70 ? 'good' : result.score >= 45 ? 'warn' : 'bad';
    slot.innerHTML = '<div class="score-panel">' +
      '<div class="score-main ' + color + '"><strong>' + result.score + '</strong><span>分</span><small>' + result.matched + '/' + result.total + ' 词匹配</small></div>' +
      '<div class="score-detail">' +
      '<p class="score-line">识别：' + (result.transcript ? esc(result.transcript) : '（没有听清）') + '</p>' +
      missedHtml +
      '</div>' +
      '<div class="score-actions">' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="accept-score" data-grade="' + result.grade + '">采用 ' + result.score + ' 分</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="close-score">自己再评</button>' +
      '</div>' +
      '</div>';
  }

  window.__onAsrReady = function () { if (readState.asrActive) setRecordState('正在录音并识别，读完再点一下「停止并评分」'); };
  window.__onAsrPartial = function (text) { if (readState.asrActive) updateAsrLive(text); };
  window.__onAsrResult = function (text, confidence) { handleAsrResult(text, confidence); };
  window.__onAsrError = function (msg) { asrError(msg || '系统识别失败'); };

  function setRecordState(text) {
    var el = $('#recordState');
    if (el) el.textContent = text;
  }

  function stopRecording() {
    if (!readState.recorder) return;
    try { if (readState.recorder.state !== 'inactive') readState.recorder.stop(); } catch (e) {}
    readState.recording = false;
    var btn = $('#recordBtn');
    if (btn) {
      btn.classList.remove('is-recording');
      var lab = $('.rec-label', btn);
      if (lab) lab.textContent = '跟读这句话';
    }
    if (readState.timer) { clearInterval(readState.timer); readState.timer = null; }
    if (readState.raf) { cancelAnimationFrame(readState.raf); readState.raf = null; }
    var wave = $('#wave');
    if (wave) wave.hidden = true;
  }

  function startRecording() {
    if (readState.preplaying) {
      // 原声还没播完时再点一次：跳过原声，直接开始录音
      stopPrePlay(true);
      beginRecording();
      return;
    }
    if (readState.recording) return;
    if (readState.asrActive) stopAsr();
    var scoreSlot = $('#scoreSlot');
    if (scoreSlot) scoreSlot.innerHTML = '';
    if (!micSupported()) {
      setRecordState('这个浏览器不支持录音，直接听原声后自评也可以');
      return;
    }
    if (store.settings.prePlay && canSpeak()) {
      prePlayThenRecord();
      return;
    }
    beginRecording();
  }

  function prePlayThenRecord() {
    var btn = $('#recordBtn');
    var token = ++readState.preToken;
    readState.preplaying = true;
    var lab = btn ? $('.rec-label', btn) : null;
    if (btn) btn.classList.add('is-preplaying');
    if (lab) lab.textContent = '先听原声…';
    setRecordState('先听一遍原声，听完自动开始录音…（再点一下可跳过）');

    function startActual() {
      if (token !== readState.preToken || !readState.preplaying) return;
      readState.preplaying = false;
      if (readState.preTimer) { clearTimeout(readState.preTimer); readState.preTimer = null; }
      if (btn) btn.classList.remove('is-preplaying');
      if (lab) lab.textContent = '跟读这句话';
      beginRecording();
    }

    readState.preTimer = setTimeout(startActual, 8000);
    speak(readState.sentence, null, { rate: 0.95, onend: startActual });
  }

  function stopPrePlay(silent) {
    if (readState.preTimer) { clearTimeout(readState.preTimer); readState.preTimer = null; }
    readState.preToken++;
    readState.preplaying = false;
    stopOnlineAudio();
    var btn = $('#recordBtn');
    if (btn) btn.classList.remove('is-preplaying');
    var lab = btn ? $('.rec-label', btn) : null;
    if (lab) lab.textContent = '跟读这句话';
    nativeOnEnd = null;
    try { if (TTS_OK) window.speechSynthesis.cancel(); } catch (e) { }
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.stop === 'function') window.AndroidBridge.stop();
    } catch (e) { }
    if (!silent && state.session) setRecordState('已跳过原声，点一下重新开始');
  }

  function beginRecording() {
    var scoreSlot = $('#scoreSlot');
    if (scoreSlot) scoreSlot.innerHTML = '';
    var btn = $('#recordBtn');
    setRecordState('正在请求麦克风…');
    stopOnlineAudio();
    try { if (TTS_OK) window.speechSynthesis.cancel(); } catch (e) { }
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.stop === 'function') window.AndroidBridge.stop();
    } catch (e) { }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      readState.stream = stream;
      readState.chunks = [];
      var mime = '';
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].some(function (t) {
        try { if (window.MediaRecorder.isTypeSupported(t)) { mime = t; return true; } } catch (e) {}
        return false;
      });
      var mr;
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { mr = new MediaRecorder(stream); }
      readState.recorder = mr;
      mr.ondataavailable = function (e) { if (e.data && e.data.size) readState.chunks.push(e.data); };
      mr.onstop = function () {
        var blob = new Blob(readState.chunks, { type: readState.chunks[0] && readState.chunks[0].type || 'audio/webm' });
        if (readState.url) { try { URL.revokeObjectURL(readState.url); } catch (e) {} }
        readState.url = URL.createObjectURL(blob);
        readState.audio = new Audio(readState.url);
        var actions = $('#recordActions');
        if (actions) actions.hidden = false;
        setRecordState('录好了，点「听我的录音」和原声对比一下');
        if (readState.stream) {
          readState.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
          readState.stream = null;
        }
      };
      mr.start();
      readState.recording = true;
      readState.startedAt = Date.now();
      if (btn) {
        btn.classList.add('is-recording');
        var lab = $('.rec-label', btn);
        if (lab) lab.textContent = '停止录音';
      }
      setRecordState('正在录音… 跟着原声，把整句读完');
      var wave = $('#wave');
      if (wave) wave.hidden = false;
      var actions = $('#recordActions');
      if (actions) actions.hidden = true;

      // 音量条
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        readState.audioCtx = new AC();
        var src = readState.audioCtx.createMediaStreamSource(stream);
        var analyser = readState.audioCtx.createAnalyser();
        analyser.fftSize = 128;
        src.connect(analyser);
        readState.analyser = analyser;
        readState.data = new Uint8Array(analyser.frequencyBinCount);
        var paint = function () {
          if (!readState.analyser || !readState.recording) return;
          readState.analyser.getByteFrequencyData(readState.data);
          var barsEls = $$('#wave i');
          var step = Math.max(1, Math.floor(readState.data.length / 2 / barsEls.length));
          barsEls.forEach(function (b, idx) {
            var v = readState.data[idx * step] / 255;
            b.style.transform = 'scaleY(' + (0.12 + v * 0.88).toFixed(2) + ')';
          });
          readState.raf = requestAnimationFrame(paint);
        };
        paint();
      } catch (e) { /* 没有波形也能录 */ }

      readState.timer = setInterval(function () {
        var sec = Math.round((Date.now() - readState.startedAt) / 1000);
        setRecordState('正在录音… ' + sec + ' 秒（点一下停止）');
        if (sec >= 25) stopRecording();
      }, 500);
    }).catch(function (err) {
      readState.recording = false;
      setRecordState(err && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，可在地址栏左侧重新允许，或直接自评'
        : '没能打开麦克风，检查设备后重试，或直接自评');
      if (btn) {
        btn.classList.remove('is-recording');
        var lab = $('.rec-label', btn);
        if (lab) lab.textContent = '跟读这句话';
      }
    });
  }

  function toggleRecording() {
    if (readState.recording) stopRecording();
    else startRecording();
  }

  function playMyRecording() {
    if (!readState.audio) { setRecordState('还没有录音，先点「跟读这句话」'); return; }
    try {
      readState.audio.currentTime = 0;
      readState.audio.play();
    } catch (e) {}
  }

  function toggleReadWord() {
    var w = readState.word;
    if (!w) return;
    var token = readState.target || w.w;
    showWordPanel(token, w);
  }

  function commitRead(grade) {
    var s = state.session;
    if (!s || s.answeredNow || s.style !== 'read') return;
    s.answeredNow = true;
    var w = BY_ID[s.items[s.idx].id];
    var ms = Date.now() - s.qStart;
    var prev = store.getCard(modeKey(w.id, 'read'));
    var isNew = !prev;
    var g = Math.max(0, Math.min(3, Number(grade)));
    var next = SRS.review(prev || SRS.blank(), g, Date.now());
    store.putCard(modeKey(w.id, 'read'), next);
    store.recordAnswer({ correct: g >= 2, isNew: isNew, ms: ms, mode: 'read' });
    if (g >= 2) {
      store.noteCorrect(w.id);
      s.correct += 1;
      s.combo += 1;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      sfx('ok');
    } else {
      store.addWrong(w.id);
      s.combo = 0;
      sfx('no');
    }
    s.answered += 1;
    s.results.push({ id: w.id, correct: g >= 2, grade: g, mode: 'read', ms: ms, next: next, isNew: isNew });

    if (readState.recording) stopRecording();
    if (readState.asrActive) stopAsr();
    if (readState.preplaying) stopPrePlay(true);
    var scoreSlot = $('#scoreSlot');
    if (scoreSlot) scoreSlot.innerHTML = '';
    var rating = $('#ratingRow');
    if (rating) {
      rating.innerHTML = '<div class="rate-ack">✓ 已记录 · 下次复习 <b>' + esc(SRS.describeInterval(next)) + '</b></div>';
    }
    var card = $('#studyCard');
    if (card) {
      card.classList.add(g >= 2 ? 'pop' : 'shake');
      setTimeout(function () { if (card) card.classList.remove('pop', 'shake'); }, 500);
    }
    $('#studyBar').style.width = Math.round(((s.idx + 1) / s.items.length) * 100) + '%';
    state.autoNextTimer = setTimeout(goNext, 980);
  }

  var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/></svg>';

  function renderKbdHints(mode) {
    var el = $('#kbdHints');
    if (mode === 'choice') el.innerHTML = '<kbd>1</kbd>–<kbd>4</kbd> 选择答案　<kbd>A</kbd> 发音　<kbd>Esc</kbd> 退出';
    else el.innerHTML = '<kbd>Enter</kbd> 检查 / 下一题　<kbd>A</kbd> 发音　<kbd>Esc</kbd> 退出';
  }

  var ICON_SPEAK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9v6h3.5L14 19V5L8.5 9H5Z"/><path d="M17.5 8.5a5 5 0 0 1 0 7M20 6a8.5 8.5 0 0 1 0 12"/></svg>';

  function optionButtons(w) {
    var pool = WORDS.filter(function (x) {
      return x.bankId === w.bankId && x.id !== w.id && x.zh && x.zh !== w.zh;
    });
    var opts = [{ zh: w.zh, correct: true }];
    var seen = {}; seen[w.zh] = true;
    shuffle(pool).forEach(function (x) {
      if (opts.length >= 4 || seen[x.zh]) return;
      seen[x.zh] = true;
      opts.push({ zh: x.zh, correct: false });
    });
    if (opts.length < 4) {
      shuffle(WORDS).forEach(function (x) {
        if (opts.length >= 4 || seen[x.zh] || !x.zh) return;
        seen[x.zh] = true;
        opts.push({ zh: x.zh, correct: false });
      });
    }
    opts = shuffle(opts);
    return opts.map(function (o, i) {
      return '<button class="option" data-opt="' + i + '" data-correct="' + (o.correct ? '1' : '0') + '">' +
        '<span class="key">' + (i + 1) + '</span><span>' + esc(o.zh) + '</span></button>';
    }).join('');
  }

  function blindOptionButtons(w) {
    var correct = w.exzh || w.zh || '';
    var opts = [{ text: correct, correct: true }];
    var seen = {};
    seen[correct] = true;
    var pool = WORDS.filter(function (x) {
      return x.id !== w.id && x.exzh && x.exzh !== correct && !seen[x.exzh];
    });
    var same = pool.filter(function (x) { return x.bankId === w.bankId; });
    shuffle(same.length >= 8 ? same : pool).forEach(function (x) {
      if (opts.length >= 4 || seen[x.exzh]) return;
      seen[x.exzh] = true;
      opts.push({ text: x.exzh, correct: false });
    });
    opts = shuffle(opts);
    return opts.map(function (o, i) {
      return '<button class="option blind-option" data-opt="' + i + '" data-correct="' + (o.correct ? '1' : '0') + '">' +
        '<span class="key">' + (i + 1) + '</span><span>' + esc(o.text) + '</span></button>';
    }).join('');
  }

  function pickOptionButtons(w) {
    var pool = WORDS.filter(function (x) {
      return x.bankId === w.bankId && x.id !== w.id && x.w !== w.w;
    });
    var opts = [{ word: w.w, correct: true }];
    var seen = {}; seen[w.w.toLowerCase()] = true;
    shuffle(pool).forEach(function (x) {
      if (opts.length >= 4 || seen[x.w.toLowerCase()]) return;
      seen[x.w.toLowerCase()] = true;
      opts.push({ word: x.w, correct: false });
    });
    opts = shuffle(opts);
    return opts.map(function (o, i) {
      return '<button class="option" data-opt="' + i + '" data-correct="' + (o.correct ? '1' : '0') + '">' +
        '<span class="key">' + (i + 1) + '</span><span class="pick-word">' + esc(o.word) + '</span></button>';
    }).join('');
  }

  function slotHtml(word) {
    return word.split('').map(function (ch) {
      if (ch === ' ' || ch === '-') return '<span class="slot is-space"></span>';
      return '<span class="slot">_</span>';
    }).join('');
  }

  function blankSentence(w) {
    var safe = esc(w.ex);
    try {
      var re = new RegExp('\\b' + String(w.w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'i');
      return safe.replace(re, function (m) { return '<span class="blank">' + '_'.repeat(Math.min(12, m.length)) + '</span>'; });
    } catch (e) { return safe; }
  }

  /* ---- 答题 ---- */
  function answerChoice(btn) {
    var s = state.session;
    if (!s || s.answeredNow) return;
    var chosenCorrect = btn.dataset.correct === '1';
    $$('#options .option').forEach(function (o) {
      o.disabled = true;
      if (o.dataset.correct === '1') o.classList.add('is-correct');
    });
    if (!chosenCorrect) btn.classList.add('is-wrong');
    var w = BY_ID[s.items[s.idx].id];
    var mode = s.style === 'blind' ? 'blind' : s.items[s.idx].mode === 'pick' ? 'pick' : 'choice';
    commitAnswer({ correct: chosenCorrect, mode: mode, chosen: btn.textContent.trim().slice(1), word: w });
  }

  function submitTyped() {
    var s = state.session;
    if (!s || s.answeredNow) return;
    var input = $('#answerInput');
    if (!input) return;
    var val = input.value.trim();
    var w = BY_ID[s.items[s.idx].id];
    if (!val) {
      input.classList.add('is-wrong');
      input.focus();
      setTimeout(function () { input.classList.remove('is-wrong'); }, 500);
      return;
    }
    var correct = val.toLowerCase().replace(/[.,!?;:'"]/g, '') === w.w.toLowerCase();
    input.disabled = true;
    if (!correct) { input.classList.add('is-wrong'); }
    commitAnswer({ correct: correct, mode: s.items[s.idx].mode, typed: val, word: w });
  }

  function useHint() {
    var s = state.session;
    if (!s || s.answeredNow) return;
    var w = BY_ID[s.items[s.idx].id];
    s.hinted = true;
    var input = $('#answerInput');
    var shown = 0;
    if (input) {
      var val = input.value;
      // 提示：补出前两个字母，再点一次补到一半
      s.hintLevel = (s.hintLevel || 0) + 1;
      shown = Math.min(w.w.length, s.hintLevel === 1 ? 2 : Math.ceil(w.w.length / 2));
      var prefix = w.w.slice(0, shown);
      input.value = shown <= val.length ? val : prefix + val.slice(prefix.length);
      input.focus();
    }
    var slots = $$('#slots .slot').filter(function (el) { return !el.classList.contains('is-space'); });
    var reveal = Math.min(w.w.length, (s.hintLevel || 1) === 1 ? 2 : Math.ceil(w.w.length / 2));
    slots.forEach(function (el, i) {
      if (i < reveal) { el.textContent = w.w[i]; el.classList.add('is-revealed'); }
    });
    var ht = $('#hintText');
    if (ht) ht.textContent = '已提示 ' + reveal + ' 个字母（本题按「模糊」计入复习）';
  }

  function requeueAfterThree(s) {
    var old = s.idx;
    if (old < 0 || old >= s.items.length) return;
    var item = s.items.splice(old, 1)[0];
    var pos = Math.min(old + 3, s.items.length);
    s.items.splice(pos, 0, item);
    s.idx = old;
    s.retryImmediate = pos === old;
  }

  function commitAnswer(info) {
    var s = state.session;
    if (!s || s.answeredNow) return;
    s.answeredNow = true;
    var w = info.word;
    var item = s.items[s.idx];
    var ms = Date.now() - s.qStart;
    var prev = store.getCard(modeKey(w.id, s.style));
    var isNew = !prev;
    var retryable = s.style === 'quiz' || s.style === 'blind';

    // 快刷 / 盲听：答错不结算，排到 3 个词后重来，直到答对
    if (!info.correct && retryable) {
      s.combo = 0;
      sfx('no');
      var card2 = $('#studyCard');
      if (card2) {
        card2.classList.add('shake');
        setTimeout(function () { card2.classList.remove('shake'); }, 420);
      }
      requeueAfterThree(s);
      renderFeedback(w, { correct: false, retry: true, typed: info.typed || '', chosen: info.chosen || '' }, prev || SRS.blank(), isNew, item.mode, ms);
      updateHud();
      $('#studyCount').textContent = (s.idx + 1) + ' / ' + s.items.length;
      $('#studyBar').style.width = Math.round((s.idx / s.items.length) * 100) + '%';
      $('#kbdHints').innerHTML = '<kbd>Enter</kbd> 下一题　<kbd>Space</kbd> 下一题　<kbd>A</kbd> 发音　<kbd>Esc</kbd> 退出';
      return;
    }

    var grade = SRS.gradeFromResult({ correct: info.correct, hint: s.hinted, ms: ms });
    var next = SRS.review(prev || SRS.blank(), grade, Date.now());

    store.putCard(modeKey(w.id, s.style), next);
    store.recordAnswer({ correct: info.correct, isNew: isNew, ms: ms, mode: s.style, answerMode: info.mode || item.mode || 'read' });
    if (info.correct) { store.noteCorrect(w.id); s.correct += 1; s.combo += 1; s.maxCombo = Math.max(s.maxCombo, s.combo); }
    else { store.addWrong(w.id); s.combo = 0; }
    s.answered += 1;
    s.results.push({ id: w.id, correct: info.correct, mode: item.mode, ms: ms, grade: grade, next: next, isNew: isNew, typed: info.typed || '' });

    if (info.correct) sfx('ok'); else sfx('no');
    if (info.correct) {
      var card = $('#studyCard');
      card.classList.add('pop');
      setTimeout(function () { card.classList.remove('pop'); }, 500);
    } else {
      var card2 = $('#studyCard');
      card2.classList.add('shake');
      setTimeout(function () { card2.classList.remove('shake'); }, 420);
    }

    renderFeedback(w, info, next, isNew, item.mode, ms);
    updateHud();
    $('#studyCount').textContent = (s.idx + 1) + ' / ' + s.items.length;
    $('#studyBar').style.width = Math.round(((s.idx + 1) / s.items.length) * 100) + '%';
    $('#kbdHints').innerHTML = '<kbd>Enter</kbd> 下一题　<kbd>Space</kbd> 下一题　<kbd>A</kbd> 发音　<kbd>Esc</kbd> 退出';

    if (info.correct && store.settings.autoNext) {
      state.autoNextTimer = setTimeout(goNext, item.mode === 'choice' ? 1500 : 1900);
    }
  }

  function renderFeedback(w, info, next, isNew, mode, ms) {
    var slot = $('#feedbackSlot');
    if (!slot) return;
    var head = info.correct
      ? '<div class="feedback-head ok">✓ 答对了</div>'
      : (info.retry ? '<div class="feedback-head no">✗ 选错了，3 个词后再来</div>' : '<div class="feedback-head no">✗ 再记一下</div>');
    var typedNote = '';
    if (!info.correct && info.typed) {
      typedNote = '<div class="typed-note">你写的是 <s>' + esc(info.typed) + '</s></div>';
    }
    var ex = w.ex ? '<div class="feedback-ex">' + highlight(w.ex, w.w) + '<div class="feedback-exzh">' + esc(w.exzh || '') + '</div></div>' : '';
    var dueText = info.retry ? '3 个词后重来' : SRS.describeInterval(next);
    slot.innerHTML = '<div class="feedback">' + head +
      '<div class="feedback-word-row"><span class="feedback-answer">' + esc(w.w) + '</span>' +
      (w.ph ? '<span class="feedback-ph">/' + esc(w.ph) + '/</span>' : '') +
      '<button class="icon-btn small" data-action="speak" aria-label="播放发音">' + ICON_SPEAK + '</button></div>' +
      '<div class="feedback-zh">' + esc(w.zh) + (w.pos ? ' · ' + esc(w.pos) : '') + '</div>' +
      typedNote + ex +
      '<div class="feedback-actions">' +
      '<button class="btn btn-primary btn-sm" data-action="next">继续 <span class="kbd-inline">Enter</span></button>' +
      '<span class="note">' + (info.retry ? '答错不记错词，3 个词后会再出现' : '下次复习：' + esc(dueText)) + (isNew ? ' · 已计入今日新词' : '') + (ms > 12000 ? ' · 用时偏长' : '') + '</span>' +
      '</div></div>';

    if (store.settings.autoplay) {
      var b = $('[data-action="speak"]', slot);
      speak(mode === 'blind' ? (w.ex || w.w) : w.w, b, { rate: mode === 'blind' ? 0.95 : 0.9 });
    }
  }

  function goNext() {
    var s = state.session;
    if (!s) return;
    if (state.autoNextTimer) { clearTimeout(state.autoNextTimer); state.autoNextTimer = null; }
    if (s.retryImmediate) {
      s.retryImmediate = false;
      s.answeredNow = false;
      renderStudy();
      return;
    }
    if (!s.answeredNow && s.idx < s.items.length) {
      // 未作答时直接进入下一题，视为跳过，不计入统计
      s.idx += 1;
    } else {
      s.idx += 1;
    }
    renderStudy();
  }

  function skipCurrent() {
    var s = state.session;
    if (!s) return;
    var w = BY_ID[s.items[s.idx].id];
    if (w) store.setCardStatus(modeKey(w.id, s.style), 'mastered');
    if (s.single && !s.answeredNow) {
      stopStudyTimer();
      cleanupReadMedia();
      state.session = null;
      setView('library');
      toast('已把「' + (w ? w.w : '这个词') + '」标为已掌握');
      return;
    }
    if (w) toast('已把「' + w.w + '」标为已掌握');
    if (s.answeredNow) { goNext(); return; }
    s.idx += 1;
    renderStudy();
  }

  /* ---- 结算 ---- */
  function finishSession() {
    var s = state.session;
    stopStudyTimer();
    if (!s) return;
    cleanupReadMedia();
    var answered = s.answered || 0;
    var acc = answered ? Math.round((s.correct / answered) * 100) : 0;
    var wrongIds = [];
    var seen = {};
    s.results.forEach(function (r) { if (!r.correct && !seen[r.id]) { seen[r.id] = true; wrongIds.push(r.id); } });
    var isRead = s.style === 'read';
    var isBlind = s.style === 'blind';

    $('#resultAcc').textContent = acc + '%';
    setRing($('#resultRing'), acc / 100, 377);
    $('#resultAccLabel').textContent = isRead ? '本组顺畅率' : '本组正确率';
    $('#resultCountLabel').textContent = isRead ? '跟读' : isBlind ? '盲听' : '刷词';
    $('#resultCount').textContent = answered;
    $('#resultTime').textContent = fmtClock(Date.now() - s.startAt);
    $('#resultNew').textContent = s.results.filter(function (r) { return r.isNew; }).length;
    $('#resultCombo').textContent = s.maxCombo;
    $('#resultComboLabel').textContent = isRead ? '最高连顺' : '最高连对';
    $('#resultTitle').textContent = isRead
      ? (acc >= 90 ? '这几句，读得很顺。' : acc >= 70 ? '节奏稳了，继续读。' : acc >= 50 ? '有几处卡壳，再读一遍会更顺。' : '别急，先跟着原声慢慢来。')
      : isBlind
        ? (acc >= 90 ? '耳朵已经跟上了。' : acc >= 70 ? '大意听懂了，继续。' : acc >= 50 ? '再听一遍，抓住关键词。' : '先听慢一点，别急着选。')
        : (acc >= 90 ? '这一组，干净利落。' : acc >= 70 ? '稳稳的，语感在长。' : acc >= 50 ? '有进步，错词再刷一遍。' : '别急，先混个脸熟。');
    $('#resultEyebrow').textContent = s.label || '本组完成';
    $('#resultSub').textContent = answered
      ? (isRead
        ? '这一组读顺 ' + s.correct + ' 句，卡壳 ' + (answered - s.correct) + ' 句。读不顺的句子会更快回到队列，明天再读一遍。'
        : isBlind
          ? '这一组听对 ' + s.correct + ' 句，听错 ' + (answered - s.correct) + ' 句。听错的句子会回到队列，下次再听。'
          : '这一组答对 ' + s.correct + ' 个，答错 ' + (answered - s.correct) + ' 个。按当前节奏，明天会有一批词准时回来找你。')
      : '这一组没有计入统计。下次试着跟着原声读完一句。';

    $('#resultWrongTitle').textContent = isRead ? '需要再读一遍的句子' : isBlind ? '需要再听一遍的句子' : '这一组需要再看一眼的词';
    $('#resultWrongSub').textContent = isRead ? '读不顺的句子已自动加入错词本' : isBlind ? '没听对的句子已自动加入错词本' : '已自动加入错词本';
    $('#againWrongBtn').textContent = isRead ? '重读这些句子' : isBlind ? '重听这些句子' : '重刷错词';
    $('#resultWrongCard').hidden = wrongIds.length === 0;
    $('#resultWrongList').innerHTML = wrongIds.map(function (id) {
      var w = BY_ID[id];
      var r = s.results.filter(function (x) { return x.id === id; })[0];
      var gradeLabel = isBlind ? '再听' : (r && r.grade === 0 ? '没读出来' : (r && r.grade === 1 ? '有点卡' : '再练'));
      return '<li data-word="' + esc(id) + '" style="--bank-color:' + esc(w.color) + '">' +
        '<span class="w">' + esc(w.w) + '</span>' +
        '<span class="z">' + (isRead && w.ex ? highlight(w.ex, w.w) : isBlind ? esc(w.exzh || w.zh) : esc(w.zh)) + '</span>' +
        '<span class="count">' + gradeLabel + '</span></li>';
    }).join('');

    $('#againWrongBtn').hidden = wrongIds.length === 0;
    state.lastResult = { wrongIds: wrongIds, cfg: s.cfg, style: s.style };
    state.session = null;
    setView('result');
    if (acc >= 80 && answered >= 5) confetti();
  }

  $('#resultWrongList').addEventListener('click', function (e) {
    var li = e.target.closest('[data-word]');
    if (li) openWordModal(li.dataset.word);
  });

  $('#againWrongBtn').addEventListener('click', function () {
    var lr = state.lastResult;
    if (!lr || !lr.wrongIds.length) return;
    startSession({ ids: lr.wrongIds, style: lr.style, label: lr.style === 'read' ? '重读错句' : lr.style === 'blind' ? '重听错句' : '重刷错词', cfg: lr.cfg });
  });
  $('#againSameBtn').addEventListener('click', function () {
    if (lastCfg) {
      startSession({ bankIds: lastCfg.bankIds, ids: lastCfg.ids, focus: lastCfg.focus, size: lastCfg.size, label: lastCfg.label, style: lastCfg.style });
    } else setView('home');
  });
  $('#backHomeBtn').addEventListener('click', function () { setView('home'); });

  /* ---------------- 设置 ---------------- */
  function currentVoiceLabel() {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.getTtsVoiceName === 'function') {
        return window.AndroidBridge.getTtsVoiceName() || '系统默认';
      }
    } catch (e) { }
    var v = pickWebVoice();
    return v ? (v.name || '系统默认') : '系统默认';
  }

  function openSettings() {
    var s = store.settings;
    var m = openModal(
      '<button class="icon-btn modal-close" data-close aria-label="关闭">✕</button>' +
      '<h2>设置</h2><p class="modal-sub">调成自己顺手的节奏，比任何技巧都重要</p>' +
      '<div class="field"><label>每组数量<span class="val" id="vSize">' + s.sessionSize + '</span></label>' +
      '<div class="seg" data-seg="sessionSize">' + [10, 20, 30, 50].map(function (n) {
        return '<button data-value="' + n + '" class="' + (Number(s.sessionSize) === n ? 'is-active' : '') + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="custom-line"><span>自定义</span><input class="num-input" id="sizeCustom" type="number" min="5" max="200" step="1" value="' + s.sessionSize + '" /><span>个</span></div></div>' +
      '<div class="field"><label>每日新词上限<span class="val" id="vNew">' + s.newPerDay + '</span></label>' +
      '<div class="seg" data-seg="newPerDay">' + [5, 10, 15, 25, 40].map(function (n) {
        return '<button data-value="' + n + '" class="' + (Number(s.newPerDay) === n ? 'is-active' : '') + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="custom-line"><span>自定义</span><input class="num-input" id="newCustom" type="number" min="0" max="200" step="1" value="' + s.newPerDay + '" /><span>个</span></div></div>' +
      '<div class="field"><label>每日跟读目标<span class="val" id="vGoal">' + s.dailyGoal + '</span></label>' +
      '<input type="range" id="goalRange" min="10" max="500" step="1" value="' + Math.min(500, s.dailyGoal) + '" />' +
      '<div class="custom-line"><span>自定义</span><input class="num-input" id="goalCustom" type="number" min="10" max="500" step="5" value="' + Math.min(500, s.dailyGoal) + '" /><span>个/天</span></div></div>' +
      '<div class="field"><label>跟读与刷词偏好</label>' +
      switchRow('autoNext', '快刷答对后自动下一题', s.autoNext) +
      switchRow('prePlay', '点录音后先播放原声，再开始录音', s.prePlay) +
      switchRow('sound', '作答音效', s.sound) +
      '</div>' +
      '<div class="field"><label>快刷题型</label><div class="seg" data-seg="quizType">' +
      [['choice', '看词选义'], ['pick', '据义择词'], ['spell', '拼写'], ['mix', '混合']].map(function (t) {
        return '<button data-value="' + t[0] + '" class="' + (s.quizType === t[0] ? 'is-active' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>朗读音色</label>' +
      switchRow('onlineTts', '优先在线自然发音（需联网）', s.onlineTts) +
      '<p class="field-note" id="voiceName">当前：' + esc(currentVoiceLabel()) + '</p>' +
      '<div class="voice-row">' +
      '<button type="button" class="mini-btn" data-action="tts-demo">试听</button>' +
      (window.AndroidBridge && typeof window.AndroidBridge.openTtsSettings === 'function'
        ? '<button type="button" class="mini-btn" data-action="tts-settings">系统语音设置</button>'
        : '') +
      '</div>' +
      '<p class="field-note">在线发音：单词用有道，整句用百度；断网、超时或接口不可用时自动退回系统 TTS。朗读文本会发送到对应语音服务。</p>' +
      '</div>' +
      '<div class="field"><label>自动评分</label>' +
      '<p class="field-note">' + (asrAvailable()
        ? (window.AndroidBridge ? '可用：先播放例句，再自动录音；读完点「停止并评分」。识别服务不可用时仍可自评。' : '可用：先播放例句，再自动录音；读完点「停止并评分」。')
        : '当前设备没有可用的语音识别服务，可以继续用四档自评。') + '</p>' +
      '</div>' +
      '<div class="field"><label>每日提醒</label>' +
      switchRow('reminderOn', '到点提醒我刷词', s.reminderOn) +
      '<div class="custom-line"><span>提醒时间</span><input class="num-input time-input" type="time" id="reminderTime" value="' + esc(s.reminderTime || '20:30') + '" /><span>每天</span></div>' +
      '<p class="field-note">Android 会发系统通知（需允许通知权限）；网页/桌面版需要保持窗口打开。到点未打卡时也会在首页提示。</p>' +
      '</div>' +
      '<div class="field"><label>主题</label><div class="seg" data-seg="theme">' +
      [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(function (t) {
        return '<button data-value="' + t[0] + '" class="' + (s.theme === t[0] ? 'is-active' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="modal-actions" style="justify-content:space-between">' +
      '<button class="btn btn-ghost btn-sm" id="openDataBtn">数据管理</button>' +
      '<button class="btn btn-primary" data-close>完成</button>' +
      '</div>'
    );

    $$('[data-seg]', m).forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-value]');
        if (!btn) return;
        var key = seg.dataset.seg;
        var val = btn.dataset.value;
        if (key === 'theme') store.setSetting('theme', val);
        else if (key === 'quizType') store.setSetting('quizType', val);
        else store.setSetting(key, Number(val));
        $$('button', seg).forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        if (key === 'sessionSize') { $('#vSize').textContent = val; $('#sizeCustom').value = val; }
        if (key === 'newPerDay') { $('#vNew').textContent = val; $('#newCustom').value = val; }
        if (key === 'theme') applyTheme();
        renderHome();
      });
    });

    function setSegActive(key, val) {
      var seg = $('[data-seg="' + key + '"]', m);
      if (!seg) return;
      $$('button', seg).forEach(function (b) {
        b.classList.toggle('is-active', Number(b.dataset.value) === Number(val));
      });
    }

    function readNumber(id, min, max, fallback) {
      var el = $('#' + id);
      var v = parseInt(el.value, 10);
      if (isNaN(v)) v = fallback;
      v = Math.max(min, Math.min(max, v));
      el.value = v;
      return v;
    }

    $('#sizeCustom').addEventListener('change', function () {
      var v = readNumber('sizeCustom', 5, 200, 20);
      store.setSetting('sessionSize', v);
      $('#vSize').textContent = v;
      setSegActive('sessionSize', v);
      renderHome();
    });

    $('#newCustom').addEventListener('change', function () {
      var v = readNumber('newCustom', 0, 200, 15);
      store.setSetting('newPerDay', v);
      $('#vNew').textContent = v;
      setSegActive('newPerDay', v);
      renderHome();
    });

    $('#goalCustom').addEventListener('change', function () {
      var v = readNumber('goalCustom', 10, 500, 40);
      store.setSetting('dailyGoal', v);
      $('#vGoal').textContent = v;
      $('#goalRange').value = v;
      renderHome();
    });

    $$('.switch-row', m).forEach(function (row) {
      row.addEventListener('click', function () {
        var key = row.dataset.key;
        var on = !row.querySelector('.switch').classList.contains('on');
        store.setSetting(key, on);
        row.querySelector('.switch').classList.toggle('on', on);
        if (key === 'prePlay') renderTtsBtn();
        if (key === 'reminderOn') syncReminder(on);
      });
    });
    $('#reminderTime').addEventListener('change', function () {
      var t = this.value || '20:30';
      store.setSetting('reminderTime', t);
      if (store.settings.reminderOn) syncReminder(false);
    });
    $('#goalRange').addEventListener('input', function (e) {
      var v = Number(e.target.value);
      $('#vGoal').textContent = v;
      $('#goalCustom').value = v;
      store.setSetting('dailyGoal', v);
      renderHome();
    });
    $('#openDataBtn').addEventListener('click', openDataModal);
  }

  function switchRow(key, label, on) {
    return '<div class="switch-row" data-key="' + key + '"><span>' + esc(label) + '</span><span class="switch' + (on ? ' on' : '') + '"></span></div>';
  }

  $('#settingsBtn').addEventListener('click', openSettings);

  /* ---------------- 数据管理 ---------------- */
  function openDataModal() {
    var m = openModal(
      '<button class="icon-btn modal-close" data-close aria-label="关闭">✕</button>' +
      '<h2>数据管理</h2><p class="modal-sub">学习记录只存在这台设备的浏览器里，换设备请先导出备份</p>' +
      '<div class="data-actions">' +
      '<button class="btn btn-ghost btn-sm" id="exportBackup">导出备份 (JSON)</button>' +
      '<button class="btn btn-ghost btn-sm" id="importBackup">导入备份</button>' +
      '<button class="btn btn-ghost btn-sm" id="exportCsv">导出词表 (CSV)</button>' +
      '<button class="btn btn-ghost btn-sm danger-text" id="resetProgress">清空学习进度</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<h3 style="margin-bottom:6px">导入自己的词单</h3>' +
      '<p class="modal-sub">支持每行一个词：<code>单词 释义</code>、<code>单词 | 释义</code>、<code>单词,释义</code>，也可以只写单词（自动匹配词库释义与例句）；也支持粘贴 JSON 数组。</p>' +
      '<textarea id="importWords" placeholder="abandon 放弃，抛弃&#10;benefit | 好处；利益&#10;contribute, 贡献；促成"></textarea>' +
      '<div class="import-hint">导入后会自动出现在首页的「我的词库」中，也可以导入带 JSON 字段的 <code>[{&quot;w&quot;:&quot;...&quot;,&quot;zh&quot;:&quot;...&quot;}]</code>。</div>' +
      '<div class="modal-actions"><span class="import-status" id="importStatus"></span><button class="btn btn-primary btn-sm" id="doImport">导入</button></div>' +
      '<input type="file" id="backupFile" accept=".json,application/json" hidden />'
    );

    $('#exportBackup').addEventListener('click', function () {
      download('wordsense-backup-' + todayKey().replace(/-/g, '') + '.json', JSON.stringify(store.exportAll(), null, 2), 'application/json');
      toast('备份已导出');
    });
    $('#importBackup').addEventListener('click', function () { $('#backupFile').click(); });
    $('#backupFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          store.importAll(JSON.parse(String(reader.result)));
          refreshBanks();
          refreshAfterChange();
          closeModal();
          toast('备份已恢复');
        } catch (err) { toast('导入失败：' + err.message); }
      };
      reader.readAsText(file, 'utf-8');
    });
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#resetProgress').addEventListener('click', function () {
      confirmAction('清空学习进度？', '所有卡片记录、统计和错词本都会消失，导入的自定义词会保留。此操作不可撤销。', '确认清空', function () {
        store.resetProgress();
        refreshAfterChange();
        toast('学习进度已清空');
      }, true);
    });
    $('#doImport').addEventListener('click', function () {
      var text = $('#importWords').value || '';
      var parsed = parseWordText(text);
      if (!parsed.length) { $('#importStatus').textContent = '没有识别到有效单词'; return; }
      // 如果导入的词在现有词库里，自动补上音标/例句/翻译，跟读时就有句子可读
      var missing = 0;
      parsed = parsed.map(function (w) {
        var hit = DICT[w.w.toLowerCase()];
        if (!hit) return w;
        return {
          w: hit.w,
          zh: w.zh || hit.zh,
          ph: hit.ph || w.ph || '',
          pos: hit.pos || w.pos || '',
          ex: hit.ex || w.ex || '',
          exzh: hit.exzh || w.exzh || ''
        };
      }).filter(function (w) {
        if (!w.zh) { missing += 1; return false; }
        return true;
      });
      if (!parsed.length) {
        $('#importStatus').textContent = '没有可导入的词' + (missing ? '（' + missing + ' 个词未在词库中找到）' : '');
        return;
      }
      var added = store.addCustom(parsed);
      refreshBanks();
      refreshAfterChange();
      $('#importStatus').textContent = '成功导入 ' + added + ' 个词' +
        (added < parsed.length ? '（' + (parsed.length - added) + ' 个重复已跳过）' : '') +
        (missing ? '；' + missing + ' 个词未在词库中找到' : '');
      toast('已导入 ' + added + ' 个词');
      if (added) setTimeout(closeModal, 700);
    });
  }

  function parseWordText(text) {
    var raw = String(text || '').trim();
    if (!raw) return [];
    var out = [];
    if (raw[0] === '[' || raw[0] === '{') {
      try {
        var json = JSON.parse(raw);
        if (!Array.isArray(json)) json = [json];
        json.forEach(function (o) {
          var w = String(o.w || o.word || '').trim();
          var zh = String(o.zh || o.meaning || o.translation || o.cn || '').trim();
          if (!w || !zh || !/[a-zA-Z]/.test(w)) return;
          out.push({ w: w, zh: zh, ph: String(o.ph || o.phonetic || ''), pos: String(o.pos || ''), ex: String(o.ex || o.example || ''), exzh: String(o.exzh || '') });
        });
        return dedupe(out);
      } catch (e) { /* 继续按行解析 */ }
    }
    raw.split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s || s[0] === '#' || s.indexOf('//') === 0) return;
      var w = '', zh = '';
      var m = s.match(/^([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)?)\s*[\t|,，;；:：]\s*(.+)$/);
      if (m) {
        w = m[1]; zh = m[2];
      } else {
        var m2 = s.match(/^([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)?)\s+(.*[\u4e00-\u9fa5].*)$/);
        if (m2) { w = m2[1]; zh = m2[2]; }
      }
      if (!w || !zh) return;
      zh = zh.replace(/^[（(]\s*/, '').replace(/\s*[)）]$/, '').trim();
      out.push({ w: w.trim(), zh: zh, ph: '', pos: '', ex: '', exzh: '' });
    });
    // 只有单词、没有释义的行（方便直接粘贴词书词单，稍后自动匹配释义）
    raw.split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s || !/^[A-Za-z][A-Za-z'\-]*$/.test(s)) return;
      out.push({ w: s, zh: '', ph: '', pos: '', ex: '', exzh: '' });
    });
    return dedupe(out);
  }
  function dedupe(list) {
    var seen = {};
    return list.filter(function (w) {
      var k = w.w.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function exportCsv() {
    var rows = [['word', 'phonetic', 'pos', 'meaning', 'bank', 'status', 'reps', 'lapses', 'due', 'example']];
    WORDS.forEach(function (w) {
      var c = cardOf(w.id, libState.mode);
      rows.push([w.w, w.ph, w.pos, w.zh, w.bankName, STATUS_LABEL[wordStatus(w, libState.mode)], c ? c.reps : 0, c ? c.lapses : 0, c && c.due ? new Date(c.due).toISOString() : '', w.ex]);
    });
    var csv = '\ufeff' + rows.map(function (r) {
      return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    download('wordsense-words-' + todayKey().replace(/-/g, '') + '.csv', csv, 'text/csv;charset=utf-8');
    toast('词表已导出');
  }

  function textToBase64(str) {
    var bytes;
    if (typeof TextEncoder !== 'undefined') {
      bytes = new TextEncoder().encode(str);
    } else {
      var utf8 = unescape(encodeURIComponent(str));
      bytes = new Uint8Array(utf8.length);
      for (var i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i);
    }
    var bin = '';
    for (var j = 0; j < bytes.length; j += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
    }
    return btoa(bin);
  }

  function download(filename, content, mime) {
    // Android 版：WebView 里 blob 下载不可用，交给原生保存到下载目录
    if (window.AndroidBridge && typeof window.AndroidBridge.saveTextFile === 'function') {
      try {
        var b64 = textToBase64(String(content));
        var saved;
        if (b64.length > 250000 && typeof window.AndroidBridge.beginSave === 'function') {
          // 大文件分块过桥，避免 Binder 事务过大（词表 CSV 可到 1 MB 以上）
          window.AndroidBridge.beginSave(filename, mime || 'text/plain');
          try {
            for (var i = 0; i < b64.length; i += 200000) {
              window.AndroidBridge.appendSave(b64.substring(i, i + 200000));
            }
            saved = window.AndroidBridge.endSave();
          } catch (err) {
            window.AndroidBridge.cancelSave();
            throw err;
          }
        } else {
          saved = window.AndroidBridge.saveTextFile(filename, b64, mime || 'text/plain');
        }
        if (saved && String(saved).indexOf('失败') === 0) toast(String(saved));
        else toast('已保存到 ' + (saved || '下载目录'));
        return;
      } catch (e) { /* 退回浏览器下载 */ }
    }
    try {
      var blob = new Blob([content], { type: mime || 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (e) { toast('导出失败：' + e.message); }
  }

  /* ---------------- 其他交互 ---------------- */
  var QUIZ_TYPES = [
    ['choice', '看词选义', '看英文单词，选中文释义'],
    ['pick', '据义择词', '看中文释义，选英文单词'],
    ['spell', '拼写', '看释义，拼出完整单词'],
    ['mix', '混合模式', '四种题型自动轮换']
  ];

  function openQuizPicker(opts) {
    opts = opts || {};
    var m = openModal(
      '<button class="icon-btn modal-close" data-close aria-label="关闭">✕</button>' +
      '<h2>选择快刷题型</h2><p class="modal-sub">选好后立即开始；之后也可以在设置里改默认题型</p>' +
      '<div class="quiz-type-grid">' +
      QUIZ_TYPES.map(function (t) {
        return '<button type="button" class="quiz-type-btn" data-quiz-type="' + t[0] + '">' +
          '<strong>' + t[1] + '</strong><span>' + t[2] + '</span></button>';
      }).join('') +
      '</div>'
    );
    $$('[data-quiz-type]', m).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.dataset.quizType;
        var title = (QUIZ_TYPES.filter(function (x) { return x[0] === type; })[0] || [])[1] || '极速刷词';
        store.setSetting('quizType', type);
        closeModal();
        startSession({
          bankIds: opts.bankIds || null,
          style: 'quiz',
          focus: opts.focus || 'mix',
          strict: !!opts.strict,
          size: opts.size || store.settings.sessionSize,
          label: (opts.label || '极速刷词') + ' · ' + title,
          quizType: type
        });
      });
    });
  }

  $('#startReviewBtn').addEventListener('click', function () {
    var bankId = store.settings.homeBank || 'all';
    var bankIds = bankId === 'all' ? null : [bankId];
    var bankName = bankId === 'all' ? '' : ((bankById(bankId) || {}).name || '词库');
    startSession({ bankIds: bankIds, style: 'read', focus: 'mix', size: store.settings.sessionSize, label: bankName ? bankName + '跟读' : '今日跟读' });
  });
  var BANK_SELECTS = [['homeBankSelect', 'homeBank']];
  function initBankSelects() {
    BANK_SELECTS.forEach(function (pair) {
      var sel = $('#' + pair[0]);
      if (!sel) return;
      sel.innerHTML = '<option value="all">全部词书</option>' + BANKS.map(function (b) {
        return '<option value="' + b.id + '">' + esc(b.name) + '</option>';
      }).join('');
      sel.value = store.settings[pair[1]] || 'all';
      sel.addEventListener('change', function (e) {
        store.setSetting(pair[1], e.target.value);
        renderHome();
      });
    });
  }
  function bankIdsOf() {
    var id = store.settings.homeBank || 'all';
    return id === 'all' ? null : [id];
  }
  $('#startNewBtn').addEventListener('click', function () {
    var bankIds = bankIdsOf();
    var pool = poolOf(bankIds);
    var fresh = pool.filter(function (w) { return isNewWord(w, 'quiz'); }).length;
    var quota = Math.min(store.newWordsLeft('quiz'), fresh);
    if (quota <= 0) { toast(store.newWordsLeft('quiz') <= 0 ? '今日新词额度已用完' : '当前词书没有新词了'); return; }
    openQuizPicker({
      label: '极速刷词',
      bankIds: bankIds,
      focus: 'new',
      strict: true,
      size: Math.min(store.settings.sessionSize, quota)
    });
  });
  $('#startQuizReviewBtn').addEventListener('click', function () {
    var bankIds = bankIdsOf();
    var pool = poolOf(bankIds);
    var due = pool.filter(function (w) { return isDueWord(w, Date.now(), 'quiz'); }).length;
    if (!due) { toast('当前词书暂时没有要复习的词'); return; }
    openQuizPicker({
      label: '刷词复习',
      bankIds: bankIds,
      focus: 'review',
      strict: true,
      size: Math.min(store.settings.sessionSize, due)
    });
  });
  $('#startBlindBtn').addEventListener('click', function () {
    if (!canSpeak()) { toast('当前设备没有可用的语音朗读，盲听模式需要系统 TTS'); return; }
    startSession({ bankIds: bankIdsOf(), style: 'blind', focus: 'mix', size: store.settings.sessionSize, label: '盲听选义' });
  });
  $('#tipNext').addEventListener('click', function () {
    tipIndex = (tipIndex + 1) % TIPS.length;
    $('#tipText').textContent = TIPS[tipIndex];
  });
  $('#dataBtn').addEventListener('click', openDataModal);
  $('#bankGrid').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-bank-play]');
    if (!btn) return;
    var id = btn.dataset.bankPlay;
    var style = btn.dataset.style === 'quiz' ? 'quiz' : btn.dataset.style === 'blind' ? 'blind' : 'read';
    if (style === 'blind' && !canSpeak()) { toast('当前设备没有可用的语音朗读，盲听模式需要系统 TTS'); return; }
    var bankName = (bankById(id) || {}).name || '词库';
    if (style === 'quiz') {
      openQuizPicker({ bankIds: [id], label: bankName });
      return;
    }
    startSession({
      bankIds: [id],
      style: style,
      focus: 'mix',
      size: store.settings.sessionSize,
      label: ((bankById(id) || {}).name || '词库') + (style === 'read' ? ' · 跟读' : style === 'blind' ? ' · 盲听' : ' · 快刷')
    });
  });

  /* 学习页事件 */
  $('#cardStage').addEventListener('click', function (e) {
    var tokenBtn = e.target.closest('[data-token]');
    if (tokenBtn) {
      var s0 = state.session;
      if (s0 && s0.style === 'read') {
        var word0 = BY_ID[s0.items[s0.idx].id];
        var tok = tokenBtn.dataset.token;
        var entry0 = (readState.target && tok.toLowerCase() === readState.target.toLowerCase()) ? word0 : lookupEntry(tok);
        showWordPanel(tok, entry0);
      }
      return;
    }
    var speakToken = e.target.closest('[data-speak-token]');
    if (speakToken) {
      speak(speakToken.dataset.speakToken, speakToken);
      return;
    }
    var gradeBtn = e.target.closest('[data-grade]');
    if (gradeBtn) { commitRead(Number(gradeBtn.dataset.grade)); return; }

    var target = e.target.closest('[data-action]');
    if (target) {
      var action = target.dataset.action;
      if (action === 'speak') {
        var s = state.session;
        if (!s) return;
        var w = BY_ID[s.items[s.idx].id];
        speak(w.w, target);
        return;
      }
      if (action === 'say') {
        var s1 = state.session;
        if (!s1) return;
        var word1 = BY_ID[s1.items[s1.idx].id];
        speak(word1.ex || word1.w, target, { rate: 0.95 });
        return;
      }
      if (action === 'say-slow') {
        var s2 = state.session;
        if (!s2) return;
        var word2 = BY_ID[s2.items[s2.idx].id];
        speak(word2.ex || word2.w, target, { rate: 0.68 });
        return;
      }
      if (action === 'toggle-zh') { toggleSentenceZh(); return; }
      if (action === 'toggle-word') { toggleReadWord(); return; }
      if (action === 'close-word') { var panel = $('#wordPanel'); if (panel) panel.hidden = true; return; }
      if (action === 'tts-demo') {
        speak('Learning a language is a journey, not a race.', target, { rate: 0.92 });
        return;
      }
      if (action === 'tts-settings') {
        try {
          if (window.AndroidBridge && typeof window.AndroidBridge.openTtsSettings === 'function') {
            window.AndroidBridge.openTtsSettings();
          }
        } catch (e) { }
        return;
      }
      if (action === 'score') { startAutoScore(); return; }
      if (action === 'accept-score') {
        var scoreSlot = $('#scoreSlot');
        if (scoreSlot) scoreSlot.innerHTML = '';
        commitRead(Number(target.dataset.grade));
        return;
      }
      if (action === 'close-score') {
        var slot2 = $('#scoreSlot'); if (slot2) slot2.innerHTML = '';
        setRecordState('可以按下面的四档自评');
        return;
      }
      if (action === 'record') { toggleRecording(); return; }
      if (action === 'play-mine') { playMyRecording(); return; }
      if (action === 'clear-rec') {
        if (readState.audio) { try { readState.audio.pause(); } catch (err) {} readState.audio = null; }
        if (readState.url) { try { URL.revokeObjectURL(readState.url); } catch (err) {} readState.url = null; }
        var acts = $('#recordActions'); if (acts) acts.hidden = true;
        setRecordState('清掉了，重新点一下开始录音');
        return;
      }
      if (action === 'hint') { useHint(); return; }
      if (action === 'submit') { submitTyped(); return; }
      if (action === 'next') { goNext(); return; }
    }
    var opt = e.target.closest('.option');
    if (opt && !opt.disabled) { answerChoice(opt); }
  });
  $('#skipBtn').addEventListener('click', skipCurrent);
  $('#quitBtn').addEventListener('click', function () {
    if (!state.session) { setView('home'); return; }
    confirmAction('退出这一组？', '已经读过的句子会保留进度，没读到的会留在队列里。', '退出', function () {
      stopStudyTimer();
      cleanupReadMedia();
      state.session = null;
      setView('home');
    });
  });

  function renderTtsBtn() {
    var b = $('#ttsBtn');
    if (!b) return;
    b.hidden = !canSpeak();
    b.innerHTML = canSpeak()
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L14 19V5L8.5 9H4Z"/><path d="M17.5 8.5a5 5 0 0 1 0 7"/></svg>'
      : '';
    b.title = store.settings.prePlay ? '录音前先听原声：开' : '录音前先听原声：关';
    b.style.opacity = store.settings.prePlay ? '1' : '0.45';
  }
  $('#ttsBtn').addEventListener('click', function () {
    store.setSetting('prePlay', !store.settings.prePlay);
    renderTtsBtn();
    toast(store.settings.prePlay ? '已开启：录音前先播原声' : '已关闭：点录音直接开始');
  });

  /* ---------------- 导航 ---------------- */
  function setView(name) {
    state.view = name;
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.id === 'view-' + name); });
    $$('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.nav === name || (name === 'result' && b.dataset.nav === 'home'));
    });
    document.body.classList.toggle('in-session', name === 'study');
    if (name !== 'study') {
      stopStudyTimer();
      cleanupReadMedia();
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (name === 'home') renderHome();
    if (name === 'library') renderLibrary(true);
    if (name === 'stats') renderStats();
    if (name === 'wrong') renderWrong();
    renderTtsBtn();
  }

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (!nav) return;
    var name = nav.dataset.nav;
    if (name === 'home' && state.session) {
      // 会话中返回首页先确认
      $('#quitBtn').click();
      return;
    }
    setView(name);
  });

  /* ---------------- 键盘 ---------------- */
  document.addEventListener('keydown', function (e) {
    if (modalOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      return;
    }
    if (state.view !== 'study' || !state.session) return;
    var s = state.session;
    if (e.key === 'Escape') { $('#quitBtn').click(); return; }

    if (s.style === 'read') {
      var rw = BY_ID[s.items[s.idx].id];
      if (e.key === ' ') {
        e.preventDefault();
        if (rw) speak(rw.ex, $('[data-action="say"]'), { rate: 0.95 });
        return;
      }
      if (e.key === 'r' || e.key === 'R') { toggleRecording(); return; }
      if ((e.key === 's' || e.key === 'S') && asrAvailable()) { startAutoScore(); return; }
      if (e.key === 't' || e.key === 'T') { toggleSentenceZh(); return; }
      if (e.key === 'w' || e.key === 'W') { toggleReadWord(); return; }
      if (/^[1-4]$/.test(e.key) && !s.answeredNow) {
        e.preventDefault();
        commitRead([3, 2, 1, 0][Number(e.key) - 1]);
        return;
      }
      return;
    }

    if (s.style === 'blind') {
      var bw = BY_ID[s.items[s.idx].id];
      if (e.key === ' ' && !s.answeredNow) {
        e.preventDefault();
        if (bw) speak(bw.ex || bw.w, $('[data-action="say"]'), { rate: 0.92 });
        return;
      }
      if (e.key === 'a' || e.key === 'A') {
        if (bw) speak(bw.ex || bw.w, $('[data-action="say"]'), { rate: 0.92 });
        return;
      }
    }

    if (e.key === 'a' || e.key === 'A') {
      if (s.items[s.idx].mode === 'pick') return;
      var w = BY_ID[s.items[s.idx].id];
      if (w) speak(w.w, $('[data-action="speak"]'));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (s.answeredNow) goNext();
      else if ($('#answerInput')) submitTyped();
      return;
    }
    if (e.key === ' ') {
      if (s.answeredNow) { e.preventDefault(); goNext(); }
      return;
    }
    if (/^[1-4]$/.test(e.key) && !s.answeredNow) {
      var btns = $$('#options .option');
      var idx = Number(e.key) - 1;
      if (btns[idx]) { e.preventDefault(); answerChoice(btns[idx]); }
    }
  });

  /* ---------------- 彩带 ---------------- */
  function confetti() {
    var layer = $('#confettiLayer');
    var colors = ['#0f8f6f', '#37c79c', '#e0ad5b', '#8b5cf6', '#3f6f9c', '#e88a8e'];
    for (var i = 0; i < 70; i++) {
      var p = document.createElement('span');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
      p.style.animationDelay = (Math.random() * 0.5) + 's';
      p.style.setProperty('--dx', (Math.random() * 240 - 120) + 'px');
      p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      if (i % 3 === 0) p.style.borderRadius = '50%';
      layer.appendChild(p);
      (function (el) { setTimeout(function () { el.remove(); }, 4000); })(p);
    }
  }

  /* ---------------- 数据变更后的刷新 ---------------- */
  function refreshAfterChange() {
    refreshBanks();
    if (state.view === 'home' || !state.view) renderHome();
    if (state.view === 'library') renderLibrary(true);
    if (state.view === 'wrong') renderWrong();
  }

  /* ---------------- 启动 ---------------- */
  var GITHUB_PC = 'https://github.com/zy13967896784-sketch/wordsense-pc';
  var GITHUB_ANDROID = 'https://github.com/zy13967896784-sketch/wordsense-android';

  function initGithubLink() {
    var a = $('#githubBtn');
    if (!a) return;
    var url = window.AndroidBridge ? GITHUB_ANDROID : GITHUB_PC;
    a.href = url;
    a.addEventListener('click', function (e) {
      if (window.AndroidBridge && typeof window.AndroidBridge.openExternal === 'function') {
        e.preventDefault();
        try { window.AndroidBridge.openExternal(url); } catch (err) { }
      }
    });
  }

  function boot() {
    applyTheme();
    detectDesktopAsr();
    renderTtsBtn();
    initBankSelects();
    initGithubLink();
    setView('home');
    if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.search.indexOf('desktop=1') >= 0) {
      // 桌面版心跳：窗口关闭后，本地服务器据此退出
      setInterval(function () {
        try { fetch('/__ping', { cache: 'no-store' }).catch(function () {}); } catch (e) {}
      }, 4000);
    }
    if (!store.storageAvailable()) {
      toast('浏览器禁用了本地存储，进度将无法保存');
    }
    if (store.settings.reminderOn) syncReminder(false);
    setInterval(updateReminderBanner, 60000);
    if (!WORDS.length) {
      $('#bankGrid').innerHTML = '<div class="card" style="padding:26px">词库数据没有加载成功，请确认 data/words.js 存在。</div>';
    }
  }

  window.WordSense = {
    startSession: startSession,
    setView: setView,
    store: store,
    banks: BANKS,
    words: WORDS,
    parseWordText: parseWordText,
    previewScore: function (text) {
      readState.asrActive = true;
      handleAsrResult(String(text || ''), 0);
    },
    snapshot: function () {
      var s = state.session;
      if (!s || s.idx >= s.items.length) return null;
      var item = s.items[s.idx];
      var w = BY_ID[item.id];
      return {
        idx: s.idx, total: s.items.length, mode: item.mode,
        answered: s.answered, answeredNow: s.answeredNow,
        word: w ? { id: w.id, w: w.w, zh: w.zh } : null
      };
    }
  };

  boot();
})();
