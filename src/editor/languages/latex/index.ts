import { LanguageSupport } from '@codemirror/language'

import { latexIndentService } from './latex-indent-service'
import { LaTeXLanguage } from './latex-language'
import { shortcuts } from './shortcuts'

export const latex = () => {
  return new LanguageSupport(LaTeXLanguage, [
    shortcuts(),
    latexIndentService(),
  ])
}
