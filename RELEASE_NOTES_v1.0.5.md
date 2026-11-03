# JEUS Lens v1.0.5 — Full-Result Global Log Sorting (Go and Rust)

## Release highlights
- **Global rather than page-only sorting**: When a column header is selected, sorting is performed across all events belonging to the current dataset or filter **before** creating 100-row pages. Moving between pages uses the same sort ordering.
- **Go and Rust parity**: Both engines implement the same `/api/sort` severity sort contract, `/api/filter-indices` filtered index streaming, and optional reverse `/api/page` traversal. The existing 24-byte event descriptors and 8-byte filtered event IDs are preserved.
- **High-throughput severity sorting**: Stable, 3-bucket sequential disk sorting in **O(n)** time for ERROR/WARN/INFO, with bounded in-process memory. Cached 8-byte result indices are paginated; direction changes are read backwards without another full sort.
- **Original line ordering**: Line ascending/descending is an indexed traversal, without sorting source text.
- **Text-derived columns**: Time, message and code/thread are extracted in the browser-owned File from bounded-size slices by the dedicated `web/global-sort-worker.js`, sorted outside the UI thread with a cached `Intl.Collator`. Only 100 selected rows are materialized for a page.
- **Filtered results**: The global sort respects active severity/SQL/issue filters and retained full-text search results. Dedicated tests exercise >100 events across multiple pages, sorted pagination, reverse ordering and Go/Rust API parity.
- **Earlier features preserved**: v1.0.4 live local file monitoring, separate Connect/SSH-SFTP workspace, immutable source file handling, strict host-key pinning, and v6.4 diagnostic evidence extraction (MyBatis, Oracle, Java exception, SQLSTATE).

## Performance and resource boundaries
- Severity sorting is **O(n)**; sorting arbitrary text keys is **O(n log n)** in the browser, plus the cost of reading the original selected log slices. No unverified performance percentage is claimed.
- The existing full-text search returns at most **100,000 matching event IDs**. Sorting a search respects that existing cap. Metadata-only filters and the default all-events view are not constrained by this search cap.
- Large numbers of unique long text keys may require substantial browser memory. Inability to complete a global text sort safely returns to unsorted/original line navigation with an error message.
- The **remote Connect** explorer continues to sort only the bounded fetched recent window; this release does not read or sort a full remote log on the server.
- The local live append viewer remains a separate recent-events view from the immutable historical index. Existing browser support limits still apply.

## Verification and artifacts
- Go unit tests, `go vet`, `go test -race`, Chromium UI smoke and native Windows x64 build.
- Rust unit/clippy, real localhost SFTP integration, Go/Rust parity (including complete sorted results), Windows x64 native execution, and performance comparison.
- Official publishing requires successful Go and Rust main-branch CI for the **same commit**, a matching GitHub tag, checksummed Go/Rust Windows x64 EXE and ZIP assets, re-download SHA-256 verification, and preservation of previous releases.
- Neither binary is code-signed. Product-specific proprietary DB security gateway authentication was not added in this release.
