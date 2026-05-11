import * as vscode from 'vscode';

import { COMMAND_EXPORT_DEFAULT_LAYOUT, COMMAND_SHOW_PANEL, VIEW_ID } from './constants.js';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';
import { runPreflight } from './preflight.js';

let providerInstance: PixelAgentsViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log(`[Pixel Agents] PIXEL_AGENTS_DEBUG=${process.env.PIXEL_AGENTS_DEBUG ?? 'not set'}`);
  const provider = new PixelAgentsViewProvider(context);
  providerInstance = provider;

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
      provider.exportDefaultLayout();
    }),
  );

  // Run preflight checks (binary + hooks) on activation
  const outputChannel = vscode.window.createOutputChannel('Pixel Agents');
  void runPreflight(outputChannel).then((result) => {
    if (result.errors.includes('binary_missing')) {
      void vscode.window.showErrorMessage(
        '[Pixel Agents] Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code/quickstart',
        'Open Quickstart',
      ).then((choice) => {
        if (choice === 'Open Quickstart') {
          void vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/claude-code/quickstart'));
        }
      });
    }
  });
}

export function deactivate() {
  providerInstance?.dispose();
}
