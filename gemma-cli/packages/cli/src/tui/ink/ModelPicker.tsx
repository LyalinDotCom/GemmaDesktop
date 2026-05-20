import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../text/clip.js';
import type { SessionModelInfo } from '../../tui.js';

export interface ModelPickerState {
  models: SessionModelInfo[];
  filter: string;
  selected: number;
  loading: boolean;
  startup?: boolean;
  noModels?: boolean;
  hint?: string;
  error?: string;
}

interface Props {
  picker: ModelPickerState;
  currentModel: string;
  currentProvider: string;
  width: number;
  height: number;
}

export function ModelPicker({ picker, currentModel, currentProvider, width, height }: Props): React.ReactElement {
  const models = filterModels(picker);
  const listHeight = Math.max(height - 3, 1);
  const selected = clamp(picker.selected, 0, Math.max(models.length - 1, 0));
  const start = Math.max(0, Math.min(selected - listHeight + 1, Math.max(models.length - listHeight, 0)));
  const visible = models.slice(start, start + listHeight);
  const countText = picker.loading ? 'loading' : `${models.length}/${picker.models.length}`;
  const filterText = picker.filter ? `filter ${picker.filter}` : 'type to filter';
  const title = picker.startup ? `Select Model  ${countText}` : `Models  ${countText}  current ${currentModel}`;
  const controls = picker.startup
    ? picker.noModels
      ? 'Esc/q exit'
      : '↑↓ move  Enter start  Esc exit'
    : `${filterText}  ↑↓ move  Enter select  Esc close`;
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyanBright" bold>{clip(title, width - 4)}</Text>
      <Text dimColor>{clip(controls, width - 4)}</Text>
      {picker.hint && !picker.error && <Text dimColor>{clip(picker.hint, width - 4)}</Text>}
      {picker.error && <Text color={picker.noModels ? 'yellow' : 'red'}>{clip(picker.error, width - 4)}</Text>}
      {!picker.error && picker.loading && <Text dimColor>{clip('loading models...', width - 4)}</Text>}
      {!picker.error && !picker.loading && visible.length === 0 && <Text dimColor>{clip(picker.noModels ? 'no local inference providers are available' : 'no matching models', width - 4)}</Text>}
      {!picker.error && !picker.loading && visible.map((model, index) => {
        const absoluteIndex = start + index;
        const active = absoluteIndex === selected;
        const current = model.name === currentModel && model.provider === currentProvider;
        const label = `${active ? '›' : ' '} ${current ? '*' : ' '} ${model.name}`;
        const detail = modelDetail(model);
        const labelWidth = Math.min(42, Math.max(Math.floor(width * 0.48), 24));
        return (
          <Text
            key={`${model.provider}:${model.name}`}
            backgroundColor={active ? 'blue' : undefined}
            color={active ? 'white' : current ? 'green' : undefined}
          >
            {clip(`${label.padEnd(labelWidth, ' ')}${detail}`, width - 4)}
          </Text>
        );
      })}
    </Box>
  );
}

export function filterModels(picker: ModelPickerState): SessionModelInfo[] {
  const filter = picker.filter.trim().toLowerCase();
  if (!filter) return picker.models;
  return picker.models.filter((model) => [
    model.name,
    model.provider,
    model.provider === 'lmstudio' || model.provider === 'gemini' ? model.displayName : undefined,
    model.provider === 'lmstudio' ? model.selectedVariant : undefined
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(filter)));
}

function modelDetail(model: SessionModelInfo): string {
  const size = model.provider === 'ollama' && model.sizeBytes ? formatBytes(model.sizeBytes) : '';
  const display = (model.provider === 'lmstudio' || model.provider === 'gemini') && model.displayName && model.displayName !== model.name ? model.displayName : '';
  const variant = model.provider === 'lmstudio' && model.selectedVariant && model.selectedVariant !== model.name ? model.selectedVariant : '';
  const loaded = model.provider === 'lmstudio' && model.loadedInstanceId ? `loaded ${model.loadedInstanceId}` : '';
  const details = [
    model.provider,
    size,
    display,
    variant,
    model.name.includes('mlx') ? 'MLX' : '',
    model.name.includes('bf16') ? 'bf16' : '',
    model.name.includes('coder') ? 'code' : '',
    model.supportsImage ? 'image' : '',
    model.supportsAudio ? 'audio' : '',
    model.provider === 'lmstudio' || model.provider === 'gemini' ? reasoningDetail(model.supportsReasoning) : '',
    model.name.includes('whisper') ? 'audio' : '',
    loaded
  ].filter(Boolean);
  return details.join('  ');
}

function reasoningDetail(supportsReasoning: boolean | undefined): string {
  if (supportsReasoning === true) return 'reasoning';
  if (supportsReasoning === false) return 'no-reasoning';
  return 'reasoning?';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
