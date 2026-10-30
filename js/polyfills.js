/* 老版本 Android WebView 的轻量兼容层（Android 5/6） */
(function () {
  'use strict';

  if (!Object.assign) {
    Object.assign = function (target) {
      if (target == null) throw new TypeError('Cannot convert undefined or null to object');
      var to = Object(target);
      for (var i = 1; i < arguments.length; i++) {
        var src = arguments[i];
        if (src == null) continue;
        for (var key in src) {
          if (Object.prototype.hasOwnProperty.call(src, key)) to[key] = src[key];
        }
      }
      return to;
    };
  }

  if (!Array.prototype.find) {
    Array.prototype.find = function (predicate, thisArg) {
      if (this == null) throw new TypeError('Array.prototype.find called on null');
      var list = Object(this);
      var len = list.length >>> 0;
      for (var i = 0; i < len; i++) {
        var value = list[i];
        if (predicate.call(thisArg, value, i, list)) return value;
      }
      return undefined;
    };
  }

  if (!Array.prototype.includes) {
    Array.prototype.includes = function (search, fromIndex) {
      var list = Object(this);
      var len = list.length >>> 0;
      var start = fromIndex ? Number(fromIndex) : 0;
      if (start < 0) start = Math.max(0, len + start);
      for (var i = start; i < len; i++) {
        if (list[i] === search || (search !== search && list[i] !== list[i])) return true;
      }
      return false;
    };
  }

  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (search, position) {
      var pos = position || 0;
      return this.substr(pos, String(search).length) === String(search);
    };
  }

  if (!String.prototype.includes) {
    String.prototype.includes = function (search, position) {
      return this.indexOf(String(search), position || 0) !== -1;
    };
  }

  if (typeof Element !== 'undefined' && !Element.prototype.closest) {
    Element.prototype.closest = function (selector) {
      var node = this;
      while (node && node.nodeType === 1) {
        var matches = node.matches || node.msMatchesSelector || node.webkitMatchesSelector;
        if (matches && matches.call(node, selector)) return node;
        node = node.parentElement || node.parentNode;
      }
      return null;
    };
  }
})();
