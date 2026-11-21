// Standalone lazy chunk: re-exports the xlsx library so the heavy parser
// (~500 KB) evaluates only when a spreadsheet is actually decoded, via
// `liteide.loadChunk('xlsx')`. Keep imports disjoint from the main entry
// (externals only) so the CJS lib build emits no shared chunk.
import XLSX from 'xlsx'

export default XLSX
