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

import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import CodeMirror from '@uiw/react-codemirror';

const yamlHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: tags.propertyName, color: '#4ec9b0', fontWeight: '600' },
  { tag: tags.keyword, color: '#4ec9b0' },
  { tag: tags.string, color: '#ce9178' },
  { tag: tags.content, color: '#d4d4d4' },
  { tag: tags.number, color: '#b5cea8' },
  { tag: tags.bool, color: '#569cd6' },
  { tag: tags.null, color: '#569cd6' },
  { tag: tags.separator, color: '#808080' },
]);

const editorChrome = EditorView.theme(
  {
    '&': {
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4',
      border: '1px solid #3c3c3c',
      borderRadius: '8px',
      fontSize: '13px',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: '#3c3c3c',
      boxShadow: 'none',
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.6',
    },
    '.cm-content': {
      caretColor: '#d4d4d4',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#d4d4d4',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: '#264f78',
      },
    '.cm-gutters': {
      backgroundColor: '#1e1e1e',
      color: '#858585',
      border: 'none',
      borderRight: '1px solid #2d2d2d',
      borderRadius: '8px 0 0 8px',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
      color: '#c6c6c6',
    },
  },
  { dark: true },
);

const extensions = [yaml(), syntaxHighlighting(yamlHighlight), editorChrome];

export function YamlCodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      height="440px"
      theme="none"
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
      }}
      onChange={onChange}
    />
  );
}
