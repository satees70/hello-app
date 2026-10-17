// Shared settings for the routes that read uploaded documents with Claude.
// ----------------------------------------------------------------------------
// Sonnet is much faster (and cheaper) than Opus for these extractions, which
// avoids documents getting stuck on "Processing" when the model runs long.
// Switch to 'claude-opus-4-8' here if you ever need maximum accuracy on a messy doc.
export const EXTRACTION_MODEL = 'claude-sonnet-4-6'

// Shown when the model hit its output limit before finishing (stop_reason
// 'max_tokens') — the tool call would be cut short, so the lines can't be trusted.
export const TOO_LONG_MSG = 'The document is too long to read in one go. Please split it into smaller PDFs and upload them separately.'
