import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

export function SettingsSection({
  title,
  description,
  children,
  trailing,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <section className="border-t border-zinc-200 pt-6 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          {description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          ) : null}
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  control,
  children,
}: {
  label: string
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {label}
        </div>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        ) : null}
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  )
}

export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      {children}
      {hint ? (
        <p className="mt-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-700'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 disabled:hover:bg-indigo-600',
  secondary:
    'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900',
  ghost:
    'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
  danger:
    'border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30',
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}) {
  const sizeClass = size === 'md' ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs'
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${BUTTON_VARIANT_CLASSES[variant]} ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-indigo-700 ${className ?? ''}`}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-indigo-700 ${className ?? ''}`}
    >
      {children}
    </select>
  )
}

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning'
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : tone === 'warning'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${toneClass}`}
    >
      {children}
    </span>
  )
}

export function MetaList({ items }: { items: ReactNode[] }) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
      {items.map((item, index) => (
        <span key={index}>{item}</span>
      ))}
    </div>
  )
}

export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
}) {
  const toneClass =
    tone === 'warning'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-zinc-500 dark:text-zinc-400'
  return (
    <p className={`text-[11px] leading-5 ${toneClass}`}>{children}</p>
  )
}
