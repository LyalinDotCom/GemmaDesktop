export function modelDisplayName(model: string): string {
  const gemma4 = model.match(/^gemma4:((?:e)?\d+b)(?:[-_:].*)?$/i);
  if (gemma4) {
    return `Gemma 4 ${gemma4[1]!.toUpperCase()} (${model})`;
  }

  const gemmaVersioned = model.match(/^gemma(?:[-_ ]?)(\d+)(?::|-)(\d+)b(?:[-_:].*)?$/i);
  if (gemmaVersioned) {
    return `Gemma ${gemmaVersioned[1]} ${gemmaVersioned[2]}B (${model})`;
  }

  return model;
}
