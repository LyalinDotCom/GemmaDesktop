import { describe, expect, it, vi } from 'vitest'
import {
  buildNativeTextContextMenuTemplate,
  configureNativeSpellChecker,
} from '../src/main/nativeTextContextMenu'

function makeContextMenuParams(
  input: Partial<Electron.ContextMenuParams>,
): Electron.ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: '',
    linkText: '',
    pageURL: 'file:///app/index.html',
    frameURL: 'file:///app/index.html',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: true,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: 'default', url: '' },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: 'utf-8',
    formControlType: 'text-area',
    spellcheckEnabled: true,
    menuSourceType: 'mouse',
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: true,
      canDelete: false,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...input,
  }
}

describe('buildNativeTextContextMenuTemplate', () => {
  it('adds spelling suggestions before edit commands for misspelled editable text', () => {
    const replaceMisspelling = vi.fn()
    const addWordToDictionary = vi.fn()
    const template = buildNativeTextContextMenuTemplate(
      makeContextMenuParams({
        misspelledWord: 'ging',
        dictionarySuggestions: ['going', 'ginger'],
      }),
      { replaceMisspelling, addWordToDictionary },
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'going',
      'ginger',
      'separator',
      'Add "ging" to Dictionary',
      'separator',
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
    ])

    template[0]?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[3]?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)

    expect(replaceMisspelling).toHaveBeenCalledWith('going')
    expect(addWordToDictionary).toHaveBeenCalledWith('ging')
  })

  it('keeps paste and select all available when no misspelling is under the cursor', () => {
    const template = buildNativeTextContextMenuTemplate(
      makeContextMenuParams({ misspelledWord: '', dictionarySuggestions: [] }),
      { replaceMisspelling: vi.fn(), addWordToDictionary: vi.fn() },
    )

    expect(template.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
    ])
  })

  it('adds macOS fallback suggestions when Electron does not identify the misspelled word', () => {
    const replaceMisspelling = vi.fn()
    const addWordToDictionary = vi.fn()
    const wordRange = { word: 'speling', start: 2, end: 9 }
    const template = buildNativeTextContextMenuTemplate(
      makeContextMenuParams({ misspelledWord: '', dictionarySuggestions: [] }),
      { replaceMisspelling, addWordToDictionary },
      {
        fallbackMisspelling: {
          wordRange,
          suggestions: ['spelling', 'spewing'],
        },
      },
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'spelling',
      'spewing',
      'separator',
      'Add "speling" to Dictionary',
      'separator',
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
    ])

    template[0]?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)

    expect(replaceMisspelling).toHaveBeenCalledWith('spelling', wordRange)
  })

  it('does not show a context menu for non-editable empty text', () => {
    const template = buildNativeTextContextMenuTemplate(
      makeContextMenuParams({ isEditable: false, selectionText: '' }),
      { replaceMisspelling: vi.fn(), addWordToDictionary: vi.fn() },
    )

    expect(template).toEqual([])
  })
})

describe('configureNativeSpellChecker', () => {
  it('enables spellcheck and selects en-US when no language is configured', () => {
    const session = {
      availableSpellCheckerLanguages: ['en-GB', 'en-US'],
      getSpellCheckerLanguages: vi.fn(() => []),
      setSpellCheckerEnabled: vi.fn(),
      setSpellCheckerLanguages: vi.fn(),
    }

    configureNativeSpellChecker(session as unknown as Electron.Session)

    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith(['en-US'])
  })

  it('does not replace an existing spellcheck language selection', () => {
    const session = {
      availableSpellCheckerLanguages: ['en-US'],
      getSpellCheckerLanguages: vi.fn(() => ['fr-FR']),
      setSpellCheckerEnabled: vi.fn(),
      setSpellCheckerLanguages: vi.fn(),
    }

    configureNativeSpellChecker(session as unknown as Electron.Session)

    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled()
  })
})
