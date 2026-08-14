import * as vscode from 'vscode';
import { HarnessManager } from './harness/HarnessManager';
import { ChatViewProvider } from './providers/ChatViewProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const harness = new HarnessManager(context);
  const chatView = new ChatViewProvider(context.extensionUri, harness);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'DeepSeek API Key',
        prompt: 'Stored securely in VS Code SecretStorage on this VS Code host.',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey?.trim()) {
        await context.secrets.store('deepseekHarness.apiKey', apiKey.trim());
        await harness.restart();
        vscode.window.showInformationMessage('DeepSeek Harness API key saved.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.newSession', async () => {
      harness.newSession();
      chatView.resetConversation();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.installRuntime', async () => {
      await harness.installOrUpgradeRuntime();
    }),
  );

  context.subscriptions.push(harness);
}

export async function deactivate(): Promise<void> {
  // HarnessManager is disposed by the extension context.
}
