// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import fetch from 'node-fetch';

const ASSISTANT_API_URL = 'https://assistant.nicholasgriffin.workers.dev';

export function activate(context: vscode.ExtensionContext) {
	console.log('Personal Coder is now active!');

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file' },
		{
			async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.substr(0, position.character);
				if (!linePrefix.endsWith('//ai ')) {
					return undefined;
				}

				const startLine = Math.max(0, position.line - 5);
				const context = document.getText(new vscode.Range(
					startLine, 0,
					position.line, position.character
				));

				try {
					const response = await fetch(`${ASSISTANT_API_URL}/chat`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							messages: [{
								role: 'user',
								content: `Complete this code: ${context}`
							}]
						})
					});

					const data = await response.json();
					const suggestion = data.completion;

					const completionItem = new vscode.CompletionItem(suggestion);
					completionItem.insertText = suggestion;
					completionItem.detail = 'AI Suggestion';
					return [completionItem];
				} catch (error) {
					console.error('Error getting completion:', error);
					return undefined;
				}
			}
		},
		' '
	);

	const explainCommand = vscode.commands.registerCommand('vscode-assistant.explainCode', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		const selection = editor.selection;
		const text = editor.document.getText(selection);

		if (!text) {
			vscode.window.showInformationMessage('Please select some code to explain');
			return;
		}

		try {
			const response = await fetch(`${ASSISTANT_API_URL}/chat`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					messages: [{
						role: 'user',
						content: `Explain this code: ${text}`
					}]
				})
			});

			const data = await response.json();
			const explanation = data.completion;

			const doc = await vscode.workspace.openTextDocument({
				content: explanation,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
		} catch (error) {
			console.error('Error getting explanation:', error);
			vscode.window.showErrorMessage('Failed to get code explanation');
		}
	});

	context.subscriptions.push(completionProvider, explainCommand);
}

export function deactivate() {}
