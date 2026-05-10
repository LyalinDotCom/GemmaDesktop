import { describe, expect, it } from 'vitest';
import { permissionPanelLayout } from './PermissionPanel.js';
import type { WorkspacePermissionRequest } from 'gemma-cli-core';

const request: WorkspacePermissionRequest = {
  tool: 'write_file',
  workspace: '/repo',
  reason: 'write file path is outside the workspace; path uses a home-directory reference',
  paths: ['/Users/example/source/foo.txt']
};

describe('permissionPanelLayout', () => {
  it('makes the permission prompt read as an interactive action', () => {
    const layout = permissionPanelLayout(request, 100);

    expect(layout.title).toContain('ACTION REQUIRED');
    expect(layout.tool).toContain('write_file');
    expect(layout.reason).toContain('outside the workspace');
    expect(layout.paths).toContain('/Users/example/source/foo.txt');
    expect(layout.prompt).toContain('[Y] Allow once');
    expect(layout.prompt).toContain('[N/Esc/Enter] Deny');
  });

  it('clips long lines to the available width', () => {
    const layout = permissionPanelLayout(request, 42);

    expect(layout.reason.length).toBeLessThanOrEqual(34);
    expect(layout.paths.length).toBeLessThanOrEqual(34);
  });
});
