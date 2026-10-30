/* ============================================================
   词感 — 跟读自动评分
   把系统语音识别的结果与目标句子做词级 LCS 对齐，
   用 F1 衡量「读出率」，并给出建议档位。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReadingScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(text) {
    var n = normalize(text);
    return n ? n.split(' ') : [];
  }

  function lcs(a, b) {
    var m = a.length, n = b.length;
    var dp = [];
    var i, j;
    for (i = 0; i <= m; i++) {
      dp.push(new Array(n + 1));
      for (j = 0; j <= n; j++) dp[i][j] = 0;
    }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var matched = [];
    i = m; j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        matched.push(i - 1);
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    matched.reverse();
    return { length: dp[m][n], matched: matched };
  }

  /**
   * @param {string} target 目标句子
   * @param {string} transcript 语音识别结果
   * @returns {{score:number, grade:0|1|2|3, matched:number, total:number,
   *            missed:string[], matchedWords:string[], transcript:string}}
   */
  function score(target, transcript) {
    var t = words(target);
    var h = words(transcript);
    var text = String(transcript || '').trim();
    if (!t.length) {
      return { score: 0, grade: 0, matched: 0, total: 0, missed: [], matchedWords: [], transcript: text };
    }
    if (!h.length) {
      return { score: 0, grade: 0, matched: 0, total: t.length, missed: t.slice(), matchedWords: [], transcript: text };
    }

    var result = lcs(t, h);
    var matchedSet = {};
    result.matched.forEach(function (idx) { matchedSet[idx] = true; });

    var missed = [];
    var hit = [];
    t.forEach(function (w, idx) {
      if (matchedSet[idx]) hit.push(w);
      else missed.push(w);
    });

    var precision = result.length / h.length;
    var recall = result.length / t.length;
    var f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    var finalScore = Math.max(0, Math.min(100, Math.round(f1 * 100)));

    var grade;
    if (finalScore >= 90) grade = 3;
    else if (finalScore >= 70) grade = 2;
    else if (finalScore >= 45) grade = 1;
    else grade = 0;

    return {
      score: finalScore,
      grade: grade,
      matched: result.length,
      total: t.length,
      missed: missed,
      matchedWords: hit,
      transcript: text
    };
  }

  return { normalize: normalize, words: words, score: score };
});
