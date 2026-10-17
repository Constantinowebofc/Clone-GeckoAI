---
title: Optimize RLS Policies for Performance
impact: HIGH
impactDescription: 5-10x faster RLS queries with proper patterns
tags: rls, performance, security, optimization
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: the SECURITY DEFINER helper example was removed (as written, it revokes EXECUTE from the roles whose policies call the function); the rest is unchanged. License: see LICENSE.txt in this folder. -->

## Optimize RLS Policies for Performance

Poorly written RLS policies can cause severe performance issues. Use subqueries and indexes strategically.

**Incorrect (function called for every row):**

```sql
create policy orders_policy on orders
  using (auth.uid() = user_id);  -- auth.uid() called per row!

-- With 1M rows, auth.uid() is called 1M times
```

**Correct (wrap functions in SELECT):**

```sql
create policy orders_policy on orders
  using ((select auth.uid()) = user_id);  -- Called once, cached

-- 100x+ faster on large tables
```

Always add indexes on columns used in RLS policies:

```sql
create index orders_user_id_idx on orders (user_id);
```

Reference: [RLS Performance](https://supabase.com/docs/guides/database/postgres/row-level-security#rls-performance-recommendations)
