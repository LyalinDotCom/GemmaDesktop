import React from 'react';
import { Box, Text } from 'ink';
import { modelProfileLabel } from '../modelProfileLabel.js';
import { clip } from '../text/clip.js';
import type { TuiSession } from '../../tui.js';

interface Props {
  cwd: string;
  model: string;
  context: string;
  reasoning?: string;
  tokenRate?: string;
  branch?: string;
  width: number;
}

export function Footer({ cwd, model, context, reasoning, tokenRate, branch, width }: Props): React.ReactElement {
  const { left } = footerLayout({ cwd, model, context, reasoning, tokenRate, branch, width });
  const rightParts = footerRightParts({ cwd, model, context, reasoning, tokenRate, branch, width });
  return (
    <Box width={width} justifyContent="space-between">
      <Text dimColor>{left}</Text>
      <Text>
        {rightParts.map((part, index) => (
          <React.Fragment key={`${part}-${index}`}>
            {index > 0 ? <Text dimColor>  ·  </Text> : null}
            <Text
              bold={(part === context && part !== 'n/a') || part === tokenRate}
              color={part === context ? (part === 'n/a' ? 'yellow' : 'green') : part === tokenRate ? 'yellow' : undefined}
              dimColor={part !== context && part !== tokenRate}
            >
              {part}
            </Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}

export function footerLayout({ cwd, model, context, reasoning, tokenRate, branch, width }: Props): { left: string; right: string } {
  const home = process.env.HOME ?? '';
  const shownCwd = home ? cwd.replace(home, '~') : cwd;
  const leftParts = [shownCwd, branch].filter((value): value is string => Boolean(value));
  const rightParts = footerRightParts({ cwd, model, context, reasoning, tokenRate, branch, width });
  const right = rightParts.join('  ·  ');
  const leftBudget = Math.max(width - right.length - 2, 8);
  const left = clip(leftParts.join('  ·  '), leftBudget);
  return { left, right };
}

function footerRightParts({ model, context, reasoning, tokenRate }: Props): string[] {
  return [modelProfileLabel(model), reasoning, model, context, tokenRate].filter((value): value is string => Boolean(value));
}

export function reasoningFooterLabel(session: TuiSession): string {
  const mode = session.reasoningMode ?? 'auto';
  if (mode === 'off') {
    return 'think off';
  }
  if (session.provider === 'lmstudio' && session.runtime.providerReasoning !== true) {
    return session.runtime.providerReasoning === false ? 'think unsupported' : 'think unknown';
  }
  if (mode === 'on') {
    return 'think on';
  }
  if (session.provider === 'ollama') {
    return /gemma4/i.test(session.runtime.model) ? 'think on' : 'think off';
  }
  if (session.provider === 'lmstudio') {
    return /gemma[-_]?4/i.test(session.runtime.model) ? 'think on' : 'think off';
  }
  return 'think off';
}
