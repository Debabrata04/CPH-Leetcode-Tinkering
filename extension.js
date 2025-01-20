const vsEditor = require('vscode');
const httpClient = require('axios');
const fileSystem = require('fs').promises;
const filePath = require('path');
const domParser = require('cheerio');
const { formatArray, splitCases } = require('./src/utils/formatters');
const { runCode, executeSingleTest } = require('./src/utils/codeExec');

// GraphQL query for problem details
const QUERY_PROBLEM_DETAILS = `
query problemDetails($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
        questionId
        title
        content
        exampleTestcases
        sampleTestCase
    }
}`;

function parseTestCases(htmlContent, exampleCases, sampleCase) {
    if (!htmlContent) return { inputs: [], outputs: [] };

    const $ = domParser.load(htmlContent);
    const outputs = [];

    const linesPerExample = sampleCase ? 
        (sampleCase.match(/\n/g) || []).length + 1 : 1;

    const inputs = exampleCases ? 
        splitCases(exampleCases, linesPerExample) : [];

    $('strong.example').each((index, elem) => {
        let outputText = '';
        let currentElem = $(elem);

        while (currentElem.length) {
            if (currentElem.next().length) {
                currentElem = currentElem.next();
            } else if (currentElem.parent().next().length) {
                currentElem = currentElem.parent().next();
            } else {
                break;
            }

            const codeBlock = currentElem.is('pre') ? 
                currentElem : currentElem.find('pre');

            if (codeBlock.length) {
                const textContent = codeBlock.text();
                const outputMatch = textContent.match(/Output:\s*([^]*?)(?=\nExplanation:|$)/);
                if (outputMatch && outputMatch[1]) {
                    outputText = formatArray(outputMatch[1].trim());
                    break;
                }
            }
        }
        outputs.push(outputText || '');
    });

    return {
        inputs: inputs.map(input => 
            input.split('\n')
                .map(line => formatArray(line))
                .join('\n')
        ),
        outputs: outputs.map(output => 
            output.split('\n')
                .map(line => formatArray(line))
                .join('\n')
        )
    };
}

async function storeTestCases(projectRoot, problemId, testCases) {
    const testCasesFolder = filePath.join(projectRoot, '.leetcode', 'cases', problemId);

    try {
        await fileSystem.mkdir(testCasesFolder, { recursive: true });

        for (let i = 0; i < testCases.inputs.length; i++) {
            const inputFile = filePath.join(testCasesFolder, `input_${i + 1}.txt`);
            const formattedInput = Array.isArray(testCases.inputs[i]) ? 
                testCases.inputs[i].join('\n') : 
                testCases.inputs[i];
            await fileSystem.writeFile(inputFile, formattedInput);
        }

        for (let i = 0; i < testCases.outputs.length; i++) {
            const outputFile = filePath.join(testCasesFolder, `output_${i + 1}.txt`);
            await fileSystem.writeFile(outputFile, testCases.outputs[i]);
        }

        return testCasesFolder;
    } catch (err) {
        throw new Error(`Error storing test cases: ${err.message}`);
    }
}

async function retrieveTestCases(slugTitle) {
    try {
        const res = await httpClient.post(
            'https://leetcode.com/graphql',
            {
                query: QUERY_PROBLEM_DETAILS,
                variables: { titleSlug: slugTitle }
            }
        );

        if (res.data.errors) {
            throw new Error(res.data.errors[0].message);
        }

        const problemData = res.data.data.question;
        return {
            id: problemData.questionId,
            content: problemData.content,
            testcases: parseTestCases(
                problemData.content,
                problemData.exampleTestcases,
                problemData.sampleTestCase
            )
        };
    } catch (err) {
        throw new Error(`Error fetching from LeetCode: ${err.message}`);
    }
}

class ProblemViewProvider {
    constructor() {
        this.activeWebview = null;
        this.openFile = null;
        this.openLanguage = null;
    }

    setActiveFile(filePath, language) {
        this.openFile = filePath;
        this.openLanguage = language;
    }

    resolveWebview(webviewPanel) {
        this.activeWebview = webviewPanel.webview;
        const { generateWebviewContent } = require('./src/webview/home');

        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = generateWebviewContent();

        webviewPanel.webview.onDidReceiveMessage(async msg => {
            switch (msg.command) {
                case 'fetch':
                    vsEditor.commands.executeCommand('leetcode-cases.fetch', msg.url);
                    break;
                case 'runSingle':
                    try {
                        if (!this.openFile || !this.openLanguage) {
                            throw new Error('No file selected');
                        }

                        const result = await executeSingleTest(
                            this.openFile,
                            this.openLanguage,
                            msg.testCase.input,
                            msg.testCase.expectedOutput
                        );

                        if (!result.success) {
                            throw new Error(result.error);
                        }

                        webviewPanel.webview.postMessage({
                            command: 'testCaseResult',
                            index: msg.testCase.index,
                            passed: result.passed,
                            actualOutput: result.actualOutput
                        });
                    } catch (err) {
                        webviewPanel.webview.postMessage({
                            command: 'testCaseResult',
                            index: msg.testCase.index,
                            passed: false,
                            actualOutput: err.message
                        });
                    }
                    break;
            }
        });
    }
}

const extractSlugFromUrl = (url) => {
    try {
        const sanitizedUrl = url.replace(/\/$/, '');
        const matchResult = sanitizedUrl.match(/\/problems\/([^/]+)/); 
        if (!matchResult || !matchResult[1]) throw new Error('Invalid URL');
        return matchResult[1];
    } catch (err) {
        throw new Error('Malformed URL format');
    }
};

function activatePlugin(context) {
    const viewProvider = new ProblemViewProvider();

    context.subscriptions.push(
        vsEditor.window.registerWebviewViewProvider(
            'leetcode-cases.webview',
            viewProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    vsEditor.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const doc = editor.document;
            const lang = doc.languageId;
            viewProvider.setActiveFile(doc.uri.fsPath, lang);
        }
    });

    if (vsEditor.window.activeTextEditor) {
        const doc = vsEditor.window.activeTextEditor.document;
        const lang = doc.languageId;
        viewProvider.setActiveFile(doc.uri.fsPath, lang);
    }

    let fetchCmd = vsEditor.commands.registerCommand('leetcode-cases.fetch', async (problemUrl) => {
        try {
            const rootDir = vsEditor.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootDir) {
                throw new Error('No workspace detected');
            }

            if (!problemUrl) {
                problemUrl = await vsEditor.window.showInputBox({
                    prompt: 'Enter LeetCode problem URL',
                    placeHolder: 'https://leetcode.com/problems/...'
                });
            }

            if (!problemUrl) {
                return;
            }

            const slugTitle = extractSlugFromUrl(problemUrl);

            await vsEditor.window.withProgress({
                location: vsEditor.ProgressLocation.Notification,
                title: "Fetching test cases...",
                cancellable: false
            }, async () => {
                const { id, content, testcases } = await retrieveTestCases(slugTitle);

                const casePath = await storeTestCases(rootDir, id, testcases);

                if (viewProvider.activeWebview) {
                    viewProvider.activeWebview.postMessage({
                        command: 'displayTestCases',
                        testCases: testcases,
                        problemContent: content
                    });
                }

                await context.workspaceState.update('currentProblemId', id);
                vsEditor.window.showInformationMessage(
                    `Test cases saved at ${casePath}`
                );
            });

        } catch (err) {
            vsEditor.window.showErrorMessage(`Error: ${err.message}`);
        }
    });

    let runCmd = vsEditor.commands.registerCommand('leetcode-cases.run', async () => {
        try {
            const activeEditor = vsEditor.window.activeTextEditor;
            if (!activeEditor) {
                throw new Error('No editor active');
            }

            const filePath = activeEditor.document.uri.fsPath;
            const fileExt = filePath.extname(filePath);
            const language = fileExt.substring(1);

            await activeEditor.document.save();

            const problemId = context.workspaceState.get('currentProblemId');
            if (!problemId) {
                throw new Error('No problem loaded. Fetch test cases first.');
            }

            await vsEditor.window.withProgress({
                location: vsEditor.ProgressLocation.Notification,
                title: "Running test cases...",
                cancellable: false
            }, async () => {
                const executionResult = await runCode(filePath, language, problemId);

                if (!executionResult.success) {
                    throw new Error(executionResult.error);
                }

                if (viewProvider.activeWebview) {
                    viewProvider.activeWebview.postMessage({
                        command: 'testRunResults',
                        results: executionResult.results,
                        summary: executionResult.summary
                    });
                }
            });

        } catch (err) {
            vsEditor.window.showErrorMessage(`Error: ${err.message}`);
        }
    });

    context.subscriptions.push(fetchCmd, runCmd);
    console.log('Extension: Commands initialized');

    console.log('LeetCode Helper Extension: Fully activated');
}

function deactivatePlugin() {}

module.exports = {
    activate: activatePlugin,
    deactivate: deactivatePlugin
};
