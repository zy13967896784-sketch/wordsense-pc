/* ============================================================
   词感 WordSense — 间隔复习调度
   轻量版 SM-2：以「天」为粒度，支持认识程度分级
   可在浏览器与 Node 中直接使用（无依赖）
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY = 86400000;
  var MINUTE = 60000;

  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

  function blank() {
    return { due: 0, interval: 0, reps: 0, lapses: 0, ease: 2.3, status: 'new', last: 0 };
  }

  function normalize(card) {
    var c = Object.assign(blank(), card || {});
    c.reps = Math.max(0, Number(c.reps) || 0);
    c.lapses = Math.max(0, Number(c.lapses) || 0);
    c.ease = clamp(Number(c.ease) || 2.3, 1.3, 3.0);
    c.interval = Math.max(0, Number(c.interval) || 0);
    c.due = Number(c.due) || 0;
    c.last = Number(c.last) || 0;
    return c;
  }

  /**
   * 依据答题表现推进卡片。
   * @param {object} card  旧卡片
   * @param {0|1|2|3} grade 0=忘记 1=模糊 2=认识 3=很简单
   * @param {number} now   当前时间戳
   * @returns {object} 新卡片（不修改入参）
   */
  function review(card, grade, now) {
    var c = normalize(card);
    var g = clamp(Math.round(Number(grade) || 0), 0, 3);
    now = Number(now) || Date.now();
    c.reps += 1;
    c.last = now;

    if (g === 0) {
      c.lapses += 1;
      c.ease = clamp(c.ease - 0.2, 1.3, 3.0);
      c.interval = 0;
      c.due = now + 10 * MINUTE;   // 10 分钟后重来
      c.status = 'learning';
      return c;
    }

    if (c.reps === 1) {
      c.interval = [0, 1, 2, 3][g];
    } else if (c.reps === 2) {
      c.interval = [0, 2, 4, 6][g];
    } else {
      var mult = g === 1 ? 1.2 : (g === 2 ? c.ease : c.ease * 1.4);
      c.interval = Math.max(1, Math.round(c.interval * mult));
    }

    c.interval = clamp(c.interval, 1, 365);
    c.ease = clamp(c.ease + (g === 1 ? -0.15 : (g === 2 ? 0 : 0.1)), 1.3, 3.0);
    c.due = now + c.interval * DAY;
    c.status = (c.interval >= 21 && c.reps >= 4) ? 'mastered' : 'review';
    return c;
  }

  /** 把一次答题转换成 0–3 档 */
  function gradeFromResult(opts) {
    var o = opts || {};
    if (!o.correct) return 0;
    if (o.hint || o.ms > 9000) return 1;
    if (o.ms < 3800) return 3;
    return 2;
  }

  function isDue(card, now) {
    if (!card) return false;
    return Number(card.due || 0) <= (now || Date.now());
  }

  function statusOf(card, now) {
    if (!card || !card.reps) return 'new';
    return card.status || 'review';
  }

  /** 距离下次复习的可读描述 */
  function describeInterval(card) {
    if (!card || !card.due) return '未学习';
    var diff = card.due - Date.now();
    if (diff <= 0) return '待复习';
    var mins = Math.round(diff / MINUTE);
    if (mins < 60) return mins + ' 分钟后';
    var hours = Math.round(diff / 3600000);
    if (hours < 24) return hours + ' 小时后';
    var days = Math.round(diff / DAY);
    if (days < 30) return days + ' 天后';
    var months = Math.round(days / 30);
    return months + ' 个月后';
  }

  function accuracy(correct, total) {
    if (!total) return null;
    return Math.round((correct / total) * 100);
  }

  return {
    DAY: DAY,
    MINUTE: MINUTE,
    blank: blank,
    normalize: normalize,
    review: review,
    gradeFromResult: gradeFromResult,
    isDue: isDue,
    statusOf: statusOf,
    describeInterval: describeInterval,
    accuracy: accuracy
  };
});
