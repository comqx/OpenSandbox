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
  { tag: tags.comment, color: '#8c8c8c', fontStyle: 'italic' },
  { tag: tags.propertyName, color: '#1677ff', fontWeight: '600' },
  { tag: tags.keyword, color: '#1677ff' },
  { tag: tags.string, color: '#237804' },
  { tag: tags.content, color: '#237804' },
  { tag: tags.number, color: '#d46b08' },
  { tag: tags.bool, color: '#cf1322' },
  { tag: tags.null, color: '#cf1322' },
  { tag: tags.separator, color: '#595959' },
]);

const editorChrome = EditorView.theme({
  '&': {
    border: '1px solid #d9d9d9',
    borderRadius: '8px',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: '#1677ff',
    boxShadow: '0 0 0 2px rgba(22, 119, 255, 0.12)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    color: '#8c8c8c',
    border: 'none',
    borderRadius: '8px 0 0 8px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(22, 119, 255, 0.06)',
  },
});

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
      theme="light"
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
