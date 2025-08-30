import path from "path"
import { Task } from "../task/Task"

const SIZE_LIMIT_AS_CONTEXT_WINDOW_FRACTION = 0.8

async function allowVeryLargeReads(task: Task) {
	return (await task.providerRef.deref()?.getState())?.allowVeryLargeReads ?? false
}

async function getTokenEstimate(task: Task, outputText: string) {
	return await task.api.countTokens([{ type: "text", text: outputText }])
}

function getTokenLimit(task: Task) {
	return SIZE_LIMIT_AS_CONTEXT_WINDOW_FRACTION * task.api.getModel().info.contextWindow
}

export async function summarizeSuccessfulMcpOutputWhenTooLong(task: Task, outputText: string) {
	if (await allowVeryLargeReads(task)) {
		return outputText
	}
	const tokenLimit = getTokenLimit(task)
	const tokenEstimate = await getTokenEstimate(task, outputText)
	if (tokenEstimate < tokenLimit) {
		return outputText
	}
	return (
		`The MCP tool executed successfully, but the output is unavailable, ` +
		`because it is too long (${tokenEstimate} estimated tokens, limit is ${tokenLimit} tokens). ` +
		`If you need the output, find an alternative way to get it in manageable chunks.`
	)
}

export async function blockFileReadWhenTooLarge(task: Task, relPath: string, content: string) {
	if (await allowVeryLargeReads(task)) {
		return undefined
	}

	const state = await task.providerRef.deref()?.getState()
	const maxFileReadTokenLimit = state?.maxFileReadTokenLimit

	// Use custom token limit if set, otherwise fall back to context window based limit
	const tokenLimit =
		maxFileReadTokenLimit !== undefined && maxFileReadTokenLimit > 0 ? maxFileReadTokenLimit : getTokenLimit(task)

	const tokenEstimate = await getTokenEstimate(task, content)
	if (tokenEstimate < tokenLimit) {
		return undefined
	}

	const fullPath = path.resolve(task.cwd, relPath)
	const grepSedSuggestions = await provideGrepSedCommandsForLargeFile(
		task,
		relPath,
		fullPath,
		tokenEstimate,
		tokenLimit,
	)

	return {
		status: "blocked" as const,
		error: "File too large - use grep/sed for partial reading",
		xmlContent: `<file><path>${relPath}</path><error>${grepSedSuggestions}</error></file>`,
	}
}

/**
 * Provides grep/sed commands for the LLM to use for partial file reading
 * The LLM can provide search patterns to find relevant content in large files
 */
export async function provideGrepSedCommandsForLargeFile(
	task: Task,
	relPath: string,
	fullPath: string,
	tokenEstimate: number,
	tokenLimit: number,
): Promise<string> {
	try {
		const fs = await import("fs/promises")
		const { exec } = await import("child_process")
		const { promisify } = await import("util")
		const execAsync = promisify(exec)

		// Get basic file info
		const extension = relPath.split(".").pop()?.toLowerCase() || ""
		const fileSize = (await fs.stat(fullPath)).size
		const fileSizeKB = Math.round(fileSize / 1024)

		// Get first few lines to help LLM understand the file structure
		const firstLines = await execAsync(`head -20 "${fullPath}"`)
		const firstLinesContent = firstLines.stdout.slice(0, 500) // Limit preview size

		// Get file type information
		let fileTypeInfo = ""
		try {
			const { stdout: fileOutput } = await execAsync(`file -b "${fullPath}"`)
			fileTypeInfo = fileOutput.trim()
		} catch (error) {
			fileTypeInfo = "Unknown file type"
		}

		const suggestion = `
File "${relPath}" is too large for full read (${tokenEstimate} tokens, limit: ${tokenLimit} tokens).
File size: ${fileSizeKB} KB, Type: ${fileTypeInfo}

Instead of reading the entire file, you can use grep/sed commands to search for specific patterns:

Available grep/sed commands for partial reading:
- grep -n "pattern" "${fullPath}" - Search for exact pattern with line numbers
- grep -n -i "pattern" "${fullPath}" - Case-insensitive search
- grep -n -E "regex_pattern" "${fullPath}" - Extended regex search
- sed -n '1,50p' "${fullPath}" - Extract lines 1-50
- sed -n '/pattern1/,/pattern2/p' "${fullPath}" - Extract between patterns
- head -n 100 "${fullPath}" - Get first 100 lines
- tail -n 100 "${fullPath}" - Get last 100 lines
- wc -l "${fullPath}" - Count total lines

File preview (first 20 lines):
${firstLinesContent}

Suggestions for search patterns based on file type:
- For code files: function names, class names, imports, specific variables
- For config files: key names, section headers, specific values
- For data files: specific field names, patterns in the data
- For text files: section headers, specific phrases

Example usage in your response:
<grep_search>
<pattern>function_name|class_name</pattern>
<file>${relPath}</file>
</grep_search>

Or use sed to extract specific ranges:
<sed_extract>
<range>1-50</range>
<file>${relPath}</file>
</sed_extract>

You can also combine multiple searches to get different parts of the file.
`

		return suggestion
	} catch (error) {
		console.error(`Failed to provide grep/sed suggestions for ${relPath}:`, error)
		return `
File "${relPath}" is too large for full read (${tokenEstimate} tokens, limit: ${tokenLimit} tokens).

Please use grep or sed commands to search for specific content instead of reading the entire file.

Example patterns to search for:
- Function/class names
- Import statements
- Configuration keys
- Specific data patterns

Use commands like:
- grep -n "pattern" "${fullPath}"
- sed -n '1,50p' "${fullPath}"
- head/tail commands for beginning/end of file
`
	}
}
