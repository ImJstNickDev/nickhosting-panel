ALTER TABLE minecraft_world_indexes ADD COLUMN last_file_change_at timestamptz;

-- Deltas only transform rows already present in a proven observation. For an
-- acknowledged directory rename use the source's metadata once, also when an
-- earlier snapshot still had a stale row at the destination.
CREATE FUNCTION minecraft_world_apply_moves(worlds jsonb, moves jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
  WITH projected AS (
    SELECT position, change.value AS move,
      CASE WHEN change.value IS NULL THEN original
           WHEN change.value ? 'target' THEN jsonb_set(original,'{name}',change.value->'target')
      END AS entry
    FROM jsonb_array_elements(worlds) WITH ORDINALITY AS inventory(original,position)
    LEFT JOIN jsonb_array_elements(moves) AS change(value)
      ON change.value->>'name'=original->>'name'
  ), unique_names AS (
    SELECT DISTINCT ON (entry->>'name') entry, position FROM projected WHERE entry IS NOT NULL
    ORDER BY entry->>'name', (move IS NOT NULL) DESC, position
  )
  SELECT coalesce(jsonb_agg(entry ORDER BY position),'[]'::jsonb) FROM unique_names
$$;

-- Only receipts from acknowledged mutations or ambiguous partial writes wake the reader.
-- SFTPGo redelivery uses ON CONFLICT DO NOTHING, so the AFTER INSERT only fires once.
CREATE FUNCTION minecraft_world_file_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  server uuid := (NEW.metadata->>'serverId')::uuid;
  moves jsonb := NEW.metadata->'worldMoves';
  occurred timestamptz := CASE WHEN NEW.action LIKE 'server.sftp.file.%'
    THEN least(NEW.created_at,clock_timestamp()) ELSE clock_timestamp() END;
BEGIN
  PERFORM dirty_minecraft_world_index(server);
  -- SFTP delivery may be delayed or reordered. An older move must not overwrite
  -- a newer projection or scan. A partial Fileman batch only queues a fresh scan.
  UPDATE minecraft_world_indexes SET
    snapshot = CASE WHEN snapshot IS NOT NULL
        AND NEW.action <> 'server.files.incomplete'
        AND jsonb_typeof(moves)='array' AND moves <> '[]'::jsonb
        AND occurred > greatest(observed_at,last_file_change_at,'-infinity'::timestamptz)
        AND local_binding=minecraft_world_local_binding(server)
      THEN jsonb_set(snapshot,'{worlds}',minecraft_world_apply_moves(snapshot->'worlds',moves))
      ELSE snapshot END,
    last_file_change_at=greatest(last_file_change_at,occurred)
    WHERE server_id=server;
  RETURN NEW;
END;
$$;
CREATE TRIGGER minecraft_world_file_receipt AFTER INSERT ON audit_events
FOR EACH ROW WHEN (
  NEW.metadata @> '{"worldIndexChanged":true}' AND (
    NEW.action IN ('server.files.completed', 'server.files.uploaded') OR
    (NEW.action = 'server.files.incomplete' AND NEW.metadata->>'outcome' IN ('partial','uncertain')) OR
    (NEW.action LIKE 'server.sftp.file.%' AND NEW.metadata->>'outcome' = 'succeeded')
  )
) EXECUTE FUNCTION minecraft_world_file_receipt();

-- Invalidate preparation as soon as a world-changing job runs, including
-- one suspended in recovery after partial provider effects. A selection can
-- still consume its own queued preparation. Only success proves a display delta.
CREATE FUNCTION minecraft_world_job_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation server_operations%ROWTYPE;
  command jsonb;
  kind text;
  state text;
  world_name text;
  imported jsonb;
BEGIN
  IF TG_TABLE_NAME = 'managed_servers' THEN
    state := 'running';
    SELECT * INTO operation FROM server_operations WHERE job_id=NEW.active_operation_id;
  ELSE
    state := NEW.state;
    SELECT * INTO operation FROM server_operations WHERE job_id=NEW.id;
  END IF;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF operation.action IN ('provision','restore','wipe','reinstall') THEN
    PERFORM dirty_minecraft_world_index(operation.server_id);
    RETURN NEW;
  END IF;
  IF operation.action <> 'minecraft-content' THEN RETURN NEW; END IF;
  command := operation.plan #> '{minecraftContent,command}';
  kind := command->>'kind';
  IF kind IN ('modpack','modpack-upload') OR
      (kind = 'properties' AND command->'changes' ? 'level-name') THEN
    PERFORM dirty_minecraft_world_index(operation.server_id);
    RETURN NEW;
  END IF;
  IF kind IS NULL OR kind NOT IN ('world-import','world-select','world-remove') THEN
    RETURN NEW;
  END IF;
  IF kind = 'world-select' AND state = 'running' THEN RETURN NEW; END IF;
  PERFORM dirty_minecraft_world_index(operation.server_id);
  IF state <> 'succeeded' THEN RETURN NEW; END IF;
  world_name := coalesce(command->>'targetWorld',command->>'world');
  IF world_name IS NULL THEN RETURN NEW; END IF;
  IF kind = 'world-select' THEN
    UPDATE minecraft_world_indexes SET snapshot = jsonb_set(snapshot,'{selectedWorld}',to_jsonb(world_name)),
      last_file_change_at=clock_timestamp()
      WHERE server_id=operation.server_id AND snapshot IS NOT NULL
        AND local_binding=minecraft_world_local_binding(operation.server_id);
    RETURN NEW;
  END IF;
  IF kind = 'world-import' THEN
    -- Legacy or resumed imports may have no inventory receipt; success still proves the name.
    IF operation.plan #>> '{minecraftImportedWorld,name}'=world_name THEN
      imported := operation.plan->'minecraftImportedWorld';
    END IF;
    imported := coalesce(imported,jsonb_build_object('name',world_name,'status','unknown'));
  END IF;
  UPDATE minecraft_world_indexes i SET snapshot = jsonb_set(snapshot,'{worlds}',
    coalesce((SELECT jsonb_agg(entry ORDER BY position)
      FROM jsonb_array_elements(i.snapshot->'worlds') WITH ORDINALITY AS old(entry,position)
      WHERE entry->>'name' <> world_name), '[]'::jsonb)
    || CASE WHEN imported IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(imported) END),
    last_file_change_at=clock_timestamp()
    WHERE server_id=operation.server_id AND snapshot IS NOT NULL
      AND local_binding=minecraft_world_local_binding(operation.server_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER minecraft_world_job_started AFTER UPDATE OF active_operation_id ON managed_servers
FOR EACH ROW WHEN (NEW.active_operation_id IS NOT NULL AND OLD.active_operation_id IS DISTINCT FROM NEW.active_operation_id)
EXECUTE FUNCTION minecraft_world_job_receipt();
CREATE TRIGGER minecraft_world_job_receipt AFTER UPDATE OF state ON operation_jobs
FOR EACH ROW WHEN (NEW.state IN ('succeeded','failed') AND OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION minecraft_world_job_receipt();

-- A restore initiated outside the panel also has an authenticated provider receipt.
-- Its failure may leave the filesystem partially restored.
CREATE FUNCTION minecraft_world_restore_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dirty_minecraft_world_index(NEW.server_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER minecraft_world_restore_receipt AFTER INSERT ON provider_backup_events
FOR EACH ROW WHEN (NEW.type='backup.restore-completed')
EXECUTE FUNCTION minecraft_world_restore_receipt();
