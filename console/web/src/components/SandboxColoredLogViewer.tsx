// Copyright 2026 The OpenSandbox Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { LazyLog, ScrollFollow } from '@melloware/react-logviewer';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { enrichLogTextForDisplay } from '../utils/enrichLogText';

import './SandboxColoredLogViewer.css';

type Props = {
  content: string;
  maxHeight?: number;
  /** 刷新后强制 remount，避免 LazyLog 缓存旧文本 */
  contentKey?: string;
  /** 内容更新或刷新后滚到最新日志；用户上滚阅读时会暂停跟随 */
  followTail?: boolean;
};

const LOG_VIEWER_STYLE = {
  backgroundColor: '#1e1e1e',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
} as const;

export function SandboxColoredLogViewer({
  content,
  maxHeight = 420,
  contentKey,
  followTail = true,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const text = useMemo(() => enrichLogTextForDisplay(content), [content]);
  const scrollEpoch = contentKey ?? String(text.length);

  const scrollToLogBottom = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.react-lazylog').forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  useLayoutEffect(() => {
    if (!followTail) return;
    scrollToLogBottom();
    const t1 = window.setTimeout(scrollToLogBottom, 0);
    const t2 = window.setTimeout(scrollToLogBottom, 120);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [followTail, scrollEpoch, text, scrollToLogBottom]);

  const lazyLog = (follow?: boolean, onScroll?: (args: { scrollTop: number; clientHeight: number; scrollHeight: number }) => void) => (
    <LazyLog
      text={text}
      height={maxHeight}
      width="100%"
      enableSearch
      enableSearchNavigation
      selectableLines
      rowHeight={18}
      extraLines={followTail ? 1 : 0}
      follow={followTail ? follow : undefined}
      onScroll={followTail ? onScroll : undefined}
      onLoad={followTail ? scrollToLogBottom : undefined}
      style={LOG_VIEWER_STYLE}
      containerStyle={{ background: '#1e1e1e', borderRadius: 6, maxWidth: '100%' }}
      searchBarClassName="sandbox-log-search"
      internacionalization={{
        searchBar: {
          searchPlaceholder: '搜索日志…',
          filterLinesTitle: '仅显示匹配行',
          previousButtonTitle: '上一处',
          nextButtonTitle: '下一处',
        },
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className="sandbox-log-viewer"
      style={followTail ? { height: maxHeight } : undefined}
    >
      {followTail ? (
        <ScrollFollow
          key={scrollEpoch}
          startFollowing
          render={({ follow, onScroll }) => lazyLog(follow, onScroll)}
        />
      ) : (
        lazyLog()
      )}
    </div>
  );
}
