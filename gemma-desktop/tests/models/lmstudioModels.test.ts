import { describe, expect, it } from 'vitest'
import {
  extractLmStudioInstanceId,
  findLoadedLmStudioInstance,
  findLoadedLmStudioInstanceId,
} from '../../src/main/lmstudioModels'

describe('lmstudio model helpers', () => {
  it('returns the loaded instance id for the selected model', () => {
    const payload = {
      models: [
        {
          key: 'minimax-m2.7-ram-90gb-mlx',
          loaded_instances: [
            {
              id: 'lmstudio-instance-123',
              config: {
                context_length: 65536,
              },
            },
          ],
        },
      ],
    }

    expect(
      findLoadedLmStudioInstanceId(
        payload,
        'minimax-m2.7-ram-90gb-mlx',
      ),
    ).toBe('lmstudio-instance-123')
    expect(
      findLoadedLmStudioInstance(payload, 'minimax-m2.7-ram-90gb-mlx'),
    ).toEqual({
      id: 'lmstudio-instance-123',
      config: {
        context_length: 65536,
      },
    })
  })

  it('ignores visible models without a loaded instance', () => {
    expect(
      findLoadedLmStudioInstanceId(
        {
          models: [
            {
              key: 'minimax-m2.7-ram-90gb-mlx',
              loaded_instances: [],
            },
          ],
        },
        'minimax-m2.7-ram-90gb-mlx',
      ),
    ).toBeUndefined()
  })

  it('extracts the instance id returned by a load request', () => {
    expect(
      extractLmStudioInstanceId({
        instance_id: 'lmstudio-instance-456',
      }),
    ).toBe('lmstudio-instance-456')
  })
})
