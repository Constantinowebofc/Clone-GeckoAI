---
name: supabase-postgres-best-practices
description: "Postgres best practices maintained by Supabase, for Postgres running anywhere. Load this skill BEFORE writing or changing anything that lives in a Postgres database: creating or altering tables and columns (including choosing column types), schema design, migrations and declarative schema files, RLS policies and the tests that verify them, indexes, triggers, database functions, queues and scheduled jobs (pg_cron, pgmq), vector/semantic search (pgvector), and restoring dumps (pg_restore) or importing data. Also load it when diagnosing slow queries, high CPU, timeouts, EXPLAIN plans, connection exhaustion, locking, bloat, or rows visible to the wrong user or tenant. This is not just a performance guide — schema, migration, security, and SQL authoring tasks need these rules too, even for a one-column change or a single query."
license: MIT
metadata:
  author: supabase
  version: "1.1.1"
  organization: Supabase
  date: January 2026
  abstract: Comprehensive Postgres performance optimization guide for developers using Supabase and Postgres. Contains performance rules across 8 categories, prioritized by impact from critical (query performance, connection management) to incremental (advanced features). Each rule includes detailed explanations, incorrect vs. correct SQL examples, query plan analysis, and specific performance metrics to guide automated optimization and code generation.
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: 16 of the rules are included (queries and indexes, schema design, data access, advanced features); connection management, monitoring, locking, partitioning and the security rules were left out, and the "Rule files" index was added from each rule's own title. License: see LICENSE.txt in this folder. -->

# Supabase Postgres Best Practices

Comprehensive performance optimization guide for Postgres, maintained by Supabase. Contains rules across 4 categories, prioritized by impact to guide automated query optimization and schema design.

## When to Apply

Reference these guidelines when:
- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Optimizing for Postgres-specific features

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Query Performance | CRITICAL | `query-` |
| 4 | Schema Design | HIGH | `schema-` |
| 6 | Data Access Patterns | MEDIUM | `data-` |
| 8 | Advanced Features | LOW | `advanced-` |

## How to Use

Read individual rule files for detailed explanations and SQL examples:

```
references/query-missing-indexes.md
references/query-partial-indexes.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect SQL example with explanation
- Correct SQL example with explanation
- Optional EXPLAIN output or metrics
- Additional context and references
- Supabase-specific notes (when applicable)

## Rule files

- `references/query-missing-indexes.md` — Add Indexes on WHERE and JOIN Columns (CRITICAL)
- `references/query-composite-indexes.md` — Create Composite Indexes for Multi-Column Queries (HIGH)
- `references/query-covering-indexes.md` — Use Covering Indexes to Avoid Table Lookups (MEDIUM-HIGH)
- `references/query-index-types.md` — Choose the Right Index Type for Your Data (HIGH)
- `references/query-partial-indexes.md` — Use Partial Indexes for Filtered Queries (HIGH)
- `references/schema-primary-keys.md` — Select Optimal Primary Key Strategy (HIGH)
- `references/schema-data-types.md` — Choose Appropriate Data Types (HIGH)
- `references/schema-constraints.md` — Add Constraints Safely in Migrations (HIGH)
- `references/schema-foreign-key-indexes.md` — Index Foreign Key Columns (HIGH)
- `references/schema-lowercase-identifiers.md` — Use Lowercase Identifiers for Compatibility (MEDIUM)
- `references/data-n-plus-one.md` — Eliminate N+1 Queries with Batch Loading (MEDIUM-HIGH)
- `references/data-pagination.md` — Use Cursor-Based Pagination Instead of OFFSET (MEDIUM-HIGH)
- `references/data-batch-inserts.md` — Batch INSERT Statements for Bulk Data (MEDIUM)
- `references/data-upsert.md` — Use UPSERT for Insert-or-Update Operations (MEDIUM)
- `references/advanced-jsonb-indexing.md` — Index JSONB Columns for Efficient Querying (MEDIUM)
- `references/advanced-full-text-search.md` — Use tsvector for Full-Text Search (MEDIUM)

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
