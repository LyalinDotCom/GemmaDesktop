export type AboutCreditKind = 'open-source' | 'system'

export interface AboutCreditEntry {
  id: string
  name: string
  version?: string
  license?: string
  website?: string
  role: string
  notes?: string
  kind: AboutCreditKind
}

export interface AboutCreditSection {
  id: string
  title: string
  description: string
  entries: readonly AboutCreditEntry[]
}

export const ABOUT_SCREEN_INTRO = {
  title: 'About Gemma Desktop',
  description:
    'Gemma Desktop is built on our own Gemma Desktop SDK packages plus a focused set of upstream projects for speech, browsing, PDFs, screenshots, and the desktop UI.',
  scopeNote:
    'This credits view is intentionally curated around the major runtime and user-visible components in the app, rather than every transitive development dependency.',
} as const

export const ABOUT_CREDIT_SECTIONS: readonly AboutCreditSection[] = [
  {
    id: 'speech',
    title: 'Speech Input',
    description:
      'Local dictation is powered by a managed runtime that Gemma Desktop installs into app data on demand.',
    entries: [
      {
        id: 'whisper-cpp',
        name: 'whisper.cpp',
        version: '1.8.1',
        license: 'MIT',
        website: 'https://github.com/ggml-org/whisper.cpp',
        role: 'Native local speech-to-text runtime for the composer microphone.',
        notes: 'Gemma Desktop installs and manages a pinned whisper.cpp runtime in app data.',
        kind: 'open-source',
      },
      {
        id: 'openai-whisper-models',
        name: 'OpenAI Whisper',
        license: 'MIT',
        website: 'https://github.com/openai/whisper',
        role: 'Original speech model family used by the pinned whisper.cpp transcription model.',
        notes: 'Gemma Desktop currently targets the ggml large-v3-turbo-q5_0 model for speech input.',
        kind: 'open-source',
      },
      {
        id: 'silero-vad',
        name: 'Silero VAD',
        license: 'MIT',
        website: 'https://github.com/snakers4/silero-vad',
        role: 'Voice activity detection that strips silence before whisper.cpp transcribes audio.',
        notes: 'Gemma Desktop installs and manages the pinned ggml Silero VAD model alongside the speech runtime.',
        kind: 'open-source',
      },
    ],
  },
  {
    id: 'voice',
    title: 'Read Aloud',
    description:
      'Offline assistant voice playback is bundled directly with the app so end users do not need Python or a separate speech runtime.',
    entries: [
      {
        id: 'kokoro-model',
        name: 'Kokoro 82M',
        license: 'Apache-2.0',
        website: 'https://github.com/hexgrad/kokoro',
        role: 'Bundled multilingual text-to-speech model used for the Read Aloud action on assistant messages.',
        notes: 'Gemma Desktop ships a pinned ONNX q8 asset bundle for offline playback.',
        kind: 'open-source',
      },
      {
        id: 'kokoro-js',
        name: 'kokoro-js',
        version: '1.2.1',
        license: 'Apache-2.0',
        website: 'https://github.com/hexgrad/kokoro/tree/main/kokoro.js',
        role: 'Node runtime wrapper that drives Kokoro voice synthesis from the Electron main process.',
        kind: 'open-source',
      },
      {
        id: 'transformers-js',
        name: 'Transformers.js',
        version: '3.5.1',
        license: 'Apache-2.0',
        website: 'https://github.com/huggingface/transformers.js',
        role: 'Local model loading, tokenizer handling, and WAV generation for Kokoro playback.',
        kind: 'open-source',
      },
      {
        id: 'onnxruntime-node',
        name: 'ONNX Runtime Node',
        version: '1.21.0',
        license: 'MIT',
        website: 'https://github.com/microsoft/onnxruntime',
        role: 'CPU inference backend used by the bundled Kokoro ONNX model.',
        kind: 'open-source',
      },
      {
        id: 'phonemizer-js',
        name: 'phonemizer',
        version: '1.2.1',
        license: 'Apache-2.0',
        website: 'https://github.com/xenova/phonemizer.js',
        role: 'English phonemization pipeline that prepares text for Kokoro speech generation.',
        kind: 'open-source',
      },
    ],
  },
  {
    id: 'research',
    title: 'Research And Extraction',
    description:
      'These libraries power the app’s web fetch, readable article extraction, feed parsing, and MCP transport layers.',
    entries: [
      {
        id: 'mcp-sdk',
        name: 'Model Context Protocol SDK',
        version: '1.29.0',
        license: 'MIT',
        website: 'https://modelcontextprotocol.io',
        role: 'Client and transport plumbing for MCP-powered tools and integrations.',
        kind: 'open-source',
      },
      {
        id: 'mozilla-readability',
        name: '@mozilla/readability',
        version: '0.6.0',
        license: 'Apache-2.0',
        website: 'https://github.com/mozilla/readability',
        role: 'Turns cluttered HTML pages into clean article text.',
        kind: 'open-source',
      },
      {
        id: 'google-genai',
        name: '@google/genai',
        version: '1.50.1',
        license: 'Apache-2.0',
        website: 'https://github.com/googleapis/js-genai',
        role: 'Gemini API client used for Google Search grounding in the web search tool.',
        kind: 'open-source',
      },
      {
        id: 'got-scraping',
        name: 'got-scraping',
        version: '4.2.1',
        license: 'Apache-2.0',
        website: 'https://github.com/apify/got-scraping',
        role: 'Robust HTTP fetching for research and source retrieval.',
        kind: 'open-source',
      },
      {
        id: 'jsdom',
        name: 'jsdom',
        version: '29.0.1',
        license: 'MIT',
        website: 'https://github.com/jsdom/jsdom',
        role: 'DOM parsing and inspection for extracted web content.',
        kind: 'open-source',
      },
      {
        id: 'fast-xml-parser',
        name: 'fast-xml-parser',
        version: '5.5.10',
        license: 'MIT',
        website: 'https://github.com/NaturalIntelligence/fast-xml-parser',
        role: 'Feed and XML parsing during research fetches.',
        kind: 'open-source',
      },
    ],
  },
  {
    id: 'documents',
    title: 'Documents And Browser Tools',
    description:
      'PDF review, screenshots, and live browser inspection rely on both open-source packages and native platform tools.',
    entries: [
      {
        id: 'pdf-to-img',
        name: 'pdf-to-img',
        version: '5.0.0',
        license: 'MIT',
        website: 'https://github.com/k-yle/pdf-to-img',
        role: 'Renders PDF pages into images for local multimodal review.',
        kind: 'open-source',
      },
      {
        id: 'pdfjs-dist',
        name: 'pdfjs-dist',
        version: '5.4.624',
        license: 'Apache-2.0',
        website: 'https://github.com/mozilla/pdf.js',
        role: 'Extracts embedded PDF text and supports fast local PDF inspection.',
        kind: 'open-source',
      },
      {
        id: 'chrome-devtools-mcp',
        name: 'chrome-devtools-mcp',
        version: '0.21.0',
        license: 'Apache-2.0',
        website: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
        role: 'Connects Gemma Desktop to a live Chrome session for browser inspection tools.',
        kind: 'open-source',
      },
      {
        id: 'macos-screencapture',
        name: 'macOS screencapture',
        license: 'System component',
        role: 'Native screenshot capture for the main display and specific windows on macOS.',
        notes: 'Used alongside Electron window APIs.',
        kind: 'system',
      },
    ],
  },
  {
    id: 'ui',
    title: 'Desktop UI',
    description:
      'These libraries shape the app shell, renderer UI, icons, markdown display, and syntax highlighting.',
    entries: [
      {
        id: 'electron',
        name: 'Electron',
        version: '41.3.0',
        license: 'MIT',
        website: 'https://github.com/electron/electron',
        role: 'Desktop shell, native integrations, permissions, and media/screenshot plumbing.',
        kind: 'open-source',
      },
      {
        id: 'react',
        name: 'React',
        version: '19.2.4',
        license: 'MIT',
        website: 'https://react.dev/',
        role: 'Renderer UI and application state composition.',
        notes: 'Includes react-dom 19.2.4.',
        kind: 'open-source',
      },
      {
        id: 'tailwindcss',
        name: 'Tailwind CSS',
        version: '3.4.19',
        license: 'MIT',
        website: 'https://tailwindcss.com',
        role: 'Utility styling system for the desktop interface.',
        kind: 'open-source',
      },
      {
        id: 'lucide-react',
        name: 'lucide-react',
        version: '0.475.0',
        license: 'ISC',
        website: 'https://lucide.dev',
        role: 'Icon set used across navigation, tools, and settings.',
        kind: 'open-source',
      },
      {
        id: 'react-markdown',
        name: 'react-markdown',
        version: '9.1.0',
        license: 'MIT',
        website: 'https://github.com/remarkjs/react-markdown',
        role: 'Markdown rendering inside chat and generated content views.',
        kind: 'open-source',
      },
      {
        id: 'remark-gfm',
        name: 'remark-gfm',
        version: '4.0.1',
        license: 'MIT',
        website: 'https://github.com/remarkjs/remark-gfm',
        role: 'GitHub-flavored Markdown support for tables, task lists, and autolinks.',
        kind: 'open-source',
      },
      {
        id: 'rehype-highlight',
        name: 'rehype-highlight',
        version: '7.0.2',
        license: 'MIT',
        website: 'https://github.com/rehypejs/rehype-highlight',
        role: 'Code block highlighting pipeline for rendered markdown.',
        notes: 'Uses highlight.js 11.11.1.',
        kind: 'open-source',
      },
      {
        id: 'highlight.js',
        name: 'highlight.js',
        version: '11.11.1',
        license: 'BSD-3-Clause',
        website: 'https://highlightjs.org/',
        role: 'Language grammars and styling hooks for highlighted code.',
        kind: 'open-source',
      },
    ],
  },
] as const

export function flattenAboutCreditEntries(
  sections: readonly AboutCreditSection[] = ABOUT_CREDIT_SECTIONS,
): AboutCreditEntry[] {
  return sections.flatMap((section) => [...section.entries])
}
