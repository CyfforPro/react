/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import {NoWork} from './ReactFiberExpirationTime';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext';
import {Callback, ShouldCapture, DidCapture} from 'shared/ReactSideEffectTags';
import {ClassComponent} from 'shared/ReactWorkTags';

import {
  debugRenderPhaseSideEffects,
  debugRenderPhaseSideEffectsForStrictMode,
} from 'shared/ReactFeatureFlags';

import {StrictMode} from './ReactTypeOfMode';

import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

export type Update<State> = {
  // 更新过期时间
  expirationTime: ExpirationTime,

  // export const UpdateState = 0;
  // export const ReplaceState = 1;
  // export const ForceUpdate = 2;
  // export const CaptureUpdate = 3;
  // 指定更新的类型，值为以上几种，captureupdate是用来错误捕获时用的
  tag: 0 | 1 | 2 | 3,
  // 更新的内容，如首次render可能是ReactElements，setState更新可能是新的部分state（setState第一个参数）等
  payload: any,
  // 对应的回调，setState，render都有
  callback: (() => mixed) | null,

  // 指向下一个更新
  next: Update<State> | null,
  // 指向下一个side effect
  nextEffect: Update<State> | null,
};

export type UpdateQueue<State> = {
  // 每次操作完更新之后的state
  baseState: State,

  // 队列中的第一个Update
  firstUpdate: Update<State> | null,
  // 队列中最后一个Update
  lastUpdate: Update<State> | null,

  // 第一个错误捕获的Update
  firstCapturedUpdate: Update<State> | null,
  // 最后一个错误捕获的Update
  lastCapturedUpdate: Update<State> | null,

  // 第一个side effect
  firstEffect: Update<State> | null,
  // 最后一个side effect
  lastEffect: Update<State> | null,

  // 第一个和最后一个错误捕获产生的side effect
  firstCapturedEffect: Update<State> | null,
  lastCapturedEffect: Update<State> | null,
};

export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

export function createUpdateQueue<State>(baseState: State): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState,
    firstUpdate: null,
    lastUpdate: null,
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,
    firstEffect: null,
    lastEffect: null,
    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

function cloneUpdateQueue<State>(
  currentQueue: UpdateQueue<State>,
): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState: currentQueue.baseState,
    firstUpdate: currentQueue.firstUpdate,
    lastUpdate: currentQueue.lastUpdate,

    // TODO: With resuming, if we bail out and resuse the child tree, we should
    // keep these effects.
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,

    firstEffect: null,
    lastEffect: null,

    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

// Update——
// 1. 记录组件状态变更
// 2. 存放于UpdateQueue中
// 3. 多个Update可同时存在
export function createUpdate(expirationTime: ExpirationTime): Update<*> {
  return {
    expirationTime: expirationTime,

    tag: UpdateState,
    payload: null,
    callback: null,

    next: null,
    nextEffect: null,
  };
}

/**
 * update入队列queue
 *   queue.lastUpdate === null ?
 *   Y: 表示队列里还啥都没，queue.firstUpdate = queue.lastUpdate = update;
 *   N: 表示队列有东西，queue.lastUpdate.next = update(稍后这个queue.lastUpdate会变成第二个呀) 并 queue.lastUpdate = update;
 * @param {*} queue
 * @param {*} update
 */
function appendUpdateToQueue<State>(
  queue: UpdateQueue<State>,
  update: Update<State>,
) {
  // Append the update to the end of the list.
  if (queue.lastUpdate === null) {
    // Queue is empty
    queue.firstUpdate = queue.lastUpdate = update;
  } else {
    queue.lastUpdate.next = update;
    queue.lastUpdate = update;
  }
}

/**
 * 经过enqueueUpdate处理后
 *  若fiber.alternate不存在，update入队fiber.updateQueue
 *  若fiber.alternate存在，
 *    若fiber.updateQueue或fiber.alternate.updateQueue为null，就将有的那一个queue clone给没有的queue，两个都没有就createUpdateQueue
 *    只要fiber.updateQueue/fiber.alternate.updateQueue存在，update就会入fiber.updateQueue/fiber.alternate.updateQueue
 * @param {*} fiber
 * @param {*} update
 */
export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  // Update queues are created lazily.
  const alternate = fiber.alternate; // 是否有workinprogress的fiber
  let queue1; // current fiber的
  let queue2; // alternate fiber的

  /**
   * 下面这个if是用来处理queue的
   */
  if (alternate === null) {
    // There's only one fiber.
    // 只有一个fiber，queue1 = fiber.updateQueue | = fiber.updateQueue = createUpdateQueue，queue2 = null
    queue1 = fiber.updateQueue;
    queue2 = null;
    if (queue1 === null) {
      queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
    }
  } else {
    // There are two owners.
    // 有workinprogress的fiber
    queue1 = fiber.updateQueue;
    queue2 = alternate.updateQueue;
    if (queue1 === null) {
      if (queue2 === null) {
        // Neither fiber has an update queue. Create new ones.
        // queue1和queue2都为null，createUpdateQueue，并且赋值给queue1/fiber.update和queue2/alternate.updateQueue
        queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
        queue2 = alternate.updateQueue = createUpdateQueue(
          alternate.memoizedState,
        );
      } else {
        // Only one fiber has an update queue. Clone to create a new one.
        // queue1为null，queue2不为null，clone queue2给queue1/fiber.update
        queue1 = fiber.updateQueue = cloneUpdateQueue(queue2);
      }
    } else {
      if (queue2 === null) {
        // Only one fiber has an update queue. Clone to create a new one.
        // queue1不为null，queue2为null，clone queue2给queue1/fiber.update
        queue2 = alternate.updateQueue = cloneUpdateQueue(queue1);
      } else {
        // Both owners have an update queue.
      }
    }
  }

  /**
   * 下面这个if是用来处理update入queue的
   */
  if (queue2 === null || queue1 === queue2) {
    // There's only a single queue.
    // 只有queue1或者queue1 === queue2，update入queue1（对于queue1 === queue2的情况，update也相当于入queue2了）
    appendUpdateToQueue(queue1, update);
  } else {
    // There are two queues. We need to append the update to both queues,
    // while accounting for the persistent structure of the list — we don't
    // want the same update to be added multiple times.
    // 有两个queue
    if (queue1.lastUpdate === null || queue2.lastUpdate === null) {
      // One of the queues is not empty. We must add the update to both queues.
      // 且两个queue有一个没有内容，将update分别入queue1，queue2
      appendUpdateToQueue(queue1, update);
      appendUpdateToQueue(queue2, update);
    } else {
      // Both queues are non-empty. The last update is the same in both lists,
      // because of structural sharing. So, only append to one of the lists.
      // 且两个queue都非空，两个queue的lastUpdate是一样的（看上一个大的if，这两个queue就是一样的），update先入queue1
      appendUpdateToQueue(queue1, update);
      // But we still need to update the `lastUpdate` pointer of queue2.
      // 两个queue相同，那么经过appendUpdateToQueue(queue1, update)后，除了queue2.lastUpdate指向还有问题外
      // 其余的指向（什么next、firstUpdate）都是对的，那么只需要再单独修改这个就好了
      queue2.lastUpdate = update;
    }
  }

  if (__DEV__) {
    if (
      fiber.tag === ClassComponent &&
      (currentlyProcessingQueue === queue1 ||
        (queue2 !== null && currentlyProcessingQueue === queue2)) &&
      !didWarnUpdateInsideUpdate
    ) {
      warningWithoutStack(
        false,
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      didWarnUpdateInsideUpdate = true;
    }
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  update: Update<State>,
) {
  // Captured updates go into a separate list, and only on the work-in-
  // progress queue.
  let workInProgressQueue = workInProgress.updateQueue;
  if (workInProgressQueue === null) {
    workInProgressQueue = workInProgress.updateQueue = createUpdateQueue(
      workInProgress.memoizedState,
    );
  } else {
    // TODO: I put this here rather than createWorkInProgress so that we don't
    // clone the queue unnecessarily. There's probably a better way to
    // structure this.
    workInProgressQueue = ensureWorkInProgressQueueIsAClone(
      workInProgress,
      workInProgressQueue,
    );
  }

  // Append the update to the end of the list.
  if (workInProgressQueue.lastCapturedUpdate === null) {
    // This is the first render phase update
    workInProgressQueue.firstCapturedUpdate = workInProgressQueue.lastCapturedUpdate = update;
  } else {
    workInProgressQueue.lastCapturedUpdate.next = update;
    workInProgressQueue.lastCapturedUpdate = update;
  }
}

function ensureWorkInProgressQueueIsAClone<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
): UpdateQueue<State> {
  const current = workInProgress.alternate;
  if (current !== null) {
    // If the work-in-progress queue is equal to the current queue,
    // we need to clone it first.
    if (queue === current.updateQueue) {
      queue = workInProgress.updateQueue = cloneUpdateQueue(queue);
    }
  }
  return queue;
}

function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  switch (update.tag) {
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffects ||
            (debugRenderPhaseSideEffectsForStrictMode &&
              workInProgress.mode & StrictMode)
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
        return nextState;
      }
      // State object
      return payload;
    }
    case CaptureUpdate: {
      workInProgress.effectTag =
        (workInProgress.effectTag & ~ShouldCapture) | DidCapture;
    }
    // Intentional fallthrough
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffects ||
            (debugRenderPhaseSideEffectsForStrictMode &&
              workInProgress.mode & StrictMode)
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        partialState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
      } else {
        // Partial state object
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Merge the partial state and the previous state.
      return Object.assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

export function processUpdateQueue<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  props: any,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  hasForceUpdate = false;

  queue = ensureWorkInProgressQueueIsAClone(workInProgress, queue);

  if (__DEV__) {
    currentlyProcessingQueue = queue;
  }

  // These values may change as we process the queue.
  let newBaseState = queue.baseState;
  let newFirstUpdate = null;
  let newExpirationTime = NoWork;

  // Iterate through the list of updates to compute the result.
  let update = queue.firstUpdate;
  let resultState = newBaseState;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime < renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      if (newFirstUpdate === null) {
        // This is the first skipped update. It will be the first update in
        // the new list.
        newFirstUpdate = update;
        // Since this is the first update that was skipped, the current result
        // is the new base state.
        newBaseState = resultState;
      }
      // Since this update will remain in the list, update the remaining
      // expiration time.
      if (newExpirationTime < updateExpirationTime) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority. Process it and compute
      // a new result.
      resultState = getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        update.nextEffect = null;
        if (queue.lastEffect === null) {
          queue.firstEffect = queue.lastEffect = update;
        } else {
          queue.lastEffect.nextEffect = update;
          queue.lastEffect = update;
        }
      }
    }
    // Continue to the next update.
    update = update.next;
  }

  // Separately, iterate though the list of captured updates.
  let newFirstCapturedUpdate = null;
  update = queue.firstCapturedUpdate;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime < renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      if (newFirstCapturedUpdate === null) {
        // This is the first skipped captured update. It will be the first
        // update in the new list.
        newFirstCapturedUpdate = update;
        // If this is the first update that was skipped, the current result is
        // the new base state.
        if (newFirstUpdate === null) {
          newBaseState = resultState;
        }
      }
      // Since this update will remain in the list, update the remaining
      // expiration time.
      if (newExpirationTime < updateExpirationTime) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority. Process it and compute
      // a new result.
      resultState = getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        update.nextEffect = null;
        if (queue.lastCapturedEffect === null) {
          queue.firstCapturedEffect = queue.lastCapturedEffect = update;
        } else {
          queue.lastCapturedEffect.nextEffect = update;
          queue.lastCapturedEffect = update;
        }
      }
    }
    update = update.next;
  }

  if (newFirstUpdate === null) {
    queue.lastUpdate = null;
  }
  if (newFirstCapturedUpdate === null) {
    queue.lastCapturedUpdate = null;
  } else {
    workInProgress.effectTag |= Callback;
  }
  if (newFirstUpdate === null && newFirstCapturedUpdate === null) {
    // We processed every update, without skipping. That means the new base
    // state is the same as the result state.
    newBaseState = resultState;
  }

  queue.baseState = newBaseState;
  queue.firstUpdate = newFirstUpdate;
  queue.firstCapturedUpdate = newFirstCapturedUpdate;

  // Set the remaining expiration time to be whatever is remaining in the queue.
  // This should be fine because the only two other things that contribute to
  // expiration time are props and context. We're already in the middle of the
  // begin phase by the time we start processing the queue, so we've already
  // dealt with the props. Context in components that specify
  // shouldComponentUpdate is tricky; but we'll have to account for
  // that regardless.
  workInProgress.expirationTime = newExpirationTime;
  workInProgress.memoizedState = resultState;

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  // If the finished render included captured updates, and there are still
  // lower priority updates left over, we need to keep the captured updates
  // in the queue so that they are rebased and not dropped once we process the
  // queue again at the lower priority.
  if (finishedQueue.firstCapturedUpdate !== null) {
    // Join the captured update list to the end of the normal list.
    if (finishedQueue.lastUpdate !== null) {
      finishedQueue.lastUpdate.next = finishedQueue.firstCapturedUpdate;
      finishedQueue.lastUpdate = finishedQueue.lastCapturedUpdate;
    }
    // Clear the list of captured updates.
    finishedQueue.firstCapturedUpdate = finishedQueue.lastCapturedUpdate = null;
  }

  // Commit the effects
  commitUpdateEffects(finishedQueue.firstEffect, instance);
  finishedQueue.firstEffect = finishedQueue.lastEffect = null;

  commitUpdateEffects(finishedQueue.firstCapturedEffect, instance);
  finishedQueue.firstCapturedEffect = finishedQueue.lastCapturedEffect = null;
}

function commitUpdateEffects<State>(
  effect: Update<State> | null,
  instance: any,
): void {
  while (effect !== null) {
    const callback = effect.callback;
    if (callback !== null) {
      effect.callback = null;
      callCallback(callback, instance);
    }
    effect = effect.nextEffect;
  }
}
