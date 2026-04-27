/**
 * Shared tokens for the chat composer chrome used by the main InputBar and
 * the side TalkInputBar. Keeping radius / padding / min-height / focus ring
 * in one place makes the two composers align visually across the app even
 * though their internals diverge significantly.
 *
 * The outer frame class intentionally omits color / border tokens so callers
 * can tint their own border (mode colors in main, neutral in side). Callers
 * compose the frame like:
 *
 *   <div className={`${COMPOSER_FRAME_BASE} ${yourBorderAndBgClass}`}>
 *     <textarea className={COMPOSER_TEXTAREA_BASE} ... />
 *     <div className={COMPOSER_ACTIONS_SLOT}> ...buttons... </div>
 *   </div>
 */

/** Outer composer shell — matches radius, min-height, padding. Use with a
 *  caller-provided border + background class. */
export const COMPOSER_FRAME_BASE =
  'flex min-h-[44px] items-center gap-2 rounded-2xl border px-3 py-2 transition-colors'

/** Floating composer variant for the Assistant Home welcome surface. Lands
 *  at a comfortable resting height instead of stubby-then-growing. The
 *  textarea inside still grows up to its cap as the user types. */
export const COMPOSER_FRAME_BASE_FLOATING =
  'flex min-h-[60px] items-center gap-2 rounded-2xl border px-3 py-2 transition-colors'

/** Textarea that sits inside the composer frame. Caps at two visible lines and
 *  scrolls internally past that, matching the welcome composer's discipline so
 *  Work-mode chats do not let the composer keep climbing up the transcript. */
export const COMPOSER_TEXTAREA_BASE =
  'scrollbar-thin block min-h-[24px] max-h-[64px] w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-100 dark:placeholder:text-zinc-500'

/** Floating textarea variant. Starts roomy, then caps at two visible lines. */
export const COMPOSER_TEXTAREA_BASE_FLOATING =
  'scrollbar-thin block min-h-[36px] max-h-[68px] w-full resize-none overflow-y-auto bg-transparent leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-100 dark:placeholder:text-zinc-500'

/** Button column that sits to the right of the textarea. */
export const COMPOSER_ACTIONS_SLOT = 'flex shrink-0 items-center gap-1'
