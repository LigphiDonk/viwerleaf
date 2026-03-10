import { parser } from '../lezer-latex/latex'

export const tokenNames: Array<string> = parser.nodeSet.types
  .map(type => type.name)
  .filter(Boolean)

export const Tokens: Record<string, Array<string>> = {
  ctrlSeq: tokenNames.filter(name => name.match(/^(Begin|End|.*CtrlSeq)$/)),
  ctrlSym: tokenNames.filter(name => name.match(/^.*CtrlSym$/)),
  envName: tokenNames.filter(name => name.match(/^.*EnvName$/)),
}
