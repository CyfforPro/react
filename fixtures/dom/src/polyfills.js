import 'core-js/es6/symbol';
import 'core-js/es6/promise';
import 'core-js/es6/set';
import 'core-js/es6/map';

// http://paulirish.com/2011/requestanimationframe-for-smart-animating/
// http://my.opera.com/emoller/blog/2011/12/20/requestanimationframe-for-smart-er-animating

// requestAnimationFrame polyfill by Erik Möller. fixes from Paul Irish and Tino Zijdel
// MIT license
(function() {
  var lastTime = 0;
  var vendors = ['ms', 'moz', 'webkit', 'o'];
  for (var x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
    window.requestAnimationFrame = window[vendors[x] + 'RequestAnimationFrame'];
    window.cancelAnimationFrame =
      window[vendors[x] + 'CancelAnimationFrame'] ||
      window[vendors[x] + 'CancelRequestAnimationFrame'];
  }

  if (!window.requestAnimationFrame)
    // requestAnimationFrame的polyfill
    // 其主体思想为使用
    /**
     * currenttime lasttime timetocall
     * 0           0        16          首次调用，在第一帧末尾cb
     * 12          16       20          第二次调用，假设时间还在第一帧，在第二帧末尾cb
     * 30          32       18          第三次调用，假设时间还在第二帧，在第三帧末尾cb
     * 60          48       4           第四次调用，假设时间在第四帧，在第四帧末尾cb
     * 100         64       0           第五次调用，假设时间已经离上一次调用超过2帧了，就立即调用
     */
    window.requestAnimationFrame = function(callback, element) {
      var currTime = new Date().getTime();
      var timeToCall = Math.max(0, 16 - (currTime - lastTime));
      var id = window.setTimeout(function() {
        callback(currTime + timeToCall);
      }, timeToCall);
      lastTime = currTime + timeToCall;
      return id;
    };

  if (!window.cancelAnimationFrame)
    window.cancelAnimationFrame = function(id) {
      clearTimeout(id);
    };
})();
