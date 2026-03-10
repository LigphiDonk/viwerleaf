import { Prec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'

const wrapSelection = (view: EditorView, command: string) => {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `${command}{${selected}}` },
    selection: {
      anchor: from + command.length + 1,
      head: from + command.length + 1 + selected.length,
    },
  })
  return true
}

export const shortcuts = () => {
  return Prec.high(
    keymap.of([
      {
        key: 'Ctrl-b',
        mac: 'Mod-b',
        preventDefault: true,
        run: view => wrapSelection(view, '\\textbf'),
      },
      {
        key: 'Ctrl-i',
        mac: 'Mod-i',
        preventDefault: true,
        run: view => wrapSelection(view, '\\textit'),
      },
    ])
  )
}
