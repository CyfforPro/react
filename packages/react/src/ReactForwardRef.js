/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {REACT_FORWARD_REF_TYPE, REACT_MEMO_TYPE} from 'shared/ReactSymbols';

// 因为函数组件没有实例，因此直接在函数组件上用ref属性是无效的
// 此时方法有2
// 1. 自行传递specialRef的prop进去（不能再用ref这个关键字了）
/*
  function Child(props) {
    return <input ref={props.inputRef} />;
  }
  function Parent() {
    const ref = createRef();
    // 组件“didMount”后就可以开心的拿到Child中input dom了
    return <Child inputRef={ref} />;
  }
 */
// 2. 使用forwardRef将ref转发到函数组件内部
// 实质上forwardRef做的事情就是类似方法1的，只不过集成到了react内部
// 这里只是很简单的返回了一个$$typeof为REACT_FORWARD_REF_TYPE的ReactElement
export function forwardRef<Props, ElementType: React$ElementType>(
  render: (props: Props, ref: React$Ref<ElementType>) => React$Node,
) {
  if (__DEV__) {
    if (render != null && render.$$typeof === REACT_MEMO_TYPE) {
      console.error(
        'forwardRef requires a render function but received a `memo` ' +
          'component. Instead of forwardRef(memo(...)), use ' +
          'memo(forwardRef(...)).',
      );
    } else if (typeof render !== 'function') {
      console.error(
        'forwardRef requires a render function but was given %s.',
        render === null ? 'null' : typeof render,
      );
    } else {
      if (render.length !== 0 && render.length !== 2) {
        console.error(
          'forwardRef render functions accept exactly two parameters: props and ref. %s',
          render.length === 1
            ? 'Did you forget to use the ref parameter?'
            : 'Any additional parameter will be undefined.',
        );
      }
    }

    if (render != null) {
      if (render.defaultProps != null || render.propTypes != null) {
        console.error(
          'forwardRef render functions do not support propTypes or defaultProps. ' +
            'Did you accidentally pass a React component?',
        );
      }
    }
  }

  const elementType = {
    $$typeof: REACT_FORWARD_REF_TYPE,
    render,
  };
  if (__DEV__) {
    let ownName;
    Object.defineProperty(elementType, 'displayName', {
      enumerable: false,
      configurable: true,
      get: function () {
        return ownName;
      },
      set: function (name) {
        ownName = name;
        if (render.displayName == null) {
          render.displayName = name;
        }
      },
    });
  }
  return elementType;
}
