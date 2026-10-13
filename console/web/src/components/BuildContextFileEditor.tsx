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

import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';

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
    minHeight: '320px',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    color: '#8c8c8c',
    borderRight: '1px solid #f0f0f0',
  },
});

type BuildContextFileEditorProps = {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
};

export function BuildContextFileEditor({ value, readOnly, onChange }: BuildContextFileEditorProps) {
  return (
    <CodeMirror
      value={value}
      height="360px"
      readOnly={readOnly}
      extensions={[editorChrome]}
      onChange={(next) => onChange?.(next)}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
      }}
    />
  );
}
