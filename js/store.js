/* ============================================================
   词感 WordSense — 本地数据层
   所有进度只保存在 localStorage，不上传任何服务器
   ============================================================ */
(function (root) {
  'use strict';

  var KEY = 'wordsense.v1';

  var DEFAULT_SETTINGS = {
    sessionSize: 20,
    newPerDay: 15,
    dailyGoal: 40,
    autoNext: false,
    autoplay: true,
    prePlay: true,
    sound: true,
    theme: 'auto',
    quizType: 'mix',
    homeBank: 'all',
    reminderOn: false,
    reminderTime: '20:30'
  };

  function dayKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    var m = (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
    var day = (d.getDate() < 10 ? '0' : '') + d.getDate();
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function initial() {
    return {
      v: 1,
      settingsVersion: 2,
      createdAt: Date.now(),
      cards: {},
      days: {},
      wrong: {},
      custom: [],
      settings: clone(DEFAULT_SETTINGS)
    };
  }

  function safeParse(raw) {
    try {
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return null;
      return d;
    } catch (e) { return null; }
  }

  function Store() {
    var data = null;
    var storageOk = true;

    try {
      var raw = root.localStorage ? root.localStorage.getItem(KEY) : null;
      var parsed = raw ? safeParse(raw) : null;
      data = parsed || initial();
    } catch (e) {
      storageOk = false;
      data = initial();
    }

    // 结构修补，兼容旧数据/手工改坏的数据
    data.cards = data.cards && typeof data.cards === 'object' ? data.cards : {};
    // 旧版卡片按单词 id 存一份；升级后跟读/快刷/盲听各自独立，旧进度复制到三种模式
    var migratedModes = false;
    Object.keys(data.cards).forEach(function (id) {
      if (/^(read|quiz|blind):/.test(id)) return;
      var legacy = data.cards[id];
      ['read', 'quiz', 'blind'].forEach(function (m) {
        data.cards[m + ':' + id] = clone(legacy);
      });
      delete data.cards[id];
      migratedModes = true;
    });
    if (migratedModes) {
      try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { }
    }
    data.days = data.days && typeof data.days === 'object' ? data.days : {};
    data.wrong = data.wrong && typeof data.wrong === 'object' ? data.wrong : {};
    data.custom = Array.isArray(data.custom) ? data.custom : [];
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    // 旧版本默认答对自动跳转；升级后统一关掉一次，用户仍可在设置里打开
    if (data.settingsVersion !== 2) {
      data.settings.autoNext = false;
      data.settingsVersion = 2;
      try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { }
    }

    function save() {
      if (!storageOk) return false;
      try {
        root.localStorage.setItem(KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        storageOk = false;
        return false;
      }
    }

    function getSettings() { return data.settings; }

    function setSetting(k, v) {
      data.settings[k] = v;
      save();
      return v;
    }

    function getCard(id) { return data.cards[id] ? SRS.normalize(data.cards[id]) : null; }

    function putCard(id, card) {
      data.cards[id] = card;
      save();
      return card;
    }

    function hasCard(id) { return !!data.cards[id]; }

    function removeCard(id) {
      delete data.cards[id];
      save();
    }

    function baseId(id) { return String(id).replace(/^(read|quiz|blind):/, ''); }

    /** 手动设置学习状态（不改动历史统计） */
    function setCardStatus(id, status) {
      if (!id) return;
      if (status === 'new') {
        delete data.cards[id];
        delete data.wrong[id];
        delete data.wrong[baseId(id)];
        save();
        return;
      }
      var now = Date.now();
      var c = SRS.blank();
      c.last = now;
      if (status === 'learning') {
        c.reps = 1;
        c.status = 'learning';
        c.interval = 0;
        c.due = now + 10 * 60000;
      } else if (status === 'review') {
        c.reps = 2;
        c.status = 'review';
        c.interval = 4;
        c.due = now + 4 * 86400000;
      } else if (status === 'mastered') {
        c.reps = 4;
        c.status = 'mastered';
        c.interval = 30;
        c.due = now + 30 * 86400000;
      } else {
        return;
      }
      data.cards[id] = c;
      delete data.wrong[id];
      delete data.wrong[baseId(id)];
      save();
    }

    function resetWords(ids) {
      (ids || []).forEach(function (id) {
        delete data.cards[id];
        delete data.wrong[id];
        delete data.wrong[baseId(id)];
      });
      save();
    }

    function allCards(mode) {
      if (!mode) return data.cards;
      var out = {};
      Object.keys(data.cards).forEach(function (k) {
        if (k.indexOf(mode + ':') === 0) out[k.slice(mode.length + 1)] = data.cards[k];
      });
      return out;
    }

    function today() {
      var k = dayKey();
      if (!data.days[k]) data.days[k] = { reviewed: 0, correct: 0, newLearned: 0, ms: 0, modes: {}, newModes: {} };
      if (!data.days[k].modes) data.days[k].modes = {};
      if (!data.days[k].newModes) data.days[k].newModes = {};
      return data.days[k];
    }

    /** 记录一次答题 */
    function recordAnswer(opts) {
      var o = opts || {};
      var d = today();
      d.reviewed += 1;
      if (o.correct) d.correct += 1;
      var mode = o.mode || 'read';
      var answerMode = o.answerMode || mode;
      if (o.isNew) {
        d.newLearned += 1;
        d.newModes[mode] = (d.newModes[mode] || 0) + 1;
      }
      d.ms += Math.max(0, Number(o.ms) || 0);
      d.modes[answerMode] = (d.modes[answerMode] || 0) + 1;
      save();
      return d;
    }

    function getDay(k) {
      var d = data.days[k];
      if (!d) return { reviewed: 0, correct: 0, newLearned: 0, ms: 0, modes: {} };
      if (!d.modes) d.modes = {};
      return d;
    }

    function getDays() { return data.days; }

    function studyDays() {
      return Object.keys(data.days).filter(function (k) { return (data.days[k].reviewed || 0) > 0; }).length;
    }

    function longestStreak() {
      var keys = Object.keys(data.days).filter(function (k) { return (data.days[k].reviewed || 0) > 0; }).sort();
      var best = 0, cur = 0, prev = null;
      keys.forEach(function (k) {
        if (prev) {
          var p = new Date(prev + 'T00:00:00');
          p.setDate(p.getDate() + 1);
          if (dayKey(p.getTime()) === k) cur += 1;
          else cur = 1;
        } else {
          cur = 1;
        }
        if (cur > best) best = cur;
        prev = k;
      });
      return best;
    }

    function totalMs() {
      var sum = 0;
      Object.keys(data.days).forEach(function (k) { sum += data.days[k].ms || 0; });
      return sum;
    }

    function modeTotals() {
      var out = {};
      Object.keys(data.days).forEach(function (k) {
        var modes = data.days[k].modes || {};
        Object.keys(modes).forEach(function (m) { out[m] = (out[m] || 0) + modes[m]; });
      });
      return out;
    }

    function newLearnedToday(mode) {
      var d = today();
      if (!mode) return d.newLearned;
      return (d.newModes && d.newModes[mode]) || 0;
    }

    function newWordsLeft(mode) {
      var limit = Number(data.settings.newPerDay) || 0;
      return Math.max(0, limit - newLearnedToday(mode));
    }

    function streak(now) {
      var t = now || Date.now();
      var d = new Date(t);
      var count = 0;
      // 今天还没刷时，从昨天开始算，避免白天断签
      if (getDay(dayKey(t)).reviewed === 0) d.setDate(d.getDate() - 1);
      for (var i = 0; i < 400; i++) {
        var key = dayKey(d.getTime());
        var row = data.days[key];
        if (row && row.reviewed > 0) {
          count += 1;
          d.setDate(d.getDate() - 1);
        } else {
          break;
        }
      }
      return count;
    }

    function totals(mode) {
      var cards = mode ? allCards(mode) : {};
      if (!mode) {
        // 首页汇总：同一单词取三种模式里最靠前的状态，不重复计数
        var rank = { mastered: 3, review: 2, learning: 1 };
        Object.keys(data.cards).forEach(function (k) {
          var base = k.replace(/^(read|quiz|blind):/, '');
          var c = data.cards[k];
          var st = SRS.statusOf(c, Date.now());
          if (!cards[base] || (rank[st] || 0) > (rank[SRS.statusOf(cards[base], Date.now())] || 0)) {
            cards[base] = c;
          }
        });
      }
      var mastered = 0, learning = 0, review = 0, due = 0;
      var now = Date.now();
      Object.keys(cards).forEach(function (id) {
        var c = cards[id];
        var st = SRS.statusOf(c, now);
        if (st === 'mastered') mastered += 1;
        else if (st === 'learning') learning += 1;
        else if (st === 'review') review += 1;
        if (st !== 'new' && SRS.isDue(c, now)) due += 1;
      });
      var totalReviewed = 0, totalCorrect = 0;
      Object.keys(data.days).forEach(function (k) {
        totalReviewed += data.days[k].reviewed || 0;
        totalCorrect += data.days[k].correct || 0;
      });
      return {
        touched: Object.keys(cards).length,
        mastered: mastered,
        learning: learning,
        review: review,
        due: due,
        reviewed: totalReviewed,
        correct: totalCorrect,
        accuracy: SRS.accuracy(totalCorrect, totalReviewed)
      };
    }

    function recentDays(n) {
      var out = [];
      var d = new Date();
      for (var i = n - 1; i >= 0; i--) {
        var t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
        var k = dayKey(t.getTime());
        out.push({
          key: k,
          date: t,
          label: ['日', '一', '二', '三', '四', '五', '六'][t.getDay()],
          reviewed: getDay(k).reviewed,
          correct: getDay(k).correct,
          isToday: i === 0
        });
      }
      return out;
    }

    /* ---- 错词本 ---- */
    function addWrong(id) {
      var w = data.wrong[id] || { count: 0, right: 0, last: 0 };
      w.count += 1;
      w.right = 0;
      w.last = Date.now();
      data.wrong[id] = w;
      save();
    }

    function noteCorrect(id) {
      var w = data.wrong[id];
      if (!w) return;
      w.right = (w.right || 0) + 1;
      if (w.right >= 2) delete data.wrong[id];
      save();
    }

    function removeWrong(id) { delete data.wrong[id]; save(); }

    function wrongEntries() {
      return Object.keys(data.wrong).map(function (id) {
        return { id: id, count: data.wrong[id].count, right: data.wrong[id].right, last: data.wrong[id].last };
      }).sort(function (a, b) { return b.last - a.last; });
    }

    function wrongCount() { return Object.keys(data.wrong).length; }

    /* ---- 自定义词 ---- */
    function addCustom(words) {
      var existing = {};
      data.custom.forEach(function (w) { existing[w.w.toLowerCase()] = true; });
      var added = 0;
      (words || []).forEach(function (w) {
        var key = String(w.w || '').trim().toLowerCase();
        if (!key || existing[key]) return;
        existing[key] = true;
        data.custom.push(w);
        added += 1;
      });
      save();
      return added;
    }

    function getCustom() { return data.custom; }

    function removeCustom(word) {
      data.custom = data.custom.filter(function (w) { return w.w !== word; });
      save();
    }

    /* ---- 数据管理 ---- */
    function exportAll() {
      return clone(data);
    }

    function importAll(obj) {
      if (!obj || typeof obj !== 'object' || !obj.cards) throw new Error('数据格式不正确');
      data = {
        v: 1,
        createdAt: obj.createdAt || Date.now(),
        cards: obj.cards || {},
        days: obj.days || {},
        wrong: obj.wrong || {},
        custom: obj.custom || [],
        settings: Object.assign({}, DEFAULT_SETTINGS, obj.settings || {})
      };
      Object.keys(data.cards).forEach(function (id) {
        if (/^(read|quiz|blind):/.test(id)) return;
        var legacy = data.cards[id];
        ['read', 'quiz', 'blind'].forEach(function (m) { data.cards[m + ':' + id] = clone(legacy); });
        delete data.cards[id];
      });
      save();
      return true;
    }

    function resetProgress() {
      var keep = { custom: data.custom, settings: data.settings };
      data = initial();
      data.custom = keep.custom;
      data.settings = keep.settings;
      save();
    }

    function storageAvailable() { return storageOk; }

    return {
      KEY: KEY,
      get settings() { return data.settings; },
      getSettings: getSettings,
      setSetting: setSetting,
      save: save,
      getCard: getCard,
      putCard: putCard,
      hasCard: hasCard,
      removeCard: removeCard,
      setCardStatus: setCardStatus,
      resetWords: resetWords,
      allCards: allCards,
      today: today,
      getDay: getDay,
      getDays: getDays,
      recordAnswer: recordAnswer,
      newLearnedToday: newLearnedToday,
      newWordsLeft: newWordsLeft,
      streak: streak,
      studyDays: studyDays,
      longestStreak: longestStreak,
      totalMs: totalMs,
      modeTotals: modeTotals,
      totals: totals,
      recentDays: recentDays,
      addWrong: addWrong,
      noteCorrect: noteCorrect,
      removeWrong: removeWrong,
      wrongEntries: wrongEntries,
      wrongCount: wrongCount,
      addCustom: addCustom,
      getCustom: getCustom,
      removeCustom: removeCustom,
      exportAll: exportAll,
      importAll: importAll,
      resetProgress: resetProgress,
      storageAvailable: storageAvailable,
      dayKey: dayKey
    };
  }

  root.Store = Store;
  root.dayKey = dayKey;
})(typeof window !== 'undefined' ? window : globalThis);
