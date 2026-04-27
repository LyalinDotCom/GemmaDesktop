import { BrowserWindow, Menu, type Session, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface NativeTextContextMenuActions {
  replaceMisspelling(text: string, replacement?: EditableWordRange): void
  addWordToDictionary(word: string): void
}

export interface EditableWordRange {
  word: string
  start: number
  end: number
}

export interface NativeTextContextMenuOptions {
  fallbackMisspelling?: {
    wordRange: EditableWordRange
    suggestions: string[]
  }
}

export function configureNativeSpellChecker(session: Session): void {
  session.setSpellCheckerEnabled(true)

  const currentLanguages = session.getSpellCheckerLanguages()
  if (currentLanguages.length > 0) {
    return
  }

  const preferredLanguage = session.availableSpellCheckerLanguages.includes('en-US')
    ? 'en-US'
    : session.availableSpellCheckerLanguages.find((language) => language.startsWith('en-'))

  if (preferredLanguage) {
    session.setSpellCheckerLanguages([preferredLanguage])
  }
}

function extractFocusedEditableWordScript(): string {
  return `(() => {
    const element = document.activeElement;
    const canReadText =
      element instanceof HTMLTextAreaElement
      || (
        element instanceof HTMLInputElement
        && ['email', 'search', 'text', 'url', ''].includes(element.type)
      );

    if (!canReadText) {
      return null;
    }

    const value = element.value;
    const selectionStart = element.selectionStart ?? 0;
    const selectionEnd = element.selectionEnd ?? selectionStart;
    const selectedText = value.slice(selectionStart, selectionEnd).trim();

    if (/^[A-Za-z][A-Za-z'-]*$/.test(selectedText)) {
      return { word: selectedText, start: selectionStart, end: selectionEnd };
    }

    let start = selectionStart;
    let end = selectionStart;
    while (start > 0 && /[A-Za-z'-]/.test(value[start - 1] ?? '')) {
      start -= 1;
    }
    while (end < value.length && /[A-Za-z'-]/.test(value[end] ?? '')) {
      end += 1;
    }

    const word = value.slice(start, end);
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) {
      return null;
    }

    return { word, start, end };
  })()`
}

function replaceFocusedEditableWordScript(wordRange: EditableWordRange, replacement: string): string {
  return `(() => {
    const element = document.activeElement;
    const canWriteText =
      element instanceof HTMLTextAreaElement
      || (
        element instanceof HTMLInputElement
        && ['email', 'search', 'text', 'url', ''].includes(element.type)
      );

    if (!canWriteText) {
      return false;
    }

    const wordRange = ${JSON.stringify(wordRange)};
    const replacement = ${JSON.stringify(replacement)};
    if (element.value.slice(wordRange.start, wordRange.end) !== wordRange.word) {
      return false;
    }

    element.setRangeText(replacement, wordRange.start, wordRange.end, 'end');
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertReplacementText',
      data: replacement,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
}

function isEditableWordRange(value: unknown): value is EditableWordRange {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<EditableWordRange>
  return typeof candidate.word === 'string'
    && /^[A-Za-z][A-Za-z'-]*$/.test(candidate.word)
    && typeof candidate.start === 'number'
    && Number.isInteger(candidate.start)
    && candidate.start >= 0
    && typeof candidate.end === 'number'
    && Number.isInteger(candidate.end)
    && candidate.end > candidate.start
}

function normalizeSuggestions(suggestions: string[], word: string): string[] {
  const normalizedWord = word.toLocaleLowerCase()
  return suggestions
    .map((suggestion) => suggestion.trim())
    .filter((suggestion, index, values) =>
      suggestion.length > 0
      && suggestion.toLocaleLowerCase() !== normalizedWord
      && values.indexOf(suggestion) === index,
    )
    .slice(0, 8)
}

export async function getMacOSSpellingSuggestions(word: string): Promise<string[]> {
  if (process.platform !== 'darwin' || !/^[A-Za-z][A-Za-z'-]*$/.test(word)) {
    return []
  }

  const script = `
function run(argv) {
  ObjC.import('AppKit')
  const word = argv[0] || ''
  const checker = $.NSSpellChecker.sharedSpellChecker
  const nsWord = $(word)
  const misspelledRange = checker.checkSpellingOfStringStartingAtLanguageWrapInSpellDocumentWithTagWordCount(
    nsWord,
    0,
    'en',
    false,
    0,
    null
  )
  if (String(misspelledRange.location) !== '0' || String(misspelledRange.length) === '0') {
    return JSON.stringify([])
  }

  const guesses = checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(
    $.NSMakeRange(0, nsWord.length),
    nsWord,
    'en',
    0
  )
  const output = []
  for (let index = 0; index < guesses.count; index += 1) {
    output.push(ObjC.unwrap(guesses.objectAtIndex(index)))
  }
  return JSON.stringify(output)
}
`

  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script, word], {
      timeout: 1500,
      maxBuffer: 32_768,
    })
    const parsed = JSON.parse(stdout.trim()) as unknown
    return Array.isArray(parsed)
      ? normalizeSuggestions(parsed.filter((suggestion): suggestion is string => typeof suggestion === 'string'), word)
      : []
  } catch {
    return []
  }
}

async function resolveFallbackMisspelling(
  webContents: WebContents,
  params: Electron.ContextMenuParams,
): Promise<NativeTextContextMenuOptions['fallbackMisspelling']> {
  if (!params.isEditable || params.misspelledWord.trim().length > 0) {
    return undefined
  }

  const wordRange: unknown = await webContents.executeJavaScript(
    extractFocusedEditableWordScript(),
    true,
  )
  if (!isEditableWordRange(wordRange)) {
    return undefined
  }

  const suggestions = await getMacOSSpellingSuggestions(wordRange.word)
  if (suggestions.length === 0) {
    return undefined
  }

  return { wordRange, suggestions }
}

function canShowReadonlyTextMenu(params: Electron.ContextMenuParams): boolean {
  return params.selectionText.trim().length > 0
}

export function buildNativeTextContextMenuTemplate(
  params: Electron.ContextMenuParams,
  actions: NativeTextContextMenuActions,
  options: NativeTextContextMenuOptions = {},
): Electron.MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    if (!canShowReadonlyTextMenu(params)) {
      return []
    }

    return [
      { role: 'copy', enabled: params.editFlags.canCopy },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]
  }

  const template: Electron.MenuItemConstructorOptions[] = []
  const misspelledWord = params.misspelledWord.trim()
  const suggestions = normalizeSuggestions(params.dictionarySuggestions, misspelledWord)
  const fallbackMisspelling = options.fallbackMisspelling

  if (params.spellcheckEnabled && misspelledWord.length > 0) {
    if (suggestions.length > 0) {
      template.push(
        ...suggestions.slice(0, 8).map((suggestion) => ({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        })),
      )
    } else {
      template.push({ label: 'No Guesses Found', enabled: false })
    }

    template.push(
      { type: 'separator' },
      {
        label: `Add "${misspelledWord}" to Dictionary`,
        click: () => actions.addWordToDictionary(misspelledWord),
      },
      { type: 'separator' },
    )
  } else if (params.spellcheckEnabled && fallbackMisspelling) {
    template.push(
      ...fallbackMisspelling.suggestions.map((suggestion) => ({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion, fallbackMisspelling.wordRange),
      })),
      { type: 'separator' },
      {
        label: `Add "${fallbackMisspelling.wordRange.word}" to Dictionary`,
        click: () => actions.addWordToDictionary(fallbackMisspelling.wordRange.word),
      },
      { type: 'separator' },
    )
  }

  template.push(
    { role: 'undo', enabled: params.editFlags.canUndo },
    { role: 'redo', enabled: params.editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { role: 'delete', enabled: params.editFlags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', enabled: params.editFlags.canSelectAll },
  )

  return template
}

export function installNativeTextContextMenu(webContents: WebContents): void {
  configureNativeSpellChecker(webContents.session)

  webContents.on('context-menu', (event, params) => {
    event.preventDefault()

    void (async () => {
      const fallbackMisspelling = await resolveFallbackMisspelling(webContents, params)
      const template = buildNativeTextContextMenuTemplate(params, {
        replaceMisspelling: (text, replacement) => {
          if (replacement) {
            void webContents.executeJavaScript(replaceFocusedEditableWordScript(replacement, text), true)
            return
          }

          webContents.replaceMisspelling(text)
        },
        addWordToDictionary: (word) => {
          webContents.session.addWordToSpellCheckerDictionary(word)
        },
      }, { fallbackMisspelling })

      if (template.length === 0) {
        return
      }

      Menu.buildFromTemplate(template).popup({
        window: BrowserWindow.fromWebContents(webContents) ?? undefined,
        frame: params.frame ?? undefined,
      })
    })()
  })
}
