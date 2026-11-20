SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- The worker keeps the immutable execution plan and its receipts. Readers need
-- only display totals and one already ordered group of up to 100 paths.
CREATE TABLE minecraft_modpack_reviews (
  operation_id uuid NOT NULL REFERENCES minecraft_modpack_operations(id) ON DELETE CASCADE,
  digest text NOT NULL,
  summary jsonb NOT NULL,
  PRIMARY KEY (operation_id, digest)
);

CREATE TABLE minecraft_modpack_review_pages (
  operation_id uuid NOT NULL,
  digest text NOT NULL,
  category text NOT NULL,
  page integer NOT NULL,
  paths jsonb NOT NULL,
  PRIMARY KEY (operation_id, digest, category, page),
  FOREIGN KEY (operation_id, digest) REFERENCES minecraft_modpack_reviews ON DELETE CASCADE
);

CREATE FUNCTION minecraft_project_modpack_review(operation uuid, revision text)
RETURNS void LANGUAGE sql AS $$
  WITH op AS (
    SELECT id,plan_digest,prepared,plan FROM minecraft_modpack_operations
    WHERE id=operation AND plan_digest=revision AND jsonb_typeof(plan)='object'
      AND NOT EXISTS (SELECT 1 FROM minecraft_modpack_reviews
                      WHERE operation_id=operation AND digest=revision)
  ), writes AS (
    SELECT w.path,w.size FROM op,jsonb_to_recordset(op.plan->'write') AS w(path text,size bigint)
  ), existing AS (
    SELECT path,entry->>'kind' AS kind FROM op,jsonb_to_recordset(op.plan->'expected') AS e(path text,entry jsonb)
    WHERE entry->>'kind' IS NOT NULL
  ), removals AS (
    SELECT path FROM op,jsonb_array_elements_text(op.plan->'remove') r(path)
  ), changes AS (
    SELECT w.path, CASE WHEN e.path IS NULL THEN 'added' ELSE 'replaced' END AS category
    FROM writes w LEFT JOIN existing e USING(path)
    UNION ALL
    SELECT r.path || CASE WHEN e.kind='directory' THEN '/' ELSE '' END, 'removed'
    FROM removals r LEFT JOIN existing e USING(path)
    WHERE NOT EXISTS(SELECT 1 FROM writes w WHERE w.path=r.path)
    UNION ALL
    SELECT path, 'preserved' FROM op,jsonb_array_elements_text(op.plan->'preserve') p(path)
    UNION ALL
    SELECT path, 'deletions' FROM removals
  ), numbered AS (
    SELECT category,path,((row_number() OVER (PARTITION BY category ORDER BY path COLLATE "C")-1)/100)::integer AS page
    FROM changes
  ), partitioned AS (
    SELECT category,page,count(*) AS n,jsonb_agg(path ORDER BY path COLLATE "C") AS paths
    FROM numbered GROUP BY category,page
  ), totals AS (
    SELECT category,sum(n) AS n FROM partitioned WHERE category <> 'deletions' GROUP BY category
  ), published AS (
    INSERT INTO minecraft_modpack_reviews(operation_id,digest,summary)
    SELECT id,plan_digest,jsonb_build_object(
      'pack', prepared->'pack', 'target', prepared->'target',
      'runtimeSupported', coalesce(plan->'runtime' <> 'null'::jsonb
        AND NOT (plan->'blockers' @> '[{"reason":"runtime"}]'::jsonb OR
                 plan->'blockers' @> '[{"reason":"loader-version"}]'::jsonb),false),
      'changes', jsonb_build_object('write', jsonb_array_length(plan->'write'),
        'remove', jsonb_array_length(plan->'remove'), 'preserve', jsonb_array_length(plan->'preserve'),
        'bytes', coalesce((SELECT sum(size) FROM writes),0)),
      'counts', jsonb_build_object('added',0,'replaced',0,'removed',0,'preserved',0) ||
                coalesce((SELECT jsonb_object_agg(category,n) FROM totals),'{}'::jsonb)
    ) FROM op
    ON CONFLICT (operation_id,digest) DO NOTHING RETURNING operation_id,digest
  )
  INSERT INTO minecraft_modpack_review_pages(operation_id,digest,category,page,paths)
  SELECT operation_id,digest,category,page,paths FROM published CROSS JOIN partitioned;
$$;

CREATE FUNCTION minecraft_publish_modpack_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_digest IS NOT NULL THEN
    IF TG_OP='UPDATE' AND OLD.plan_digest=NEW.plan_digest THEN
      DELETE FROM minecraft_modpack_reviews WHERE operation_id=NEW.id AND digest=NEW.plan_digest;
    END IF;
    PERFORM minecraft_project_modpack_review(NEW.id, NEW.plan_digest);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER minecraft_modpack_publish_review AFTER INSERT OR UPDATE OF prepared,plan,plan_digest
ON minecraft_modpack_operations FOR EACH ROW EXECUTE FUNCTION minecraft_publish_modpack_review();

-- Wake API waiters in the same commit that releases/replaces the lease.
CREATE FUNCTION minecraft_notify_world_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nh_worlds_' || md5(current_database() || ':' || current_schema()), NEW.server_id::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER minecraft_world_scan_completion AFTER UPDATE ON minecraft_world_indexes
FOR EACH ROW WHEN (OLD.lease_id IS NOT NULL AND OLD.lease_id IS DISTINCT FROM NEW.lease_id)
EXECUTE FUNCTION minecraft_notify_world_scan();
