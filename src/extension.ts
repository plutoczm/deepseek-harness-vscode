import * as vscode from 'vscode';
import { ContextCollector } from './context/ContextCollector';
import { HarnessManager } from './harness/HarnessManager';
import { ChatViewProvider } from './providers/ChatViewProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const harness = new HarnessManager(context);
  const collector = new ContextCollector();
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

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.addSelection', async () => {
      chatView.addContext(await collector.selection());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.addCurrentFile', async (uri?: vscode.Uri) => {
      chatView.addContext(await collector.file(uri));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.addProblems', async () => {
      chatView.addContext(await collector.problems());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.fixSelection', async () => {
      chatView.addContext(await collector.selection());
      chatView.prefillPrompt(
        'Review the selected code, identify the root cause of any defects, and implement the smallest correct fix. Preserve existing behavior that is unrelated to the bug and run relevant checks when possible.',
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.explainSelection', async () => {
      chatView.addContext(await collector.selection());
      chatView.prefillPrompt(
        'Explain the selected code precisely: what it does, the important control/data flow, assumptions, edge cases, and any correctness or maintainability risks.',
      );
    }),
  );

  context.subscriptions.push(harness);
}

export async function deactivate(): Promise<void> {
  // HarnessManager is disposed by the extension context.
}
