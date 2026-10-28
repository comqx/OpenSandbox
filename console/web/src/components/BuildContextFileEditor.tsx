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

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';
import { classifyShellEntry } from '../utils/buildContextShellTheme';

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const shellEditorChrome = EditorView.theme(
  {
    '&': {
      backgroundColor: '#0c0c0c',
      color: '#e6edf3',
      border: '1px solid #3a3a3a',
      borderRadius: '6px',
      fontSize: '13px',
      overflow: 'hidden',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: '#58a6ff',
      boxShadow: 'inset 2px 0 0 #58a6ff',
    },
    '.cm-scroller': {
      fontFamily: MONO,
      lineHeight: '1.55',
      minHeight: '320px',
    },
    '.cm-content': {
      caretColor: '#3fb950',
      padding: '6px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#3fb950',
      borderLeftWidth: '2px',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: '#2d333b',
      },
    '.cm-gutters': {
      backgroundColor: '#0c0c0c',
      color: '#6e7681',
      border: 'none',
      borderRight: '1px solid #3a3a3a',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 8px',
    },
    '.cm-activeLine': {
      backgroundColor: '#1f1f1f',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#1f1f1f',
      color: '#c9d1d9',
    },
    '.cm-line': {
      padding: '0 10px',
    },
  },
  { dark: true },
);

const shellHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6e7681' },
  { tag: tags.keyword, color: '#ffa657', fontWeight: '600' },
  { tag: tags.string, color: '#3fb950' },
  { tag: tags.number, color: '#79c0ff' },
]);

const DOCKER_INSTRUCTION =
  /^(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/;

const dockerfileLanguage = StreamLanguage.define({
  tokenTable: {
    comment: tags.comment,
    keyword: tags.keyword,
    string: tags.string,
    number: tags.number,
  },
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/[ \t]*#.*/)) return 'comment';
      stream.eatWhile(/[ \t]/);
      if (stream.match(DOCKER_INSTRUCTION)) return 'keyword';
    }
    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return 'string';
    if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
    stream.next();
    return null;
  },
});

const shellScriptLanguage = StreamLanguage.define({
  tokenTable: {
    comment: tags.comment,
    string: tags.string,
  },
  token(stream) {
    if (stream.sol() && stream.match(/[ \t]*#.*/)) return 'comment';
    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return 'string';
    stream.next();
    return null;
  },
});

type BuildContextFileEditorProps = {
  value: string;
  filePath?: string;
  dockerfilePath?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
};

export function BuildContextFileEditor({
  value,
  filePath,
  dockerfilePath = 'Dockerfile',
  readOnly,
  onChange,
}: BuildContextFileEditorProps) {
  const extensions = useMemo(() => {
    const next = [shellEditorChrome, syntaxHighlighting(shellHighlight)];
    if (!filePath) return next;
    const kind = classifyShellEntry(filePath, false, dockerfilePath).kind;
    if (kind === 'dockerfile') next.push(dockerfileLanguage);
    else if (kind === 'shellScript') next.push(shellScriptLanguage);
    return next;
  }, [dockerfilePath, filePath]);

  return (
    <CodeMirror
      value={value}
      height="360px"
      theme="none"
      readOnly={readOnly}
      extensions={extensions}
      onChange={(next) => onChange?.(next)}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        syntaxHighlighting: false,
        highlightSelectionMatches: false,
      }}
    />
  );
}
