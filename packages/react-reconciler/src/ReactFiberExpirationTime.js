/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';

export type ExpirationTime = number;

export const NoWork = 0;
export const Never = 1;
export const Sync = MAX_SIGNED_31_BIT_INT;

const UNIT_SIZE = 10;
const MAGIC_NUMBER_OFFSET = MAX_SIGNED_31_BIT_INT - 1;

// 离MAGIC_NUMBER_OFFSET终点还有几个UNIT_SIZE单位
// 1 unit of expiration time represents 10ms.
// expiration的一个单位是10ms
// ——为啥要定义一个10ms的单位呢
// ————若两次调用该函数的入参ms相差10ms以内，则返回相同的值
// ————这意味着在调用层面是不关心10ms的误差的，只关心经过了几个expiration单位
// ————能通过这个实现节流，提高性能
// 下面这个函数是用于计算1073741821与某个ms时间值/10（已经经过了几单位的过期时间）后的差值的
// 如入参2515毫秒，先转成251个expiration time，| 0是为了取整用的
// 然后继续计算1073741821 - 251并返回
//
/**
 * 这里可以理解为在单位刻度为10ms的时间轴上设了一个终点坐标MAGIC_NUMBER_OFFSET 1073741821
 * 每次调用这个函数会得到ms/10后离终点还有多少个单位，这个值越小，意味着ms越大
 * @param {*} ms
 */
export function msToExpirationTime(ms: number): ExpirationTime {
  // Always add an offset so that we don't clash with the magic number for NoWork.
  return MAGIC_NUMBER_OFFSET - ((ms / UNIT_SIZE) | 0); // | 0 用于直接去掉小数点
}

/**
 * 与上面函数相反，用于从离终点刻度差值得到真正currentTime(当初调用now()得到的值)的
 * 反算有误差，但没关系，毕竟是在msToExpirationTime允许这样的误差的
 * @param {*} expirationTime
 */
export function expirationTimeToMs(expirationTime: ExpirationTime): number {
  return (MAGIC_NUMBER_OFFSET - expirationTime) * UNIT_SIZE;
}

/**
 * 按精度向上取整，如1101精度10，向上取整为1110
 */
function ceiling(num: number, precision: number): number {
  return (((num / precision) | 0) + 1) * precision;
}

/**
 * 计算出不同优先级的expirationTime
 * 假如这是一个交互任务
 *    比如说currentTime的值为1000，注意这个是“真正当前时间”与终点刻度的差值
 *    expirationInMs为150，bucketSizeMs为100
 *    设MAGIC_NUMBER_OFFSET为C
 *    C - ceiling(C - 1000 + 150/10, 100/10)
 *    得到的是一个比1000小15左右的值，离终点更近了15个UNIT_SIZE
 * NOTE: 由于ceilling的处理，以上述交互任务为例，100/10 = 10，这意味着currentTime为1000~1010的入参都会产出一样的结果
 *       这就是为啥外部bucketSizeMs会叫做xxx_Batch_Size的原因，批量更新啊，如同步的调用多个setState，那么其实优先级是一样的
 * @param {*} currentTime expirationTime，过期时间
 * @param {*} expirationInMs 某类优先级的偏移时间
 * @param {*} bucketSizeMs 步进时间，抹平一定的时间差
 */
function computeExpirationBucket(
  currentTime,
  expirationInMs,
  bucketSizeMs,
): ExpirationTime {
  return (
    MAGIC_NUMBER_OFFSET -
    ceiling(
      MAGIC_NUMBER_OFFSET - currentTime + expirationInMs / UNIT_SIZE,
      bucketSizeMs / UNIT_SIZE,
    )
  );
}

export const LOW_PRIORITY_EXPIRATION = 5000;
export const LOW_PRIORITY_BATCH_SIZE = 250;

export function computeAsyncExpiration(
  currentTime: ExpirationTime,
): ExpirationTime {
  return computeExpirationBucket(
    currentTime,
    LOW_PRIORITY_EXPIRATION,
    LOW_PRIORITY_BATCH_SIZE,
  );
}

// We intentionally set a higher expiration time for interactive updates in
// dev than in production.
//
// If the main thread is being blocked so long that you hit the expiration,
// it's a problem that could be solved with better scheduling.
//
// People will be more likely to notice this and fix it with the long
// expiration time in development.
//
// In production we opt for better UX at the risk of masking scheduling
// problems, by expiring fast.
export const HIGH_PRIORITY_EXPIRATION = __DEV__ ? 500 : 150;
export const HIGH_PRIORITY_BATCH_SIZE = 100;

export function computeInteractiveExpiration(currentTime: ExpirationTime) {
  return computeExpirationBucket(
    currentTime,
    HIGH_PRIORITY_EXPIRATION,
    HIGH_PRIORITY_BATCH_SIZE,
  );
}
