/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {LazyComponent, Thenable} from 'shared/ReactLazyComponent';

import {REACT_LAZY_TYPE} from 'shared/ReactSymbols';
import warning from 'shared/warning';

export function lazy<T, R>(ctor: () => Thenable<T, R>): LazyComponent<T> {
  // const Home = React.lazy(()=>import('./routes/home'));
  // 即接收一个返回Thenable对象的匿名函数，返回如下对象
  let lazyType = {
    $$typeof: REACT_LAZY_TYPE,
    _ctor: ctor,
    // React uses these fields to store the result.
    // 这个是用来记录Thenable状态的
    _status: -1,
    // 这个是用来记录Thenable的返回值的，结合具体实例import来看，是记录import某个module后的default的值的
    _result: null,
  };

  if (__DEV__) {
    // In production, this would just set it on the object.
    let defaultProps;
    let propTypes;
    Object.defineProperties(lazyType, {
      defaultProps: {
        configurable: true,
        get() {
          return defaultProps;
        },
        set(newDefaultProps) {
          warning(
            false,
            'React.lazy(...): It is not supported to assign `defaultProps` to ' +
              'a lazy component import. Either specify them where the component ' +
              'is defined, or create a wrapping component around it.',
          );
          defaultProps = newDefaultProps;
          // Match production behavior more closely:
          Object.defineProperty(lazyType, 'defaultProps', {
            enumerable: true,
          });
        },
      },
      propTypes: {
        configurable: true,
        get() {
          return propTypes;
        },
        set(newPropTypes) {
          warning(
            false,
            'React.lazy(...): It is not supported to assign `propTypes` to ' +
              'a lazy component import. Either specify them where the component ' +
              'is defined, or create a wrapping component around it.',
          );
          propTypes = newPropTypes;
          // Match production behavior more closely:
          Object.defineProperty(lazyType, 'propTypes', {
            enumerable: true,
          });
        },
      },
    });
  }

  return lazyType;
}
