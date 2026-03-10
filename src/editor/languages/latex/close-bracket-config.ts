import type { CloseBracketConfig } from '@codemirror/autocomplete'

export const closeBracketConfig: CloseBracketConfig = {
  brackets: ['$', '[', '{', '('],
  before: ')]}:;>,',
}
