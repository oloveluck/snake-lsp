/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Location,
	ReferenceParams,
	WorkspaceEdit,
	TextEdit,
} from 'vscode-languageserver/node';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { helpers } = require("./testing.bc.js");

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			definitionProvider: true,
			referencesProvider: true,
			renameProvider : true,
			completionProvider: {
				resolveProvider: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

function getTokenAtPosition(docString : string, line : number, col : number) : string | undefined {
	const lines = docString.split('\n');
	if (lines.length <= line) {
		return undefined;
	}
	const tokens = lines[line].substring(col).split(/[\s(=]/);
	return tokens.length ? tokens[0] : undefined; 
}

connection.onDefinition((params) => {
	const { position, textDocument } = params;
	const { uri }  = textDocument;
	const docString = documents.get(uri)?.getText();
	const token = getTokenAtPosition(docString || '', position.line, position.character);
	if (docString && token) {
		try {
			const result : number[][] = helpers.getDefinition(position.line + 1, position.character, position.line + 1, position.character + token.length, docString);
			if (result.length !== 2 || result[1].length !== 5) {
				return undefined;
			}
			const [_, startLine, startChar, endLine, endChar] = result[1];
			const location : Location = { uri, range : { start : { line: startLine - 1, character: startChar }, end : { line : endLine - 1 , character: endChar} } }; 
			return location;
		} catch (err) {
			connection.console.log(`Parsing error: ${err}`);
		}
		}
	return undefined;
});

function getReferenceLocations(params : ReferenceParams, includeSelf : boolean) {
	const locations : Location[] = [];
	const { position, textDocument } = params;
	const { uri }  = textDocument;
	const docString = documents.get(uri)?.getText();
	const token = getTokenAtPosition(docString || '', position.line, position.character);
	if (docString && token) {
		try {
			const uses : number[][] = helpers.viewAllUses(position.line + 1, position.character, position.line + 1, position.character + token.length, docString);
			if (includeSelf) uses.push([0, position.line + 1, position.character, position.line + 1, position.character + token.length]);
			uses.forEach(use => {
				if (use.length === 5) {
					const [_, startLine, startChar, endLine, endChar] = use;
					const location : Location = { uri, range : { start : { line: startLine - 1, character: startChar}, end : { line : endLine - 1, character: endChar} } }; 
					locations.push(location);
				}
			});
		} catch(err) {
			connection.console.log(`Parsing error: ${err}`);
		}
	}
	return locations;
}

connection.onRenameRequest((params) => {
	const locations = getReferenceLocations({ ... params, context: {includeDeclaration : true}}, true);
	const edits = locations.reduce((acc : TextEdit[], loc) => {
		const newEdit = { range : loc.range, newText : params.newName};
		acc.push(newEdit);
		return acc;
	}, []);
	const changes : {[uri: string]: TextEdit[]} = {};
	changes[params.textDocument.uri] = edits;
	return { changes };
});

connection.onReferences((params) => {
	return getReferenceLocations(params, false);
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.snakeLanguageServer || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'snakeLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
	const text = change.document.getText();

	connection.console.log(text);
});

documents.onWillSave(change => {
	console.log(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	console.log({ URI : textDocument.uri} );
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /\b[A-Z]{2,}\b/g;
	let m: RegExpExecArray | null;

	let problems = 0;
	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
		problems++;
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			message: `${m[0]} is all uppercase.`,
			source: 'ex'
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Spelling matters'
				},
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Particularly for names'
				}
			];
		}
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return [
			{
				label: 'TypeScript',
				kind: CompletionItemKind.Text,
				data: 1
			},
			{
				label: 'JavaScript',
				kind: CompletionItemKind.Text,
				data: 2
			}
		];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
