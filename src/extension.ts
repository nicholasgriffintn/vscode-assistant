import * as vscode from "vscode";
import fetch from "node-fetch";
import { debounce } from "lodash";

interface AssistantResponse {
	choices?: Array<{
		message?: {
			content: string;
		};
	}>;
	error?: string;
}

interface TriggerPatterns {
	[key: string]: RegExp;
}

interface AssistantConfig {
	apiKey: string;
	maxContextLines: number;
	debounceDelay: number;
	apiUrl: string;
	model: string;
	email: string;
}

const DEFAULT_CONFIG: AssistantConfig = {
	apiKey: "",
	maxContextLines: 50,
	debounceDelay: 300,
	apiUrl: "https://assistant.nicholasgriffin.workers.dev",
	model: "claude-3.5-sonnet",
	email: "vscode@undefined.computer",
};

export class AssistantExtension {
	private context: vscode.ExtensionContext;
	private config: AssistantConfig;
	private statusBarItem!: vscode.StatusBarItem;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.config = this.loadConfiguration();
		this.initialize();
	}

	private logError(error: Error, context: string) {
		const errorInfo = {
			message: error.message,
			stack: error.stack,
			context,
			timestamp: new Date().toISOString(),
			workspace: vscode.workspace.name || "unknown",
		};

		console.error("AI Assistant Error:", errorInfo);

		vscode.window
			.showErrorMessage(`AI Assistant Error: ${error.message}`, "Show Details")
			.then((selection) => {
				if (selection === "Show Details") {
					vscode.workspace
						.openTextDocument({
							content: JSON.stringify(errorInfo, null, 2),
							language: "json",
						})
						.then((doc) => {
							vscode.window.showTextDocument(doc);
						});
				}
			});
	}

	private loadConfiguration(): AssistantConfig {
		const config = vscode.workspace.getConfiguration("personalCoder");
		return {
			apiKey: config.get<string>("apiKey") || DEFAULT_CONFIG.apiKey,
			maxContextLines:
				config.get<number>("maxContextLines") || DEFAULT_CONFIG.maxContextLines,
			debounceDelay:
				config.get<number>("debounceDelay") || DEFAULT_CONFIG.debounceDelay,
			apiUrl: config.get<string>("apiUrl") || DEFAULT_CONFIG.apiUrl,
			model: config.get<string>("model") || DEFAULT_CONFIG.model,
			email: config.get<string>("email") || DEFAULT_CONFIG.email,
		};
	}

	private async makeRequest(prompt: string): Promise<AssistantResponse> {
		if (!this.config.apiKey) {
			this.logError(
				new Error(
					"API Key not configured. Please set personalCoder.apiKey in settings.",
				),
				"makeRequest",
			);
		}

		try {
			const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
					"X-User-Email": this.config.email,
				},
				body: JSON.stringify({
					model: this.config.model,
					messages: [{ role: "user", content: prompt }],
					shouldSave: false,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logError(
					new Error(errorData.error || "API request failed"),
					"makeRequest",
				);
			}

			return await response.json();
		} catch (error) {
			this.logError(
				new Error(
					error instanceof Error ? error.message : "Unknown error occurred",
				),
				"makeRequest",
			);
			throw error;
		}
	}

	private getFunctionContext(
		document: vscode.TextDocument,
		position: vscode.Position,
	): string {
		const text = document.getText();
		const offset = document.offsetAt(position);

		const functionRegex =
			/(?:(?:async\s+)?(?:function\s+\w+|\w+\s*=\s*(?:async\s+)?function|\w+\s*=\s*\(.*?\)\s*=>|\w+\s*:\s*(?:async\s+)?function|\w+\s*=\s*class|\bclass\s+\w+)\s*(?:<.*?>)?\s*\(.*?\)\s*{[\s\S]*?})|(?:(?:const|let|var)\s+\w+\s*=\s*(?:\(.*?\)\s*=>\s*)?{[\s\S]*?})/g;

		let currentFunction = "";
		let match: RegExpExecArray | null = functionRegex.exec(text);

		while (match !== null) {
			const start = match.index;
			const end = start + match[0].length;

			if (start <= offset && offset <= end) {
				currentFunction = match[0];
				break;
			}
			match = functionRegex.exec(text);
		}

		return (
			currentFunction ||
			text.slice(Math.max(0, offset - 500), Math.min(text.length, offset + 500))
		);
	}

	private debouncedProvideCompletions = debounce(
		async (
			document: vscode.TextDocument,
			position: vscode.Position,
			token: vscode.CancellationToken,
		) => {
			const triggers: TriggerPatterns = {
				complete: /\/\/\s*ai\s*$/,
				docs: /\/\/\s*ai-docs\s*$/,
				fix: /\/\/\s*ai-fix\s*$/,
				type: /\/\/\s*ai-type\s*$/,
			};

			const linePrefix = document
				.lineAt(position)
				.text.substr(0, position.character);

			const promptType = Object.entries(triggers).find(([_, pattern]) =>
				pattern.test(linePrefix),
			)?.[0];

			if (!promptType || token.isCancellationRequested) {
				return undefined;
			}

			try {
				const context = await this.getDocumentContext(document, position);
				const suggestion = await this.getAISuggestion(promptType, context);

				if (suggestion) {
					return [this.createCompletionItem(suggestion, promptType)];
				}
			} catch (error) {
				this.logError(
					new Error(
						error instanceof Error ? error.message : "Unknown error occurred",
					),
					"debouncedProvideCompletions",
				);
			}

			return undefined;
		},
		DEFAULT_CONFIG.debounceDelay,
	);

	private async getDocumentContext(
		document: vscode.TextDocument,
		position: vscode.Position,
	) {
		const visibleRange = document.validateRange(
			new vscode.Range(
				Math.max(0, position.line - this.config.maxContextLines),
				0,
				Math.min(
					document.lineCount - 1,
					position.line + this.config.maxContextLines,
				),
				document.lineAt(
					Math.min(
						document.lineCount - 1,
						position.line + this.config.maxContextLines,
					),
				).text.length,
			),
		);

		const imports =
			document
				.getText()
				.match(/import.*?;/g)
				?.join("\n") || "";
		const visibleText = document.getText(visibleRange);
		const functionContext = this.getFunctionContext(document, position);

		return { imports, visibleText, functionContext };
	}

	private createCompletionItem(
		suggestion: string,
		promptType: string,
	): vscode.CompletionItem {
		const item = new vscode.CompletionItem(suggestion);
		item.insertText = suggestion;
		item.detail = "AI Suggestion";
		item.documentation = new vscode.MarkdownString(
			`**AI Generated Code**\n\n${suggestion}\n\n---\n*Trigger: ${promptType}*`,
		);
		item.kind = vscode.CompletionItemKind.Snippet;
		return item;
	}

	private async getAISuggestion(
		promptType: string,
		context: { imports: string; visibleText: string; functionContext: string },
	): Promise<string | undefined> {
		const promptTemplates = {
			complete: `Complete the code below. Use the context to provide a relevant completion.
        Imports: ${context.imports}
        
        Function context: ${context.functionContext}
        
        Visible code: ${context.visibleText}`,
			docs: `Generate documentation for the current function/class.
        Context: ${context.functionContext}`,
			fix: `Fix potential issues in this code:
        ${context.functionContext}`,
			type: `Suggest TypeScript types for this code:
        ${context.functionContext}`,
		};

		if (promptType in promptTemplates) {
			const data = await this.makeRequest(
				promptTemplates[promptType as keyof typeof promptTemplates],
			);
			return data.choices?.[0]?.message?.content;
		}
		return undefined;
	}

	private registerCommands() {
		const commands = {
			'vscode-assistant.explainCode': this.explainCode.bind(this),
			'vscode-assistant.reviewCode': this.reviewCode.bind(this),
			'vscode-assistant.generateTests': this.generateTests.bind(this),
			'vscode-assistant.showCommands': this.showCommands.bind(this),
			'vscode-assistant.generateSnippet': async () => {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showInformationMessage('No active text editor!');
					return;
				}

				const selection = editor.selection;
				const text = editor.document.getText(selection);

				if (!text) {
					vscode.window.showInformationMessage('Please select code to convert to snippet');
					return;
				}

				await this.generateSnippet(text, editor.document.languageId, new vscode.CancellationTokenSource().token);
			},
			'vscode-assistant.configureKey': async () => {
				const key = await vscode.window.showInputBox({
					prompt: 'Enter your Personal Coder API Key',
					password: true
				});
				
				if (key) {
					await vscode.workspace.getConfiguration('personalCoder')
						.update('apiKey', key, true);
					vscode.window.showInformationMessage('API Key updated successfully');
				}
			}
		};

		for (const [command, handler] of Object.entries(commands)) {
			this.context.subscriptions.push(
				vscode.commands.registerCommand(command, async () => {
					const editor = vscode.window.activeTextEditor;
					if (!editor && command !== 'vscode-assistant.showCommands' && command !== 'vscode-assistant.configureKey') {
						vscode.window.showInformationMessage('No active text editor!');
						return;
					}

					if (typeof handler === 'function') {
						if (command === 'vscode-assistant.showCommands' || command === 'vscode-assistant.configureKey') {
							await (handler as () => Promise<void>)();
							return;
						}

						if (editor) {
							const selection = editor.selection;
							const text = editor.document.getText(selection);

							if (!text) {
								vscode.window.showInformationMessage('Please select some code first');
								return;
							}

							await vscode.window.withProgress(
								{
									location: vscode.ProgressLocation.Notification,
									title: `Processing ${command}...`,
									cancellable: true
								},
								async (progress, token) => {
									try {
										await handler(text, editor.document.languageId, token);
									} catch (error) {
										const message = error instanceof Error ? error.message : 'Unknown error occurred';
										this.logError(new Error(message), 'registerCommands');
									}
								}
							);
						}
					}
				})
			);
		}
	}

	private async showResponse(response: string, options: {
		title: string;
		language?: string;
		preview?: boolean;
	}) {
		const previewLength = 200;
		const preview = response.slice(0, previewLength) + (response.length > previewLength ? '...' : '');
		
		const actions = ['Open in Editor', 'Show Full in Notification'];
		const choice = await vscode.window.showInformationMessage(
			`${options.title}\n\n${preview}`,
			...actions
		);

		switch (choice) {
			case 'Open in Editor': {
				const doc = await vscode.workspace.openTextDocument({
					content: response,
					language: options.language || 'markdown'
				});
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
				break;
      }
			case 'Show Full in Notification':
				await vscode.window.showInformationMessage(response, { modal: true });
				break;
		}
	}

	private async explainCode(
		text: string,
		_: string,
		token: vscode.CancellationToken,
	) {
		if (token.isCancellationRequested) {
			return;
		}

		const data = await this.makeRequest(`Explain this code: ${text}`);
		const explanation = data.choices?.[0]?.message?.content;

		if (explanation) {
			await this.showResponse(explanation, {
				title: 'Code Explanation',
				language: 'markdown'
			});
		}
	}

	private async reviewCode(
		text: string,
		_: string,
		token: vscode.CancellationToken,
	) {
		if (token.isCancellationRequested) {
			return;
		}

		const data = await this.makeRequest(
			`Review this code and suggest improvements, focusing on: 
      1. Performance
      2. Security
      3. Best practices
      4. Potential bugs
      Code: ${text}`,
		);

		const review = data.choices?.[0]?.message?.content;
		if (review) {
			const doc = await vscode.workspace.openTextDocument({
				content: review,
				language: "markdown",
			});
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Beside,
			});
		}
	}

	private async generateTests(
		text: string,
		language: string,
		token: vscode.CancellationToken,
	) {
		if (token.isCancellationRequested) {
			return;
		}

		const data = await this.makeRequest(
			`Generate unit tests for this ${language} code. Include test cases for edge cases and error scenarios: ${text}`,
		);

		const tests = data.choices?.[0]?.message?.content;
		if (tests) {
			const doc = await vscode.workspace.openTextDocument({
				content: tests,
				language,
			});
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Beside,
			});
		}
	}
	private async generateSnippet(
		text: string,
		language: string,
		token: vscode.CancellationToken,
	) {
		if (token.isCancellationRequested) {
			return;
		}

		const config = vscode.workspace.getConfiguration("personalCoder");
		const existingSnippets = config.get<string[]>("customSnippets") || [];

		const data = await this.makeRequest(
			`Create a reusable code snippet from this ${language} code. 
         Make it generic and add parameter placeholders: ${text}`,
		);

		const snippet = data.choices?.[0]?.message?.content;
		if (snippet) {
			await config.update(
				"customSnippets",
				[...existingSnippets, snippet],
				true,
			);
		}
	}

	private async showCommands() {
		const commands = [
			{ label: "Explain Code", command: "vscode-assistant.explainCode" },
			{ label: "Review Code", command: "vscode-assistant.reviewCode" },
			{ label: "Generate Tests", command: "vscode-assistant.generateTests" },
			{ label: "Configure API Key", command: "vscode-assistant.configureKey" },
			{ label: "Generate Snippet", command: "vscode-assistant.generateSnippet" },
		];

		const selected = await vscode.window.showQuickPick(commands, {
			placeHolder: "Select AI Assistant Action",
		});

		if (selected) {
			vscode.commands.executeCommand(selected.command);
		}
	}

	private registerCodeActions() {
		this.context.subscriptions.push(
			vscode.languages.registerCodeActionsProvider(
				{ scheme: "file" },
				{
					provideCodeActions: (document, range) => {
						const actions = [];
						const selectedText = document.getText(range);

						if (selectedText) {
							actions.push({
								title: "💡 Explain Code",
								command: "vscode-assistant.explainCode",
								arguments: [selectedText],
							});
							actions.push({
								title: "🔍 Review Code",
								command: "vscode-assistant.reviewCode",
								arguments: [selectedText],
							});
							actions.push({
								title: "🧪 Generate Tests",
								command: "vscode-assistant.generateTests",
								arguments: [selectedText],
							});
							actions.push({
								title: "♻️ Generate Snippet",
								command: "vscode-assistant.generateSnippet",
								arguments: [selectedText],
							});
						}

						return actions;
					},
				},
			),
		);
	}

	private initializeStatusBar() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
		);
		this.statusBarItem.text = "$(sparkle) AI";
		this.statusBarItem.tooltip = "Personal Coder Ready";
		this.statusBarItem.command = "vscode-assistant.showCommands";
		this.statusBarItem.show();
		this.context.subscriptions.push(this.statusBarItem);
	}

	private initialize() {
		// Register the completion provider
		this.context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(
				{ scheme: "file" },
				{
					provideCompletionItems: this.debouncedProvideCompletions,
				},
				" ",
				"/",
			),
		);

		// Register commands
		this.registerCommands();
		this.registerCodeActions();

		// Watch for configuration changes
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("personalCoder")) {
				this.config = this.loadConfiguration();
			}
		});

		this.initializeStatusBar();
	}
}

export function activate(context: vscode.ExtensionContext) {
	new AssistantExtension(context);
}

export function deactivate() {}
