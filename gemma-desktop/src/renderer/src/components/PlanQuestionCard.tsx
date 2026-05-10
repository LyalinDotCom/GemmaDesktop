import { useState } from 'react'
import { HelpCircle, Send } from 'lucide-react'
import type { PendingPlanQuestion } from '@/types'

interface PlanQuestionCardProps {
  question: PendingPlanQuestion
  onAnswer: (answer: string) => Promise<void>
}

export function PlanQuestionCard({
  question,
  onAnswer,
}: PlanQuestionCardProps) {
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submitAnswer = async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || submitting) {
      return
    }

    setSubmitting(true)
    try {
      await onAnswer(trimmed)
      setAnswer('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-zinc-200 bg-amber-50/70 px-6 py-3 dark:border-zinc-800 dark:bg-amber-950/20">
      <div className="mb-2 flex items-start gap-2">
        <HelpCircle size={15} className="mt-0.5 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Planning question
          </div>
          <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            {question.question}
          </div>
          {question.details && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {question.details}
            </div>
          )}
        </div>
      </div>

      {question.options.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              onClick={() => submitAnswer(option)}
              disabled={submitting}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:border-amber-400 hover:text-zinc-950 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-zinc-100"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitAnswer(answer)
            }
          }}
          placeholder={question.placeholder ?? 'Type your answer'}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-amber-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-amber-500"
        />
        <button
          onClick={() => void submitAnswer(answer)}
          disabled={!answer.trim() || submitting}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1">
            <Send size={14} />
            Answer
          </span>
        </button>
      </div>
    </div>
  )
}
