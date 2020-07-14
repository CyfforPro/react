/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

import {enableSchedulerDebugging} from './SchedulerFeatureFlags';

// TODO: Use symbols?
var ImmediatePriority = 1;
var UserBlockingPriority = 2;
var NormalPriority = 3;
var LowPriority = 4;
var IdlePriority = 5;

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY = maxSigned31BitInt;

// Callbacks are stored as a circular, doubly linked list.
/**
 * 有序（node的expirationTime从小到大排）双向循环链表的head节点
 */
var firstCallbackNode = null;

var currentDidTimeout = false;
// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// This is set when a callback is being executed, to prevent re-entrancy.
/**
 * 是否正在执行cb，在flushwork和flushImmediateWork开始时true，结束后false
 */
var isExecutingCallback = false;

/**
 * 是否已经开始调度了，在ensureHostCallbackIsScheduled设置为true，在结束执行callback之后（也就是flushwork和flushImmediateWork结束时）设置为false
 */
var isHostCallbackScheduled = false;

var hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

/**
 * 确定当前是否有正在执行的cb或已经在调度任务了，可以时执行requestHostCallback
 */
function ensureHostCallbackIsScheduled() {
  if (isExecutingCallback) {
    // Don't schedule work yet; wait until the next time we yield.
    // 有正在执行的cb，就return
    return;
  }
  // Schedule the host callback using the earliest expiration in the list.
  var expirationTime = firstCallbackNode.expirationTime;
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    // Cancel the existing host callback.
    // 在调度任务中，就取消，因为可能顺序已经变了？
    cancelHostCallback();
  }
  requestHostCallback(flushWork, expirationTime);
}

/**
 * 执行firstCallbackNode的cb，执行完成后，head指针后移
 */
function flushFirstCallback() {
  var flushedNode = firstCallbackNode;

  // Remove the node from the list before calling the callback. That way the
  // list is in a consistent state even if the callback throws.
  var next = firstCallbackNode.next;
  if (firstCallbackNode === next) {
    // This is the last callback in the list.
    firstCallbackNode = null;
    next = null;
  } else {
    var lastCallbackNode = firstCallbackNode.previous;
    firstCallbackNode = lastCallbackNode.next = next;
    next.previous = lastCallbackNode;
  }

  // 对flushedNode的next和previous置空，以免造成内存泄漏
  flushedNode.next = flushedNode.previous = null;

  // Now it's safe to call the callback.
  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;
  var continuationCallback;
  try {
    continuationCallback = callback();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  // 一般callback()都没有返回值的，下面的都不用管
  if (typeof continuationCallback === 'function') {
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null,
    };

    // Insert the new callback into the list, sorted by its expiration. This is
    // almost the same as the code in `scheduleCallback`, except the callback
    // is inserted into the list *before* callbacks of equal expiration instead
    // of after.
    if (firstCallbackNode === null) {
      // This is the first callback in the list.
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        if (node.expirationTime >= expirationTime) {
          // This callback expires at or after the continuation. We will insert
          // the continuation *before* this callback.
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

// 从目前这个版本来看，firstCallbackNode.priorityLevel不可能为ImmediatePriority，那就先不管了
function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority
  ) {
    isExecutingCallback = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
        firstCallbackNode !== null &&
        firstCallbackNode.priorityLevel === ImmediatePriority
      );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

function flushWork(didTimeout) {
  // Exit right away if we're currently paused

  if (enableSchedulerDebugging && isSchedulerPaused) {
    return;
  }

  isExecutingCallback = true;
  const previousDidTimeout = currentDidTimeout;
  currentDidTimeout = didTimeout;
  try {
    if (didTimeout) {
      // Flush all the expired callbacks without yielding.
      while (
        firstCallbackNode !== null &&
        !(enableSchedulerDebugging && isSchedulerPaused)
      ) {
        // TODO Wrap in feature flag
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        var currentTime = getCurrentTime();
        if (firstCallbackNode.expirationTime <= currentTime) {
          // 若firstCallbackNode的时间过期了，执行循环，直到firstCallbackNode为空或者不过期
          // 每次循环中执行了flushFirstCallback，在flushFirstCallback会变换firstCallbackNode来让这个循环持续下去
          do {
            // 真正执行任务链表的节点的callback了
            flushFirstCallback();
          } while (
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime &&
            !(enableSchedulerDebugging && isSchedulerPaused)
          );
          continue;
        }
        // 上述代码执行结束后，要么firstCallbackNode为null，要么已经没有过期的任务了，那么就跳出循环
        break;
      }
    } else {
      // Keep flushing callbacks until we run out of time in the frame.
      // didTimeout为false时执行，表示执行onmessage时，待调度的任务scheduledHostCallback还没有过期
      if (firstCallbackNode !== null) {
        // 当浏览器有空时（!shouldYieldToHost）执行flushFirstCallback
        do {
          if (enableSchedulerDebugging && isSchedulerPaused) {
            break;
          }
          // 注意这里只是在一次空闲中尽可能的执行flushFirstCallback，不空闲或者没有任务就循环结束了
          flushFirstCallback();
        } while (firstCallbackNode !== null && !shouldYieldToHost());
      }
    }
  } finally {
    isExecutingCallback = false;
    currentDidTimeout = previousDidTimeout;
    if (firstCallbackNode !== null) {
      // There's still work remaining. Request another callback.

      // 调用ensureHostCallbackIsScheduled，重新来一遍任务调度，啥情况下会执行这个呢——
      //  1. didTimeout时，执行了链表中的一些过期任务，尚有一些未过期任务待执行
      //  2. !didTimeout，浏览器没有空闲了，但链表中有任务待执行
      // 同时注意在这里调用这个，由于scheduledHostCallback==true
      // 那么肯定会在ensureHostCallbackIsScheduled中调用cancelHostCallback来取消scheduledHostCallback
      ensureHostCallbackIsScheduled();
    } else {
      isHostCallbackScheduled = false;
    }
    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_next(eventHandler) {
  let priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

/**
 * 主要是维护了firstCallbackNode有序双向循环链表，并进一步调用ensureHostCallbackIsScheduled
 * @param {*} callback
 * @param {*} deprecated_options
 */
function unstable_scheduleCallback(callback, deprecated_options) {
  // currentEventStartTime基本都不是-1，就认为startTime就是now()就好了
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime();

  var expirationTime;
  if (
    typeof deprecated_options === 'object' &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === 'number'
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    // FIXME: 当把expirationTime系统从React中移除，应该是会迁移到Scheduler中，就不要走这个自行计算expirationTime的逻辑了
    // expirationTime = now + timeout
    expirationTime = startTime + deprecated_options.timeout;
  } else {
    // 后续React中可能不会有expirationTime系统，而是改为优先级直接在Scheduler中进行计算了
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case LowPriority:
        expirationTime = startTime + LOW_PRIORITY_TIMEOUT;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }

  var newNode = {
    callback,
    priorityLevel: currentPriorityLevel,
    expirationTime,
    next: null,
    previous: null,
  };

  // Insert the new callback into the list, ordered first by expiration, then
  // by insertion. So the new callback is inserted any other callback with
  // equal expiration.
  if (firstCallbackNode === null) {
    // This is the first callback in the list.
    // 链表还是空的，相关赋值处理，并调用ensureHostCallbackIsScheduled
    // NOTE: 这还是一个双向“循环”链表
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {
    // 链表非空
    var next = null;
    var node = firstCallbackNode;
    // 遍历链表，找到第一个大于newNode的expirationTime的node，并赋值给next
    // 此处应该这么理解，每次插入链表都是有序的（从小到大），那么只要找到第一个大于的node，就能将newNode插入到正确的位置了
    do {
      if (node.expirationTime > expirationTime) {
        // The new callback expires before this one.
        next = node;
        break;
      }
      node = node.next;
    } while (node !== firstCallbackNode);

    if (next === null) {
      // No callback with a later expiration was found, which means the new
      // callback has the latest expiration in the list.
      // 链表只有一个节点firstCallbackNode，且其expirationTime小于newNode的expiration
      // 那么next就是firstCallbackNode，newNode要作为firstCallbackNode的next
      next = firstCallbackNode;
      // 针对这种情况，不需要调用ensureHostCallbackIsScheduled，因为firstCallbackNode没变
      // 而ensureHostCallbackIsScheduled又是从第一个开始遍历的
    } else if (next === firstCallbackNode) {
      // The new callback has the earliest expiration in the entire list.
      // 链表只有一个节点firstCallbackNode，且其expirationTime大于newNode的expiration
      // 那么newNode就要作为firstCallbackNode了
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }

    // 链表node间的连接，其实就是标准的有序双向循环链表啊，还看了半天，我好菜啊
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }

  return newNode;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (firstCallbackNode !== null) {
    ensureHostCallbackIsScheduled();
  }
}

function unstable_getFirstCallbackNode() {
  return firstCallbackNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

function unstable_shouldYield() {
  return (
    !currentDidTimeout &&
    ((firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime) ||
      shouldYieldToHost())
  );
}

// The remaining code is essentially a polyfill for requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
var localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
var localSetTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
var localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

/**
 * 如果有performance，就是performance.now，否则就是Date.now
 */
var getCurrentTime;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// TODO: Need a better heuristic for backgrounded work.
var ANIMATION_FRAME_TIMEOUT = 100;
var rAFID;
var rAFTimeoutID;

/**
 * 同时调用raf和setTimeout(100ms)
 *   1. 若100ms内raf中的cb未被调用，则会在setTimeout中被调用，并取消后续可能执行的rafID
 *   2. 若100ms内raf中的cb先被调用，则会取消timeoutID
 *   3. callback(getCurrentTime())主要是raf会自动拿到timestamp，timeout需要做模拟
 *   4. 这两个raf和setTimeout就是竞争关系，防止raf一直被卡住未执行
 * @param {*} callback
 */
var requestAnimationFrameWithTimeout = function(callback) {
  // schedule rAF and also a setTimeout
  rAFID = localRequestAnimationFrame(function(timestamp) {
    // cancel the setTimeout
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  rAFTimeoutID = localSetTimeout(function() {
    // cancel the requestAnimationFrame
    localCancelAnimationFrame(rAFID);
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  var Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();
  };
}

var requestHostCallback;
var cancelHostCallback;
var shouldYieldToHost;

var globalValue = null;
if (typeof window !== 'undefined') {
  globalValue = window;
} else if (typeof global !== 'undefined') {
  globalValue = global;
}

if (globalValue && globalValue._schedMock) {
  // Dynamic injection, only for testing purposes.
  var globalImpl = globalValue._schedMock;
  // 允许用户自行传入如下三个函数，主要是做测试用的
  requestHostCallback = globalImpl[0];
  cancelHostCallback = globalImpl[1];
  shouldYieldToHost = globalImpl[2];
  getCurrentTime = globalImpl[3];
} else if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive
  // implementation using setTimeout.
  typeof window === 'undefined' ||
  // Check if MessageChannel is supported, too.
  typeof MessageChannel !== 'function'
) {
  // 非浏览器环境，不管
  // If this accidentally gets imported in a non-browser environment, e.g. JavaScriptCore,
  // fallback to a naive implementation.
  var _callback = null;
  var _flushCallback = function(didTimeout) {
    if (_callback !== null) {
      try {
        _callback(didTimeout);
      } finally {
        _callback = null;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_callback !== null) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, 0, false);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  shouldYieldToHost = function() {
    return false;
  };
} else {
  if (typeof console !== 'undefined') {
    // TODO: Remove fb.me link
    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  /**
   * 在requestHostCallback设置，值一般为flushWork，代表下一个调度要做的事情
   */
  var scheduledHostCallback = null;

  /**
   * 是否有messageEvent在执行——
   *  1. 正常的port2.postmessage前设为true
   *  2. port1.onmessage和cancelHostCallback中设为false
   */
  var isMessageEventScheduled = false;
  /**
   * 一个更新任务的过期时间
   *  1. requestHostCallback或时会赋上
   *  2. onmessage、cancelHostCallback就重置
   */
  var timeoutTime = -1;

  /**
   * 是否已经开始调用requestAnimationFrame，requestAnimationFrameWithTimeout执行前设为true，animationTick有条件的设为false
   */
  var isAnimationFrameScheduled = false;

  /**
   * 是否有prevScheduledCallback待执行，prevScheduledCallback执行前设为true，结束后false
   */
  var isFlushingHostCallback = false;

  var frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  // 首先假设运行在30fps的设备上，并动态的根据raf的执行时间来获取设备帧率，最高支持120fps
  var previousFrameTime = 33;
  var activeFrameTime = 33;

  /**
   * 是否应等待浏览器执行
   *   true，等待，浏览器在忙着，别吵
   *   false，不用等，浏览器空闲，可以执行一些任务
   */
  shouldYieldToHost = function() {
    return frameDeadline <= getCurrentTime();
  };

  // We use the postMessage trick to defer idle work until after the repaint.
  var channel = new MessageChannel();
  var port = channel.port2;
  channel.port1.onmessage = function(event) {
    isMessageEventScheduled = false;

    // 先取出scheduledHostCallback和timeoutTime后再初始化
    var prevScheduledCallback = scheduledHostCallback;
    var prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;

    var currentTime = getCurrentTime();

    var didTimeout = false;
    if (frameDeadline - currentTime <= 0) {
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      // 在执行onmessasge的task前耗费了很多渲染的时间等，导致frameDeadline都已经过了
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        // 若任务的过期时间都小于当前时间了，需要立即执行
        didTimeout = true;
      } else {
        // No timeout.
        // frameDeadline没有过期
        if (!isAnimationFrameScheduled) {
          // Schedule another animation callback so we retry later.
          // 更像是重试，对于某些情况下调用了onmessage而又没有isAnimationFrameScheduled的处理
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        // 没有过期需要执行scheduledHostCallback时恢复原来的callback和timeout
        scheduledHostCallback = prevScheduledCallback;
        timeoutTime = prevTimeoutTime;
        return;
      }
    }

    if (prevScheduledCallback !== null) {
      // 需要执行prevScheduledCallback
      isFlushingHostCallback = true;
      try {
        // 执行prevScheduledCallback，一般就是flushWork
        prevScheduledCallback(didTimeout);
      } finally {
        isFlushingHostCallback = false;
      }
    }
  };

  var animationTick = function(rafTime) {
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      // 使用raf循环调用animationTick，直至没有需要调度的任务了scheduledHostCallback === null
      requestAnimationFrameWithTimeout(animationTick);
    } else {
      // No pending work. Exit.
      // 没有需要调度的任务了
      isAnimationFrameScheduled = false;
      return;
    }

    // 下面这一堆nextFrameTime、previousFrameTime、activeFrameTime的计算，归根结底就是想要拿到一个比较接近显示设备运行帧时间activeFrameTime
    // 从而计算出frameDeadline，因为在这段时间内，react会进行调度，若计算的activeFrameTime不真实 ——
    // 偏大，则会不流畅；偏小，则会有一定浪费，没有充分运用性能

    // nextFrameTime其实就是currentRafTime - prevRafTime
    var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime
    ) {
      if (nextFrameTime < 8) {
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        // 防守编程，nextFrameTime最小值为8，即最大支持120fps
        nextFrameTime = 8;
      }
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      // activeFrameTime取的是前后两帧时间跨度的较大值
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
    } else {
      previousFrameTime = nextFrameTime;
    }
    // frameDeadline为当前帧时间+一帧需要的时间，即预测下一帧发生的时间
    // NOTE: 像这种计算frameDeadline的方式，为啥不用考虑减去浏览器渲染时间——
    //   调用链为raf → animationTick → onmessage，而raf的cb即animitionTick是在下一次渲染前调用的，那么这时的onmessage的task就会排在渲染的task之后
    //   也就是说 要执行onmessage时，已经过去了一段渲染的时间了，此时frameDeadline基本就是js可执行时间
    frameDeadline = rafTime + activeFrameTime;

    if (!isMessageEventScheduled) {
      isMessageEventScheduled = true;
      port.postMessage(undefined);
    }
  };

  /**
   * 准备调用raf或postMessage
   */
  requestHostCallback = function(callback, absoluteTimeout) {
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;
    if (isFlushingHostCallback || absoluteTimeout < 0) {
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      // 有待执行的上一个任务或者该任务已经过期了，不用等待下一帧，应立即执行
      port.postMessage(undefined);
    } else if (!isAnimationFrameScheduled) {
      // If rAF didn't already schedule one, we need to schedule a frame.
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      // 没有正在执行raf，就执行raf
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  unstable_shouldYield,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
};
